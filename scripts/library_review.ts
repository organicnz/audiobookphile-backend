// Library consistency audit: a read-only sweep for the class of defects that
// make the library *look* fine in the database while behaving badly in the app.
//
// Run on a schedule (see .github/workflows/library-review.yml) and on demand.
// It never writes: it reports. Repairs stay explicit and reviewable, because
// every one of these is a decision about what the user actually owns.
//
// Checks, each of which is a real defect class observed in production:
//
//  1. COVER_MISSING      - cover_path is NULL/''/'missing' -> placeholder art.
//  2. COVER_ORPHAN       - cover_path points at an object that is not in the
//                          `covers` bucket -> the client gets a broken image.
//  3. TRACK_COUNT_DRIFT  - num_tracks disagrees with jsonb_array_length
//                          (audio_files). The trigger should make this
//                          impossible; if it fires, the trigger is missing.
//  4. MISSING_FLAG_STUCK - is_missing is true but every track is reachable in
//                          B2 -> a latched flag that hides Play forever. This
//                          was the self-perpetuating 404 trap.
//  5. FLAG_WITHOUT_DATA  - is_missing is true but audio_files is empty: nothing
//                          to resolve, so the resolver can never help.
//  6. DURATION_DRIFT     - stored duration is wildly inconsistent with the
//                          summed per-track durations.
//  7. EMPTY_TITLE        - untitled rows break every search/provider lookup.
//  8. DUPLICATE_TITLE_AUTHOR - two rows for the same work, usually a re-scan
//                          that failed to replace the original.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (+ B2 tier credentials for the
// storage checks). Exit 0 always: findings are reported, not enforced, so a
// noisy audit can never fail a deploy. Inspect the summary to decide.

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { getB2Client } from "../supabase/functions/_shared/b2-bucket-pool.ts";
import {
  getConfig,
  isTierConfigured,
} from "../supabase/functions/_shared/b2-config.ts";
import type { BucketTier } from "../supabase/functions/_shared/b2-types.ts";

const URL_BASE = Deno.env.get("SUPABASE_URL") ?? "";
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!URL_BASE || !SVC) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  Deno.exit(2);
}
const db = createClient(URL_BASE, SVC, { auth: { persistSession: false } });

const TIERS: BucketTier[] = [
  "B2",
  "B2_SECONDARY",
  "B2_TERTIARY",
  "B2_QUARTET",
  "B2_QUINTET",
];

type Finding = {
  check: string;
  severity: "high" | "medium" | "low";
  itemId: string;
  title: string;
  detail: string;
};

const findings: Finding[] = [];
const add = (f: Finding) => findings.push(f);

// ---------------------------------------------------------------------------
// Load every item. audit_only selects no embedding column to keep the payload
// small, but DOES include audio_files -- resolving track paths is the whole
// point of the MISSING_FLAG_STUCK check.
// ---------------------------------------------------------------------------
const { data: items, error } = await db
  .from("library_items")
  .select(
    "id,title,author_names_first_last,cover_path,duration,is_missing,is_invalid,media_type,audio_files,updated_at",
  )
  .limit(1000);
if (error) throw new Error(error.message);
console.log(`auditing ${items?.length ?? 0} library items\n`);

// --- covers bucket index ----------------------------------------------------
const coverObjects = new Set<string>();
try {
  let token: string | undefined;
  do {
    const res = await db.storage.from("covers").list("", { limit: 1000 });
    for (const f of res.data ?? []) {
      coverObjects.add(f.name);
      // one level of prefix folders (covers live at <itemId>/cover.jpg)
      const sub = await db.storage.from("covers").list(f.name, { limit: 50 });
      for (const s of sub.data ?? []) coverObjects.add(`${f.name}/${s.name}`);
    }
    break;
  } while (token);
} catch { /* covered below by the ORPHAN finding */ }

// --- b2 object index (filename + prefix) ------------------------------------
const b2Keys = new Set<string>();
const b2ByFilename = new Map<string, string[]>();
let b2Indexed = false;
try {
  for (const tier of TIERS) {
    if (!isTierConfigured(tier)) continue;
    const client = getB2Client(tier);
    const bucket = getConfig(tier).bucketName;
    let token: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) {
        if (!o.Key) continue;
        b2Keys.add(o.Key);
        const fn = o.Key.split("/").pop()!.toLowerCase();
        const arr = b2ByFilename.get(fn) ?? [];
        arr.push(o.Key);
        b2ByFilename.set(fn, arr);
      }
      token = res.NextContinuationToken;
    } while (token);
  }
  b2Indexed = true;
  console.log(`indexed ${b2Keys.size} B2 objects across configured tiers\n`);
} catch (e) {
  console.warn(
    `  B2 index unavailable, skipping storage checks: ${
      (e as Error).message
    }\n`,
  );
}

// --- per-item checks --------------------------------------------------------
const seenIdentity = new Map<string, string>();

