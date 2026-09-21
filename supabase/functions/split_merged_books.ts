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
import { applySplitPlan } from "./_shared/splitApply.ts";
import {
  decideSplit,
  deriveRelKey,
  type SplitEntry,
} from "./_shared/splitDecider.ts";
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
    // applySplitPlan writes siblings FIRST and shrinks the kept item LAST so
    // a mid-split failure strands nothing: the source row stays whole.
    const planIdx = decision.plan
      .map((g, i) => ({ ...g, attr: attributions[i] }))
      .sort((a, b) => b.trackCount - a.trackCount);
    const plannedIdxSets = decision.plan.map((g) => new Set(g.entryIndexes));
    const isPlanned = (i: number) => plannedIdxSets.some((s) => s.has(i));
    const keptExtra = analyzed.map((_, i) => i).filter((i) => !isPlanned(i));

    const outcome = await applySplitPlan(
      supabase,
      item,
      analyzed.map((a) => ({ raw: a.raw })),
      planIdx,
      keptExtra,
    );
    if (!outcome.applied) {
      console.error(`      FAILED [${item.id}]: ${outcome.error}`);
      reports.push({
        ...report,
        decision: "split_failed",
        reasons: [...report.reasons, String(outcome.error)],
        createdIds: outcome.createdIds,
      });
      continue;
    }
    report.keptId = outcome.keptId;
    report.createdIds = outcome.createdIds;
    for (const [pos, id] of outcome.createdIds.entries()) {
      const g = planIdx[pos + 1];
      console.log(
        `      + [${id}] "${
          g.attr.title || `${title} — ${g.folder}`
        }" ← ${g.entryIndexes.length} tracks`,
      );
    }
    console.log(
      `      kept [${item.id}] "${title}" ← ${
        planIdx[0].entryIndexes.length + keptExtra.length
      } tracks`,
    );
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
