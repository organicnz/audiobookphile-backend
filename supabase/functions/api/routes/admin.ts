import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { requireAdminRole } from "../_shared/auth.ts";
import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import { getStorageQuotaSnapshot } from "../../_shared/storage-quota.ts";
import {
  findBestDeterministicMatch,
  getFolderSummaries,
  matchStorageFolderWithAI,
  refreshStorageIndex,
} from "../../_shared/intelligentStorageResolver.ts";
import { tierToPrefix } from "../../_shared/storage-router.ts";

export const adminRouter = createOpenApiRouter();

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
        "id, title, author_names_first_last, rel_path, path, audio_files, is_missing",
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

      // Check if first track's filename matches in B2
      const candidateFilenames = rawAudioFiles.map((af: any) =>
        af.metadata?.filename || af.metadata?.relPath || af.filename || ""
      ).filter(Boolean);

      let matchedEntry = null;
      for (const fn of candidateFilenames) {
        matchedEntry = findBestDeterministicMatch(fn, index);
        if (matchedEntry) break;
      }

      let matchedMethod = "deterministic";

      // If deterministic failed, invoke AI semantic matcher
      if (!matchedEntry && zaiApiKey) {
        const aiFolder = await matchStorageFolderWithAI(
          book.title || "",
          book.author_names_first_last || "",
          candidateFilenames,
          availableFolders,
          zaiApiKey,
        );
        if (aiFolder) {
          const inFolder = index.filter((e) =>
            e.tier === aiFolder.tier && e.prefix === aiFolder.prefix
          );
          matchedEntry = inFolder[0] || null;
          matchedMethod = "ai_semantic";
        }
      }

      if (matchedEntry) {
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

        // Prepare updated audio_files with canonical paths
        const updatedAudioFiles = rawAudioFiles.map((af: any) => {
          const afMeta = (af.metadata as Record<string, unknown>) || {};
          const fname = String(
            afMeta.filename || af.filename || afMeta.relPath || "",
          ).split("/").pop();
          const canonical = `${winningPrefix}${fname}`;
          return {
            ...af,
            storage_path: canonical,
            metadata: {
              ...afMeta,
              path: canonical,
            },
          };
        });

        if (!dryRun) {
          await adminSupabase.from("library_items").update({
            audio_files: updatedAudioFiles,
            is_missing: false,
          }).eq("id", book.id);
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
      reconciled,
      missing,
    }, 200);
  } catch (err: any) {
    console.error("[admin-reconcile-storage] Error:", err);
    return c.json({ error: err?.message || "Internal Server Error" }, 500);
  }
});
