import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { requireAdminRole } from "../_shared/auth.ts";
import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import { getStorageQuotaSnapshot } from "../../_shared/storage-quota.ts";
import {
  filterPlausibleFolders,
  findBestDeterministicMatch,
  getFolderSummaries,
  matchStorageFolderWithAI,
  refreshStorageIndex,
} from "../../_shared/intelligentStorageResolver.ts";
import { StorageRouter, tierToPrefix } from "../../_shared/storage-router.ts";
import {
  MAX_ITEM_DURATION_S,
  parseTrackDuration,
} from "../../_shared/invariants.ts";

export const adminRouter = createOpenApiRouter();

/**
 * Model calls allowed per reconcile-storage invocation, and the hard ceiling a
 * caller may request. See the budget block in the handler for why this exists:
 * unbounded AI escalation inside a loop over the whole library reliably
 * exceeded the edge function's resource limit.
 */
const DEFAULT_AI_BUDGET = 8;
const MAX_AI_BUDGET = 25;

const ForbiddenSchema = z.object({ error: z.string() });
const ServerErrorSchema = z.object({ error: z.string() });
const AnalyticsSchema = z.object({
  totalUsers: z.number(),
  totalLibraries: z.number(),
  totalItems: z.number(),
  activeSessions: z.number(),
});

