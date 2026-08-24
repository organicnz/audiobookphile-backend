// Repair corrupted library_items metadata detected by detect_merged_books.ts.
//
// Strategy (deterministic-first, LLM never re-identifies):
//   1. Derive the true title from the longest common token-cluster across
//      track filenames (e.g. "Deep Work Rules ... - 001..008" -> "Deep Work
//      Rules for Focused Success in a Distracted World").
//   2. Scrub display garbage from titles: torrent/URL prefixes, glued years,
//      bracketed junk.
//   3. Gate every proposal through titlesLikelySameWork so we never merge
//      distinct works.
//   4. For every retitled item, fetch an accurate cover via
//      _shared/coverFetch (iTunes/OpenLibrary/GoogleBooks) and upload it.
//
// Usage:
//   deno run --allow-all --env-file .env.local repair_metadata.ts           # dry run
//   deno run --allow-all --env-file .env.local repair_metadata.ts --apply   # write
//   deno run --allow-all repair_metadata.ts --apply --id <uuid>             # single item

import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import {
  significantTokens,
  titlesLikelySameWork,
} from "./_shared/titleMatch.ts";
import { prettifyFilenameTitle } from "./_shared/titleAuthorParser.ts";
import { fetchBookMetadata } from "./_shared/coverFetch.ts";
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

const AUDIO_EXT = /\.(mp3|m4b|m4a|aac|ogg|oga|flac|wav|webm)$/i;

function entryFilename(entry: unknown): string {
  const e = (entry ?? {}) as Record<string, unknown>;
  const metadata = (e.metadata ?? {}) as Record<string, unknown>;
  const raw = String(
    e.filename ?? metadata.filename ?? e.name ?? e.path ??
      metadata.relPath ?? e.storage_path ?? "",
  );
  return raw.split("/").pop() ?? raw;
}

/** Remove numbering/disc markers so clustered filenames become comparable. */
function stripTrackNumbering(name: string): string {
  let s = name.replace(AUDIO_EXT, "").trim();
  s = s.replace(/^\[?\d{1,3}(-\d{1,3})?\]?[\s._-]+/, ""); // [01-22] name | 001 name
  s = s.replace(
    /^(cd|disc|disk|part|pt|track|ch(apter)?)\s*\d+\s*[-_.]?\s*/i,
    "",
  );
  s = s.replace(/\s*[-_.]?\s*\d{1,4}\s*$/, ""); // trailing " - 007"
  s = s.replace(/\s*-\s*Copy$/i, "");
  s = s.replace(/[_]+/g, " ");
  return s.trim();
}

const CLUSTER_NOISE =
  /^(ch|chapter|chap|disc|cd|disk|part|pt|track|book|file|section|introduction|preface|epilogue)$/;

