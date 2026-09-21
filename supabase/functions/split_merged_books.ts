// Auto-split scanner + executor for franken-book library items.
//
// A source folder holding several books under one generic naming scheme
// ("Chapter N.mp3") merged into a single library_item overwrites same-named
// tracks and collapses dedup rows. upload-finalize now refuses such batches
// at the gate (MULTIPLE_WORKS_DETECTED), but items merged BEFORE the gate —
// or via paths that bypass finalize — still need surgery.
//
// Judgment is autonomous (self-decision) but strictly fenced:
//   1. splitDecider (pure, unit-tested) allows ONLY the corruption shape:
//      2+ non-disc subfolders with colliding basenames and >=3 tracks/group.
//      Anything else resolves to keep/review — never an autonomous write.
//   2. Z.AI (GLM) attributes a clean title/author per folder, but every
//      proposal passes a deterministic corroboration gate (shared token with
//      the folder/samples, or titlesLikelySameWork); failures fall back to
//      the prettified folder name. The LLM never writes to the DB.
//   3. Execution keeps the LARGEST group in place (stable id: progress,
//      playlists, collections, covers survive) and inserts siblings; flat
//      strays stay with the kept item — nothing is ever deleted.
//   4. Every applied split is recorded in library_item_split_audit.
//
// Usage:
//   deno run --allow-all --env-file .env.local split_merged_books.ts            # dry run (report only)
//   deno run --allow-all --env-file .env.local split_merged_books.ts --apply    # execute decided splits
//   deno run --allow-all split_merged_books.ts --apply --id <uuid>              # single item
//   deno run --allow-all split_merged_books.ts --json out.json                  # machine report
//
// The nightly workflow runs this WITHOUT --apply (report-only artifact);
// --apply is a deliberate manual dispatch.

import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Sentry } from "./_shared/sentry.ts";
import {
  decideSplit,
  deriveRelKey,
  type SplitEntry,
} from "./_shared/splitDecider.ts";
import { parseTrackDuration } from "./_shared/invariants.ts";
import {
  significantTokens,
  titlesLikelySameWork,
} from "./_shared/titleMatch.ts";
import { prettifyFilenameTitle } from "./_shared/titleAuthorParser.ts";
import { ZAI_CHAT_MODEL } from "./_shared/zai.ts";
import "https://deno.land/std@0.208.0/dotenv/load.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY")!;
const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
  Deno.env.get("ZHIPU_API_KEY") ?? "";
const supabase = createClient(supabaseUrl, key);

const args = Deno.args;
const apply = args.includes("--apply");
const idIdx = args.indexOf("--id");
const onlyId = idIdx >= 0 ? args[idIdx + 1] : null;
const idsIdx = args.indexOf("--ids");
const onlyIds = idsIdx >= 0
  ? new Set(
    args[idsIdx + 1].split(",").map((s) => s.trim()).filter(Boolean),
  )
  : null;
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

function isSelected(id: string): boolean {
  if (onlyId) return id === onlyId;
  if (onlyIds) return onlyIds.has(id);
  return true;
}

interface AudioEntry {
  raw: Record<string, unknown>;
  relKey: string;
  basename: string;
}

function entryIdentity(
  e: Record<string, unknown>,
  itemId: string,
): {
  relKey: string;
  basename: string;
} {
  const md = (e.metadata ?? {}) as Record<string, unknown>;
  // Folder truth lives in the uploaded storage path (legacy rows recorded a
  // flat relPath even when B2 keys carry subfolders). Derive first, fall back
  // to the recorded identity only when no usable path exists.
  const storedPath = String(
    md.path ?? (e as Record<string, unknown>).storage_path ??
      (e as Record<string, unknown>).path ?? "",
  );
  const derived = storedPath ? deriveRelKey(storedPath, itemId) : "";
  const relKey = derived ||
    String(md.relPath ?? md.filename ?? e.filename ?? "");
  const basename = String(
    md.filename ?? e.filename ?? relKey.split("/").pop() ?? "",
  );
  return { relKey, basename };
}

function entryDuration(e: Record<string, unknown>): number {
  return parseTrackDuration(
    e as { duration?: unknown; metadata?: { duration?: unknown } | null },
  ) ?? 0;
}

function entrySize(e: Record<string, unknown>): number {
  const md = (e.metadata ?? {}) as Record<string, unknown>;
  return Number(e.size ?? md.size ?? 0) || 0;
}