const analyticsRoute = {
  method: "get" as const,
  path: "/",
  tags: ["admin"],
  responses: {
    200: {
      description: "Server analytics overview",
      content: { "application/json": { schema: AnalyticsSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Query failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

adminRouter.openapi(analyticsRoute, async (c) => {
  const user = c.get("user");
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  try {
    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

    // Count users
    const { count: totalUsers } = await adminSupabase
      .from("profiles")
      .select("*", { count: "exact", head: true });

    // Count libraries
    const { count: totalLibraries } = await adminSupabase
      .from("libraries")
      .select("*", { count: "exact", head: true });

    // Count library items by media type (books/podcasts tables do not exist)
    const { count: totalBooks } = await adminSupabase
      .from("library_items")
      .select("*", { count: "exact", head: true })
      .eq("media_type", "book");
    const { count: totalPodcasts } = await adminSupabase
      .from("library_items")
      .select("*", { count: "exact", head: true })
      .eq("media_type", "podcast");

    const totalItems = (totalBooks || 0) + (totalPodcasts || 0);

    return c.json({
      totalUsers: totalUsers || 0,
      totalLibraries: totalLibraries || 0,
      totalItems: totalItems || 0,
      activeSessions: 1,
    }, 200);
  } catch (err) {
    console.error("[admin-analytics] Error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

const storageHealthRoute = {
  method: "get" as const,
  path: "/storage-health",
  tags: ["admin"],
  responses: {
    200: {
      description: "Storage quota + bucket breakdown",
      content: { "application/json": { schema: z.record(z.any()) } },
    },
    403: {
      description: "Admin required",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    500: {
      description: "Server error",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
};

adminRouter.openapi(storageHealthRoute, async (c) => {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabase = c.get("supabase") as any;
  try {
    const quota = await getStorageQuotaSnapshot(supabase);
    // Also try DB snapshot RPC for pretty per-bucket
    let buckets: any = null;
    try {
      const { data } = await supabase.rpc("storage_quota_snapshot");
      if (Array.isArray(data)) buckets = data;
    } catch { /* RPC may not exist locally */ }
    return c.json({
      quota,
      buckets,
      freePlanBytes: 1073741824,
      proPlanBytes: 107374182400,
      graceUntil: "2026-09-29",
      isOverQuota: quota.isOver,
      alert: quota.isOver
        ? "OVER QUOTA – prune Supabase audio-files or upgrade to Pro via server_settings.storage_quota_bytes"
        : quota.isWarn
        ? "WARN at 80%"
        : "ok",
      hint:
        "Audio must go to B2 (presigned S3). Only covers (13 MB) should live in Supabase. Use POST /api/storage-sync?action=prune to GC orphans, or scripts/migrate_supabase_audio_to_b2.ts then prune.",
    }, 200);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

const reconcileStorageRoute = {
  method: "post" as const,
  path: "/reconcile-storage",
  tags: ["admin"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            dryRun: z.boolean().optional(),
            cleanTestData: z.boolean().optional(),
            libraryId: z.string().optional(),
            /**
             * Max model calls for the AI matching stage. Capped server-side
             * (see MAX_AI_BUDGET) so a caller cannot request an unbounded run
             * and trip the edge function's resource limit.
             */
            aiBudget: z.number().int().min(0).max(MAX_AI_BUDGET).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Storage reconciliation summary",
      content: { "application/json": { schema: z.record(z.any()) } },
    },
    403: {
      description: "Admin required",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    500: {
      description: "Server error",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
};

adminRouter.openapi(reconcileStorageRoute, async (c) => {
  if (!requireAdminRole(c.get("user"))) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const dryRun = Boolean(body.dryRun);
    const cleanTestData = Boolean(body.cleanTestData);
    const libraryId = body.libraryId as string | undefined;

    const supabaseUrl = c.get("supabaseUrl");
    const serviceRoleKey = c.get("serviceRoleKey");
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
    const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
      Deno.env.get("ZHIPU_API_KEY") ?? "";

    // 1. Index all B2 storage tiers
    const index = await refreshStorageIndex(true);
    const availableFolders = getFolderSummaries(index);

    // 2. Fetch books
    let query = adminSupabase
      .from("library_items")
      .select(
        "id, title, author_names_first_last, rel_path, path, audio_files, is_missing, duration",
      )
      .not("title", "like", "PW %");

    if (libraryId) {
      query = query.eq("library_id", libraryId);
    }

    const { data: books, error: fetchErr } = await query;
    if (fetchErr || !books) {
      return c.json({
        error: `Failed to query library items: ${fetchErr?.message}`,
      }, 500);
    }

    const reconciled: Array<
      {
        id: string;
        title: string;
        prefix: string;
        tier: string;
        method: string;
        tracks: number;
      }
    > = [];
    const missing: Array<{ id: string; title: string; tracks: number }> = [];
    const alreadyValid: Array<{ id: string; title: string }> = [];
    const durationHealed: Array<
      { id: string; title: string; oldDuration: number; newDuration: number }
    > = [];

    // 10x pro: duration ground truth lives in audio_files, not the item cell.
    // Whenever the stored total drifts >1s from SUM(tracks), heal it here so
    // reconcile-storage also repairs Dark Psychology-class 78h lies.
    const healDurationIfDrifted = async (
      book: any,
      files: any[],
    ): Promise<void> => {
      const sum = files.reduce(
        (s: number, f: any) => s + (parseTrackDuration(f) ?? 0),
        0,
      );
      if (!(sum > 0) || sum > MAX_ITEM_DURATION_S) return;
      const rounded = Math.round(sum);
      const stored = Number(book.duration) || 0;
      if (stored === 0 || Math.abs(stored - rounded) <= 1) return;
      durationHealed.push({
        id: book.id,
        title: book.title || "Untitled",
        oldDuration: stored,
        newDuration: rounded,
      });
      if (!dryRun) {
        await adminSupabase.from("library_items").update({ duration: rounded })
          .eq("id", book.id);
      }
    };

    const router = new StorageRouter(adminSupabase);

    const claimedPrefixes = new Set<string>();

    // ── Model-call budget ────────────────────────────────────────────────────
    // One edge invocation has a hard wall-clock/CPU ceiling. The AI stage is the
    // only unbounded cost in this loop, so it gets an explicit allowance. The
    // default is deliberately small: the deterministic stages plus the
    // plausibility gate recover everything recoverable cheaply, and anything
    // left is reported in `aiSkipped` so a follow-up run can continue rather
    // than the whole job dying.
    const aiBudget = Math.max(
      0,
      Math.min(
        typeof body.aiBudget === "number" ? body.aiBudget : DEFAULT_AI_BUDGET,
        MAX_AI_BUDGET,
      ),
    );
    let aiCallsUsed = 0;
    const aiSkipped: Array<{ id: string; title: string }> = [];
    const aiBudgetExhausted = () => aiCallsUsed >= aiBudget;
    const spendAiBudget = async <T>(fn: () => Promise<T>): Promise<T> => {
      aiCallsUsed++;
      return await fn();
    };

    for (const book of books) {
      const rawAudioFiles = Array.isArray(book.audio_files)
        ? book.audio_files
        : [];
      if (!rawAudioFiles.length) {
        missing.push({
          id: book.id,
          title: book.title || "Untitled",
          tracks: 0,
        });
        if (!dryRun && !book.is_missing) {
          await adminSupabase.from("library_items").update({ is_missing: true })
            .eq("id", book.id);
        }
        continue;
      }

      // 1. Verify if book's current audio path is already valid in B2
      const firstAf = rawAudioFiles[0];
      const existingPath = String(
        firstAf?.metadata?.path || firstAf?.storage_path || "",
      );
      const parsedExisting = existingPath
        ? router.parsePath(existingPath)
        : null;
      if (parsedExisting && parsedExisting.tier !== "SUPABASE") {
        const foundEntry = index.find(
          (e) => e.tier === parsedExisting.tier && e.key === parsedExisting.key,
        );
        if (foundEntry) {
          if (foundEntry.prefix) {
            claimedPrefixes.add(`${foundEntry.tier}:::${foundEntry.prefix}`);
          }
          if (!dryRun && book.is_missing) {
            await adminSupabase
              .from("library_items")
              .update({ is_missing: false })
              .eq("id", book.id);
          }
          await healDurationIfDrifted(book, rawAudioFiles);
          alreadyValid.push({ id: book.id, title: book.title || "Untitled" });
          continue;
        }
      }

      // 2. Check if first track's filename matches in B2
      const candidateFilenames = rawAudioFiles.map((af: any) =>
        af.metadata?.filename || af.metadata?.relPath || af.filename || ""
      ).filter(Boolean);

      let matchedEntry = null;
      for (const fn of candidateFilenames) {
        matchedEntry = findBestDeterministicMatch(fn, index);
        if (matchedEntry) break;
      }

      let matchedMethod = "deterministic";

      // 3. Exact track list signature matching for unreferenced, unclaimed folders
      if (!matchedEntry) {
        const normPunct = (s: string) =>
          s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const trackFilenames = new Set(
          rawAudioFiles.map((af: any) =>
            normPunct(
              String(
                af?.metadata?.filename || af?.filename ||
                  af?.metadata?.relPath ||
                  "",
              ),
            )
          ).filter((s) => s.length > 0),
        );
        const candidateFolders = availableFolders.filter((f) =>
          f.fileCount === rawAudioFiles.length &&
          !claimedPrefixes.has(`${f.tier}:::${f.prefix}`)
        );
        for (const cf of candidateFolders) {
          const filesInFolder = index.filter((e) =>
            e.tier === cf.tier && e.prefix === cf.prefix
          );
          const matchingCount = filesInFolder.filter((f) =>
            trackFilenames.has(normPunct(f.filename))
          ).length;
          if (
            matchingCount === rawAudioFiles.length && rawAudioFiles.length > 0
          ) {
            matchedEntry = filesInFolder[0] || null;
            matchedMethod = "track_signature_match";
            break;
          }
        }
      }

      // 4. If deterministic failed, invoke AI semantic matcher.
      //
      // Budgeted on three levels, because the nightly reconcile runs every
      // unmatched book through this path in a single edge invocation:
      //   1. a hard cap on total model calls per run, so the function cannot
      //      outrun its worker budget no matter how large the library is;
      //   2. a local arithmetic gate (file count within tolerance of the
      //      book's track count) that eliminates folders a match is
      //      impossible for -- no network cost at all;
      //   3. a per-book try/catch, so one model timeout degrades to a skip
      //      instead of aborting the whole reconciliation.
      //
      // Without (1) and (2) this endpoint made ~73 sequential LLM calls per
      // run and returned HTTP 546 WORKER_RESOURCE_LIMIT, so the nightly
      // storage index was never actually reconciled.
      if (!matchedEntry && zaiApiKey) {
        if (aiBudgetExhausted()) {
          aiSkipped.push({ id: book.id, title: book.title || "Untitled" });
        } else {
          // Local plausibility gate first: a book with 343 tracks cannot be in
          // a 9-file folder, so don't spend a model call discovering that.
          const plausiblySized = filterPlausibleFolders(
            availableFolders,
            rawAudioFiles.length,
          );
          const unclaimedPlausible = plausiblySized.filter(
            (f) => !claimedPrefixes.has(`${f.tier}:::${f.prefix}`),
          );
          if (unclaimedPlausible.length > 0) {
            try {
              const aiFolder = await spendAiBudget(() =>
                matchStorageFolderWithAI(
                  book.title || "",
                  book.author_names_first_last || "",
                  candidateFilenames,
                  unclaimedPlausible,
                  zaiApiKey,
                )
              );
              if (aiFolder) {
                const inFolder = index.filter((e) =>
                  e.tier === aiFolder.tier && e.prefix === aiFolder.prefix
                );
                matchedEntry = inFolder[0] || null;
                matchedMethod = "ai_semantic";
              }
            } catch (aiErr) {
              // One unreachable/timing-out model must not lose the other 99
              // books' reconciliation work.
              console.warn(
                `[admin-reconcile-storage] AI match failed for "${book.title}":`,
                aiErr,
              );
            }
          }
        }
      }

      if (matchedEntry) {
        claimedPrefixes.add(`${matchedEntry.tier}:::${matchedEntry.prefix}`);
        const prefixStr = matchedEntry.prefix ? `${matchedEntry.prefix}/` : "";
        const winningPrefix = `${tierToPrefix(matchedEntry.tier)}${prefixStr}`;

        // Check if book audio_files already points to this canonical prefix
        const firstAf = rawAudioFiles[0];
        const existingPath = String(
          firstAf.metadata?.path || firstAf.storage_path || "",
        );
        if (existingPath.startsWith(winningPrefix)) {
          alreadyValid.push({ id: book.id, title: book.title || "Untitled" });
          continue;
        }

        // Prepare updated audio_files with canonical paths and physical filenames
        const inFolder = index.filter(
          (e) =>
            e.tier === matchedEntry.tier && e.prefix === matchedEntry.prefix,
        );
        const updatedAudioFiles = rawAudioFiles.map((af: any, idx: number) => {
          const afMeta = (af.metadata as Record<string, unknown>) || {};
          const fname = String(
            afMeta.filename || af.filename || afMeta.relPath || "",
          ).split("/").pop() || "";
          const normFname = fname.toLowerCase().replace(/[^a-z0-9]/g, "");

          const physicalFile = inFolder.find((e) => e.filename === fname) ||
            inFolder.find(
              (e) => e.filename.toLowerCase() === fname.toLowerCase(),
            ) ||
            (normFname.length >= 6
              ? inFolder.find(
                (e) =>
                  e.filename.toLowerCase().replace(/[^a-z0-9]/g, "") ===
                    normFname,
              )
              : null) ||
            inFolder[idx];

          const physicalName = physicalFile ? physicalFile.filename : fname;
          const canonical = `${winningPrefix}${physicalName}`;
          return {
            ...af,
            storage_path: canonical,
            metadata: {
              ...afMeta,
              path: canonical,
              filename: physicalName,
              ...(physicalFile?.size ? { size: physicalFile.size } : {}),
            },
          };
        });

        if (!dryRun) {
          const durationSum = updatedAudioFiles.reduce(
            (s: number, f: any) => s + (parseTrackDuration(f) ?? 0),
            0,
          );
          const patch: Record<string, unknown> = {
            audio_files: updatedAudioFiles,
            is_missing: false,
          };
          if (
            durationSum > 0 && durationSum <= MAX_ITEM_DURATION_S &&
            Math.abs(
                Number((book as any).duration || 0) - Math.round(durationSum),
              ) > 1
          ) {
            patch.duration = Math.round(durationSum);
            durationHealed.push({
              id: book.id,
              title: book.title || "Untitled",
              oldDuration: Number((book as any).duration) || 0,
              newDuration: Math.round(durationSum),
            });
          }
          await adminSupabase.from("library_items").update(patch).eq(
            "id",
            book.id,
          );
        } else {
          await healDurationIfDrifted(book, rawAudioFiles);
        }

        reconciled.push({
          id: book.id,
          title: book.title || "Untitled",
          prefix: winningPrefix,
          tier: matchedEntry.tier,
          method: matchedMethod,
          tracks: rawAudioFiles.length,
        });
      } else {
        missing.push({
          id: book.id,
          title: book.title || "Untitled",
          tracks: rawAudioFiles.length,
        });
        if (!dryRun && !book.is_missing) {
          await adminSupabase.from("library_items").update({ is_missing: true })
            .eq("id", book.id);
        }
      }
    }

    let cleanedTestCount = 0;
    if (cleanTestData && !dryRun) {
      const { data: pwItems } = await adminSupabase
        .from("library_items")
        .select("id")
        .or("title.like.PW %,title.like.%Fixture%");
      const ids = pwItems?.map((i: any) => i.id) || [];
      if (ids.length > 0) {
        await adminSupabase.from("media_progress").delete().in(
          "library_item_id",
          ids,
        );
        await adminSupabase.from("book_authors").delete().in(
          "library_item_id",
          ids,
        );
        await adminSupabase.from("book_series").delete().in(
          "library_item_id",
          ids,
        );
        await adminSupabase.from("collection_items").delete().in(
          "library_item_id",
          ids,
        );
        const { data: deletedItems } = await adminSupabase
          .from("library_items")
          .delete()
          .in("id", ids)
          .select("id");
        cleanedTestCount = deletedItems?.length || 0;
      }
    }

    return c.json({
      dryRun,
      totalScanned: books.length,
      alreadyValidCount: alreadyValid.length,
      reconciledCount: reconciled.length,
      missingCount: missing.length,
      cleanedTestItemsCount: cleanedTestCount,
      durationHealedCount: durationHealed.length,
      durationHealed,
      reconciled,
      missing,
      // Surfaced so the operator can see that a green run is a *complete* run.
      // Without this, exhausting the model budget looked identical to having
      // nothing left to match, which is how the previous nightly failure went
      // unnoticed as "reconciled fine".
      aiBudget,
      aiCallsUsed,
      aiSkippedCount: aiSkipped.length,
      aiSkipped: aiSkipped.slice(0, 25),
    }, 200);
  } catch (err: any) {
    console.error("[admin-reconcile-storage] Error:", err);
    return c.json({ error: err?.message || "Internal Server Error" }, 500);
  }
});