/** Longest common token cluster across >=70% of the track files. */
function dominantCluster(names: string[]): string | null {
  if (names.length < 3) return null;
  const counts = new Map<string, number>();
  for (const name of names) {
    for (const t of new Set(significantTokens(name))) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const threshold = Math.ceil(names.length * 0.7);
  const cluster = [...counts.entries()]
    .filter(([t, c]) =>
      c >= threshold && !CLUSTER_NOISE.test(t) && t.length >= 2
    )
    .map(([t]) => t);
  if (cluster.length === 0) return null;
  // Re-order cluster tokens by their earliest typical position for readability.
  const pos = new Map<string, number>();
  for (const name of names) {
    significantTokens(name).forEach((t, i) => {
      if (cluster.includes(t)) pos.set(t, Math.min(pos.get(t) ?? 1e9, i));
    });
  }
  cluster.sort((a, b) => (pos.get(a) ?? 999) - (pos.get(b) ?? 999));
  return cluster.join(" ");
}

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function smartTitleCase(s: string): string {
  return s.split(" ").map((w, i) =>
    i > 0 && SMALL_WORDS.has(w.toLowerCase())
      ? w.toLowerCase()
      : w.charAt(0).toUpperCase() + w.slice(1)
  ).join(" ");
}

function looksLikeGarbage(title: string): boolean {
  const t = title.toLowerCase();
  if (/^www\.|\.org$|\.com$|torrent|demonoid/.test(t)) return true;
  if (/^\d{4}\b/.test(t.trim())) return true; // "2011 (unabridged) ..."
  return false;
}

function scrubDisplayTitle(title: string): string {
  let s = title.trim();
  s = s.replace(/^www\.[^\s]+\s*/, "");
  s = s.replace(/\s*[\(\[]?\d{4}[\)\]]?\s*$/, ""); // trailing "(1520)" / "1990 г."
  s = s.replace(/\s*-\s*Collectors edition\s*$/i, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

interface Repair {
  itemId: string;
  oldTitle: string;
  newTitle: string;
  reason: string;
}

async function repairCover(itemId: string, title: string, author: string) {
  const res = await fetchBookMetadata(title, author);
  if (!res?.cover) {
    console.log(`      cover: none found for "${title}"`);
    return false;
  }
  const fileData = new Uint8Array(res.cover.buffer);
  const ext = res.cover.extension || "jpg";
  const coverPath = `${itemId}/cover.${ext}`;
  const contentType = `image/${ext === "png" ? "png" : "jpeg"}`;
  const { error: upErr } = await supabase.storage.from("covers").upload(
    coverPath,
    fileData,
    { upsert: true, contentType },
  );
  if (upErr && !upErr.message.includes("exists")) {
    console.log(`      cover upload failed: ${upErr.message}`);
    return false;
  }
  const { error: dbErr } = await supabase.from("library_items")
    .update({ cover_path: coverPath }).eq("id", itemId);
  if (dbErr) {
    console.log(`      cover_path update failed: ${dbErr.message}`);
    return false;
  }
  console.log(`      cover: uploaded ${coverPath}`);
  return true;
}

async function main() {
  console.log(
    `🛠  repair_metadata (${apply ? "APPLY" : "DRY RUN"}) — zai:${
      zaiApiKey ? "on" : "off"
    }`,
  );

  const { data: items, error } = await supabase.from("library_items")
    .select(
      "id, title, author_names_first_last, cover_path, audio_files, library_files",
    );
  if (error) {
    console.error("query failed:", error.message);
    Deno.exit(1);
  }

  const repairs: Repair[] = [];

  for (const item of items ?? []) {
    if (onlyId && item.id !== onlyId) continue;
    const title = String(item.title ?? "").trim();
    const entries: unknown[] = [
      ...((item.audio_files as unknown[]) ?? []),
      ...((item.library_files as unknown[]) ?? []),
    ];
    if (!title) continue;

    const audioNames = entries.map(entryFilename).filter((n) =>
      AUDIO_EXT.test(n)
    );
    // Cluster on ALL files (not deduped): identical-after-strip names are
    // themselves the strongest cluster signal ("Steve Jobs - 01..08").
    const stripped = audioNames.map(stripTrackNumbering).filter(Boolean);
    const author = String(item.author_names_first_last ?? "").trim();

    let newTitle: string | null = null;
    let reason = "";

    // 1. Cluster-derived rename — ONLY when the current title is garbage,
    //    is just the author's name, or the cluster strictly contains the
    //    current title (adds information, never loses it).
    const cluster = dominantCluster(stripped);
    if (cluster && cluster.length >= 8) {
      const curTokens = significantTokens(title);
      const clusterTokens = cluster.split(" ");
      const curIsGarbage = looksLikeGarbage(title);
      const authorAsTitle = author.length > 0 &&
        titlesLikelySameWork(title, author);
      const addsInfo = curTokens.length > 0 &&
        curTokens.every((t) => clusterTokens.includes(t)) &&
        clusterTokens.length > curTokens.length;
      if (
        !titlesLikelySameWork(title, cluster) &&
        (curIsGarbage || authorAsTitle || addsInfo)
      ) {
        newTitle = smartTitleCase(prettifyFilenameTitle(cluster));
        reason = `track-cluster "${cluster}" (${
          curIsGarbage
            ? "garbage"
            : authorAsTitle
            ? "author-as-title"
            : "adds-info"
        })`;
      }
    }

    // 2. Garbage-title scrub even without a usable cluster.
    if (!newTitle && (looksLikeGarbage(title))) {
      const scrubbed = scrubDisplayTitle(title);
      if (scrubbed.length >= 3 && scrubbed !== title) {
        newTitle = scrubbed;
        reason = "garbage scrub";
      }
    }

    // 3. Trailing-year scrub for otherwise-fine titles ("Art of War (1520)").
    if (!newTitle) {
      const scrubbed = scrubDisplayTitle(title);
      if (
        scrubbed.length >= 3 && scrubbed !== title &&
        titlesLikelySameWork(scrubbed, title)
      ) {
        newTitle = scrubbed;
        reason = "year scrub";
      }
    }

    if (newTitle && newTitle !== title) {
      repairs.push({ itemId: item.id, oldTitle: title, newTitle, reason });
    }
  }

  console.log(`\nProposed repairs: ${repairs.length}`);
  for (const r of repairs) {
    console.log(`  • [${r.itemId}] "${r.oldTitle}"`);
    console.log(`      → "${r.newTitle}"  (${r.reason})`);
  }
  if (!apply) {
    console.log("\n(dry run — pass --apply to write)");
    return;
  }

  for (const r of repairs) {
    console.log(`\n✍️  applying [${r.itemId}]`);
    const { error: upErr } = await supabase.from("library_items")
      .update({ title: r.newTitle }).eq("id", r.itemId);
    if (upErr) {
      console.log(`      title update failed: ${upErr.message}`);
      continue;
    }
    const { data: fresh } = await supabase.from("library_items")
      .select("author_names_first_last, cover_path").eq("id", r.itemId)
      .maybeSingle();
    const author = String(fresh?.author_names_first_last ?? "");
    // Always refetch: identity changed, so the old cover may be wrong.
    await repairCover(r.itemId, r.newTitle, author);
  }
  console.log(`\n✅ applied ${repairs.length} repairs`);
}

main();