/** 2–3 capitalized words ("Deborah Weiss") — folder names that ARE authors. */
function looksLikePersonName(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((w) => /^[A-Z][a-z'’-]+$/.test(w));
}

/**
 * LLM attribution: propose a clean title/author for one folder group.
 * Deterministic corroboration gate: the proposed title must share a
 * significant token with the folder/samples or plausibly be the same work —
 * otherwise the prettified folder name wins and the LLM claim is discarded.
 */
async function attributeGroup(
  folder: string,
  sampleBasenames: string[],
  itemTitle: string,
  itemAuthor: string,
  siblingFolders: string[],
): Promise<{ title: string; author: string; source: string }> {
  const fallbackTitle = prettifyFilenameTitle(folder) || itemTitle;
  const fallbackAuthor = looksLikePersonName(folder)
    ? folder.trim()
    : itemAuthor;
  if (!zaiApiKey) {
    return { title: fallbackTitle, author: fallbackAuthor, source: "folder" };
  }

  try {
    const prompt =
      `You are an authoritative audiobook librarian. One library item titled "${itemTitle}" by "${itemAuthor}" contains a subfolder "${folder}" with files like ${
        JSON.stringify(sampleBasenames.slice(0, 5))
      }. Sibling subfolders in the same item: ${
        JSON.stringify(siblingFolders)
      }. ` +
      `Propose the TRUE book title and author for JUST this subfolder's files. ` +
      `CRITICAL RULES: 1. Different books by the same author MUST be distinguished — never return the parent item's title unless this folder really is that exact work. ` +
      `2. If the folder name embeds the title (even with "N Books in 1" bundle tags), extract it. ` +
      `3. Return ONLY a JSON object: {"title": "...", "author": "..."}`;
    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ZAI_CHAT_MODEL,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: prompt }],
          temperature: 0.0,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.ok) {
      const data = await res.json();
      const content = String(data.choices?.[0]?.message?.content || "");
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const proposedTitle = String(parsed.title || "").trim();
        const proposedAuthor = String(parsed.author || "").trim() ||
          fallbackAuthor;
        if (proposedTitle) {
          const folderTokens = new Set(
            significantTokens(`${folder} ${sampleBasenames.join(" ")}`),
          );
          const sharesToken = significantTokens(proposedTitle).some((t) =>
            folderTokens.has(t)
          );
          if (sharesToken || titlesLikelySameWork(proposedTitle, folder)) {
            return {
              title: proposedTitle,
              author: proposedAuthor,
              source: "llm",
            };
          }
          console.warn(
            `      [split] REJECTED LLM title "${proposedTitle}" for folder "${folder}": no corroboration`,
          );
        }
      }
    }
  } catch (err) {
    console.warn(
      `      [split] LLM attribution failed for "${folder}":`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return { title: fallbackTitle, author: fallbackAuthor, source: "folder" };
}

interface SplitReport {
  itemId: string;
  title: string;
  decision: string;
  reasons: string[];
  createdIds?: string[];
  keptId?: string;
}

async function main() {
  console.log(
    `✂️  split_merged_books (${apply ? "APPLY" : "DRY RUN"}) — zai:${
      zaiApiKey ? "on" : "off"
    }`,
  );

  let query = supabase.from("library_items").select(
    "id, library_id, media_type, title, author_names_first_last, path, rel_path, audio_files, library_files, size, duration",
  );
  if (onlyId) query = query.eq("id", onlyId);
  else if (onlyIds) query = query.in("id", [...onlyIds]);
  const { data: items, error } = await query;
  if (error) {
    console.error("query failed:", error.message);
    Deno.exit(1);
  }

  const reports: SplitReport[] = [];
  let kept = 0, split = 0, review = 0;

  for (const item of items ?? []) {
    if (!isSelected(item.id)) continue;
    const title = String(item.title ?? "").trim();
    const rawFiles = Array.isArray(item.audio_files) ? item.audio_files : [];
    if (!title || rawFiles.length === 0) continue;

    const analyzed: AudioEntry[] = rawFiles.map((raw: unknown) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const { relKey, basename } = entryIdentity(r, item.id);
      return { raw: r, relKey, basename };
    });
    const splitEntries: SplitEntry[] = analyzed.map((a) => ({
      relKey: a.relKey,
      basename: a.basename,
    }));
    const decision = decideSplit(splitEntries);

    if (decision.action === "keep") {
      kept++;
      continue;
    }
    if (decision.action === "review") {
      review++;
      console.log(
        `🔎 [${item.id}] "${title}": REVIEW (${decision.reasons.join("; ")})`,
      );
      reports.push({
        itemId: item.id,
        title,
        decision: "review",
        reasons: decision.reasons,
      });
      continue;
    }

    // --- action === "split": attribute each group, then (apply) execute ---
    console.log(
      `✂️  [${item.id}] "${title}": SPLIT (${decision.reasons.join("; ")})`,
    );
    const siblingFolders = decision.plan.map((p) => p.folder);
    const attributions: { title: string; author: string; source: string }[] =
      [];
    for (const group of decision.plan) {
      const samples = group.entryIndexes
        .map((i) => analyzed[i].basename)
        .filter(Boolean)
        .slice(0, 5);
      const attr = await attributeGroup(
        group.folder,
        samples,
        title,
        String(item.author_names_first_last ?? ""),
        siblingFolders.filter((f) => f !== group.folder),
      );
      console.log(
        `      "${group.folder}" (${group.trackCount}) → "${attr.title}" by ${attr.author} [${attr.source}]`,
      );
      attributions.push(attr);
    }
    const report: SplitReport = {
      itemId: item.id,
      title,
      decision: "split",
      reasons: decision.reasons,
    };

    if (!apply) {
      split++;
      reports.push(report);
      continue;
    }

    // Largest group stays in place (stable id); flat strays ride along.
    const planIdx = decision.plan
      .map((g, i) => ({ ...g, attr: attributions[i], planPos: i }))
      .sort((a, b) => b.trackCount - a.trackCount);
    const plannedIdxSets = decision.plan.map((g) => new Set(g.entryIndexes));
    const isPlanned = (i: number) => plannedIdxSets.some((s) => s.has(i));
    const keptExtra = analyzed.map((_, i) => i).filter((i) => !isPlanned(i));

    const reindexed = (indexes: number[]) =>
      indexes.map((srcIdx, pos) => ({
        ...analyzed[srcIdx].raw,
        index: pos + 1,
      }));
    const groupDuration = (indexes: number[]) =>
      Math.round(
        indexes.reduce((s, i) => s + entryDuration(analyzed[i].raw), 0),
      );
    const groupSize = (indexes: number[]) =>
      indexes.reduce((s, i) => s + entrySize(analyzed[i].raw), 0);
    const librarySubset = (indexes: number[]) => {
      const inos = new Set(
        indexes.map((i) =>
          String((analyzed[i].raw as Record<string, unknown>).ino ?? "")
        ),
      );
      const libFiles = Array.isArray(item.library_files)
        ? item.library_files
        : [];
      return (libFiles as Record<string, unknown>[]).filter((lf) =>
        inos.has(String(lf.ino ?? ""))
      );
    };

    const createdIds: string[] = [];
    for (let k = 0; k < planIdx.length; k++) {
      const g = planIdx[k];
      const indexes = k === 0
        ? [...g.entryIndexes, ...keptExtra]
        : g.entryIndexes;
      const files = reindexed(indexes);
      const payload = {
        audio_files: files as never,
        library_files: librarySubset(indexes) as never,
        duration: groupDuration(indexes),
        size: groupSize(indexes),
      };
      if (k === 0) {
        const { error: upErr } = await supabase.from("library_items")
          .update(payload).eq("id", item.id);
        if (upErr) {
          console.error(`      kept update failed: ${upErr.message}`);
          continue;
        }
        report.keptId = item.id;
        console.log(
          `      kept [${item.id}] "${title}" ← ${indexes.length} tracks`,
        );
      } else {
        const newId = crypto.randomUUID();
        const newTitle = g.attr.title || `${title} — ${g.folder}`;
        const { error: insErr } = await supabase.from("library_items").insert({
          id: newId,
          library_id: item.library_id,
          media_type: item.media_type || "book",
          media_id: newId,
          path: `${item.library_id}/${newTitle}`,
          rel_path: newTitle,
          title: newTitle,
          author_names_first_last: g.attr.author || null,
          ...payload,
          is_missing: false,
        });
        if (insErr) {
          console.error(
            `      insert failed for "${newTitle}": ${insErr.message}`,
          );
          continue;
        }
        // Link author (mirrors upload-finalize author handling).
        const authorName = String(g.attr.author || "").trim();
        if (authorName) {
          await supabase.from("authors").upsert(
            {
              id: crypto.randomUUID(),
              name: authorName,
              library_id: item.library_id,
            },
            { onConflict: "library_id, name", ignoreDuplicates: true },
          );
          const { data: existingAuthor } = await supabase.from("authors")
            .select("id")
            .eq("name", authorName).eq("library_id", item.library_id)
            .maybeSingle();
          if (existingAuthor?.id) {
            await supabase.from("book_authors").upsert(
              { library_item_id: newId, author_id: existingAuthor.id },
              {
                onConflict: "library_item_id, author_id",
                ignoreDuplicates: true,
              },
            );
          }
        }
        await supabase.from("library_item_split_audit").insert({
          source_item_id: item.id,
          created_item_id: newId,
          folder: g.folder,
          track_count: indexes.length,
          decided_by: g.attr.source,
        });
        createdIds.push(newId);
        console.log(
          `      + [${newId}] "${newTitle}" ← ${indexes.length} tracks`,
        );
      }
    }
    report.createdIds = createdIds;
    reports.push(report);
    split++;
  }

  console.log(`\nkept=${kept} split=${split} review=${review}`);
  if (!apply && split > 0) console.log("(dry run — pass --apply to execute)");
  if (jsonOut) {
    await Deno.writeTextFile(jsonOut, JSON.stringify(reports, null, 2));
    console.log(`📄 report written to ${jsonOut}`);
  }
}

main().catch(async (err) => {
  console.error(
    "❌ Fatal error:",
    err instanceof Error ? err.message : String(err),
  );
  Sentry.captureException(err);
  await Sentry.flush(2000);
  Deno.exit(1);
});
