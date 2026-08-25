/**
 * Corrupted-library detector: flags library items whose audio track filenames
 * do not plausibly belong to the item's title.
 *
 * Background: before commit ee21f95, glm-4-flash could merge distinct books by
 * the same author (e.g. Sapiens' audio into the Homo Deus record). This scan
 * surfaces suspected merges so they can be split and re-uploaded.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... deno run --allow-all detect_merged_books.ts [--json out.json]
 *
 * Read-only. Uses SUPABASE_SERVICE_ROLE_KEY if present, else SUPABASE_ANON_KEY
 * (which may be blocked by RLS).
 */

import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import {
  significantTokens,
  titlesLikelySameWork,
} from "./_shared/titleMatch.ts";
import "https://deno.land/std@0.208.0/dotenv/load.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY")!;
const usingServiceRole = Boolean(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const supabase = createClient(supabaseUrl, key);

const jsonOutIdx = Deno.args.indexOf("--json");
const jsonOutPath = jsonOutIdx >= 0 ? Deno.args[jsonOutIdx + 1] : null;

/** Extract a comparable base filename from the many historical entry shapes. */
function entryFilename(entry: unknown): string {
  const e = (entry ?? {}) as Record<string, unknown>;
  const metadata = (e.metadata ?? {}) as Record<string, unknown>;
  const raw = String(
    e.filename ?? metadata.filename ?? e.name ?? e.path ??
      metadata.relPath ?? e.storage_path ?? "",
  );
  // Keep only the final path segment, strip extension.
  const base = raw.split("/").pop() ?? raw;
  return base.replace(/\.(mp3|m4b|m4a|aac|ogg|oga|flac|wav|webm)$/i, "");
}

/** Generic names ("Chapter 03", "Track 12", "001.mp3") carry no identity signal. */
function isGenericTrackName(name: string): boolean {
  const cleaned = normalizeTitleForMatchLite(name);
  if (/^\d+$/.test(cleaned)) return true;
  return /^(chapter|chap|ch|track|part|pt|section|section\d*|disc|cd|disk|file|book)\s*[-_. ]?\d*(\s*(of|\/)\s*\d+)?$/
    .test(cleaned);
}

function normalizeTitleForMatchLite(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(
    /\s+/g,
    " ",
  ).trim();
}

/** Initials of raw title words: "When The Body Says No" → WTBSN. */
function titleInitials(title: string): string {
  const words = title.split(/[^\p{L}]+/u).filter((w) => w.length > 0);
  if (words.length < 2) return "";
  return words.map((w) => w[0].toUpperCase()).join("");
}

/** Tracks named with the title's acronym (WTBSN) are verified, not suspect. */
function matchesTitleAcronym(title: string, names: string[]): boolean {
  const initials = titleInitials(title);
  if (initials.length < 3) return false;
  return names.some((n) =>
    (n.match(/\b[A-Z]{2,}\b/g) ?? []).some(
      (c) => c.length >= 3 && initials.startsWith(c),
    )
  );
}

interface Finding {
  itemId: string;
  title: string;
  kind:
    | "NO_AUDIO_TRACKS"
    | "SUSPECT_MERGED"
    | "UNVERIFIABLE_GENERIC_NAMES";
  evidence: string[];
}

const AUDIO_EXT = /\.(mp3|m4b|m4a|aac|ogg|oga|flac|wav|webm)$/i;

/** Whether the raw entry (pre-extension-stripping) points at a playable audio file. */
function hasAudioExtension(entry: unknown): boolean {
  const e = (entry ?? {}) as Record<string, unknown>;
  const metadata = (e.metadata ?? {}) as Record<string, unknown>;
  const raw = String(
    e.filename ?? metadata.filename ?? e.name ?? e.path ??
      metadata.relPath ?? e.storage_path ?? "",
  );
  return AUDIO_EXT.test(raw);
}

async function main() {
  console.log(
    `🔍 Scanning library_items (${
      usingServiceRole ? "service role" : "anon key"
    })…`,
  );

  const { data: items, error } = await supabase
    .from("library_items")
    .select("id, title, media_type, audio_files, library_files");

  if (error) {
    console.error(`❌ Query failed: ${error.message}`);
    if (!usingServiceRole) {
      console.error(
        "   Anon key may be blocked by RLS. Re-run with SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    Deno.exit(1);
  }

  const findings: Finding[] = [];
  let checked = 0;

  for (const item of items ?? []) {
    const title = String(item.title ?? "").trim();
    const entries: unknown[] = [
      ...((item.audio_files as unknown[]) ?? []),
      ...((item.library_files as unknown[]) ?? []),
    ];
    if (!title || entries.length === 0) continue;
    checked++;

    // An item with zero playable audio cannot play at all — the player opens,
    // nothing loads, and the UI stalls (black screen).
    const audioEntries = entries.filter(hasAudioExtension);
    const allNames = [
      ...new Set(audioEntries.map(entryFilename).filter(Boolean)),
    ];
    if (allNames.length === 0) {
      findings.push({
        itemId: item.id,
        title,
        kind: "NO_AUDIO_TRACKS",
        evidence: [...new Set(entries.map(entryFilename))].slice(0, 8),
      });
      continue;
    }

    const titleTokens = new Set(significantTokens(title));
    const identityNames = allNames.filter((n) => !isGenericTrackName(n));

    if (identityNames.length === 0) {
      findings.push({
        itemId: item.id,
        title,
        kind: "UNVERIFIABLE_GENERIC_NAMES",
        evidence: allNames.slice(0, 5),
      });
      continue;
    }

    const matching = identityNames.filter((n) =>
      titlesLikelySameWork(title, n)
    );
    const sharingAnyToken = identityNames.some((n) =>
      significantTokens(n).some((t) => titleTokens.has(t))
    );
    if (
      matching.length === 0 && !sharingAnyToken &&
      !matchesTitleAcronym(title, identityNames)
    ) {
      findings.push({
        itemId: item.id,
        title,
        kind: "SUSPECT_MERGED",
        evidence: identityNames.slice(0, 8),
      });
    }
  }

  console.log(`\nChecked ${checked} items with audio tracks.`);
  const noAudio = findings.filter((f) => f.kind === "NO_AUDIO_TRACKS");
  const suspects = findings.filter((f) => f.kind === "SUSPECT_MERGED");
  const unverifiable = findings.filter((f) =>
    f.kind === "UNVERIFIABLE_GENERIC_NAMES"
  );

  console.log(`💀 NO_AUDIO_TRACKS (cannot play at all): ${noAudio.length}`);
  for (const f of noAudio) {
    console.log(`  • [${f.itemId}] "${f.title}"`);
    console.log(`      files: ${f.evidence.join(" | ")}`);
  }
  console.log(`🚨 SUSPECT_MERGED: ${suspects.length}`);
  for (const f of suspects) {
    console.log(`  • [${f.itemId}] "${f.title}"`);
    console.log(`      tracks: ${f.evidence.join(" | ")}`);
  }
  console.log(
    `\nℹ️  UNVERIFIABLE_GENERIC_NAMES (generic chapter filenames — cannot judge): ${unverifiable.length}`,
  );
  for (const f of unverifiable.slice(0, 20)) {
    console.log(`  • [${f.itemId}] "${f.title}"`);
  }

  if (jsonOutPath) {
    await Deno.writeTextFile(jsonOutPath, JSON.stringify(findings, null, 2));
    console.log(`\n📄 Full report written to ${jsonOutPath}`);
  }
}

main();