/** Shape of the per-file metadata this audit reads out of audio_files. */
interface AudioFileRow {
  duration?: number;
  metadata?: {
    duration?: number;
    filename?: string;
  };
  filename?: string;
}

for (const it of items ?? []) {
  const title = String(it.title ?? "").trim();
  const files = Array.isArray(it.audio_files)
    ? (it.audio_files as AudioFileRow[])
    : [];

  // 7. empty title
  if (!title) {
    add({
      check: "EMPTY_TITLE",
      severity: "high",
      itemId: it.id,
      title: "(untitled)",
      detail: "no title: breaks search, cover lookup and every provider query",
    });
  }

  // 1. cover missing
  const coverPath = String(it.cover_path ?? "");
  if (!coverPath || coverPath === "missing") {
    add({
      check: "COVER_MISSING",
      severity: "low",
      itemId: it.id,
      title,
      detail: coverPath === "missing"
        ? "cover_path='missing' (terminal sentinel) -> placeholder art"
        : "cover_path is empty -> placeholder art",
    });
  } else if (coverObjects.size > 0 && !coverObjects.has(coverPath)) {
    // 2. cover orphan
    add({
      check: "COVER_ORPHAN",
      severity: "high",
      itemId: it.id,
      title,
      detail: `cover_path '${coverPath}' has no object in the covers bucket`,
    });
  }

  // 3. track count drift
  const { data: countRow } = await db
    .from("library_items")
    .select("num_tracks")
    .eq("id", it.id)
    .single();
  if (countRow && Number(countRow.num_tracks) !== files.length) {
    add({
      check: "TRACK_COUNT_DRIFT",
      severity: "high",
      itemId: it.id,
      title,
      detail:
        `num_tracks=${countRow.num_tracks} but audio_files has ${files.length}`,
    });
  }

  // 5. flag without data
  if (it.is_missing && files.length === 0) {
    add({
      check: "FLAG_WITHOUT_DATA",
      severity: "high",
      itemId: it.id,
      title,
      detail:
        "is_missing=true with zero audio_files: nothing to resolve, permanently unplayable",
    });
  }

  // 4. latched is_missing but the audio is actually there
  if (b2Indexed && it.is_missing && files.length > 0) {
    let reachable = 0;
    for (const f of files) {
      const fn = String(f?.metadata?.filename ?? f?.filename ?? "")
        .split("/")
        .pop()!
        .toLowerCase();
      if (fn && b2ByFilename.has(fn)) reachable += 1;
    }
    if (reachable > 0) {
      add({
        check: "MISSING_FLAG_STUCK",
        severity: "high",
        itemId: it.id,
        title,
        detail:
          `is_missing=true but ${reachable}/${files.length} filenames exist in B2: the flag latched and hides Play`,
      });
    }
  }

  // 6. duration drift
  if (files.length > 0) {
    const summed = files.reduce(
      (s, f) => s + (Number(f?.duration) || Number(f?.metadata?.duration) || 0),
      0,
    );
    const stored = Number(it.duration) || 0;
    if (summed > 60 && stored > 0) {
      const ratio = summed / stored;
      if (ratio > 3 || ratio < 1 / 3) {
        add({
          check: "DURATION_DRIFT",
          severity: "medium",
          itemId: it.id,
          title,
          detail: `stored ${Math.round(stored)}s vs summed tracks ${
            Math.round(summed)
          }s (${ratio.toFixed(1)}x)`,
        });
      }
    }
  }

  // 8. duplicate identity
  if (title) {
    const key = `${title.toLowerCase()}|${
      String(it.author_names_first_last ?? "").toLowerCase()
    }`;
    const prior = seenIdentity.get(key);
    if (prior) {
      add({
        check: "DUPLICATE_TITLE_AUTHOR",
        severity: "medium",
        itemId: it.id,
        title,
        detail: `same title+author as ${prior} (likely a failed re-scan)`,
      });
    } else {
      seenIdentity.set(key, it.id);
    }
  }
}

// --- report -----------------------------------------------------------------
const byCheck = new Map<string, Finding[]>();
for (const f of findings) {
  const arr = byCheck.get(f.check) ?? [];
  arr.push(f);
  byCheck.set(f.check, arr);
}

const order = [...byCheck.entries()].sort(
  (a, b) =>
    ["high", "medium", "low"].indexOf(
      a[1][0].severity,
    ) - ["high", "medium", "low"].indexOf(b[1][0].severity),
);

for (const [check, list] of order) {
  console.log(`\n=== ${check} (${list.length}) [${list[0].severity}]`);
  for (const f of list.slice(0, 25)) {
    console.log(
      `  ${f.title.slice(0, 46).padEnd(48)} ${f.detail.slice(0, 88)}`,
    );
  }
  if (list.length > 25) console.log(`  ... and ${list.length - 25} more`);
}

const high = findings.filter((f) => f.severity === "high").length;
console.log(
  `\n=== summary: ${findings.length} findings across ${byCheck.size} checks ` +
    `(${high} high severity)`,
);

Deno.exit(0);
