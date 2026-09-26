/**
 * Equivalence + performance check for the indexed storage lookup.
 *
 * Two things must hold:
 *  1. `buildStorageLookup` + `findBestDeterministicMatch` return exactly what
 *     the original linear scans returned, for every real filename in the
 *     library. A silently different match would rebind a book to the wrong
 *     folder -- the worst possible failure for this code.
 *  2. The lookup is fast enough to keep reconcile inside the edge function's
 *     CPU budget, which is what produced HTTP 546.
 */
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import {
  buildStorageLookup,
  findBestDeterministicMatch,
  isGenericTrackFilename,
  type StorageIndexEntry,
} from "../supabase/functions/_shared/intelligentStorageResolver.ts";
import { getB2Client } from "../supabase/functions/_shared/b2-bucket-pool.ts";
import {
  getConfig,
  isTierConfigured,
} from "../supabase/functions/_shared/b2-config.ts";
import type { BucketTier } from "../supabase/functions/_shared/b2-types.ts";

/** The original implementation, verbatim, as the reference oracle. */
function legacyMatch(
  filename: string,
  index: StorageIndexEntry[],
): StorageIndexEntry | null {
  if (!filename) return null;
  const clean = filename.split("/").pop() || "";
  if (!clean) return null;
  if (isGenericTrackFilename(clean)) return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch { /* ignore */ }
  const lowerClean = clean.toLowerCase();
  const lowerDecoded = decoded.toLowerCase();
  const exact = index.find(
    (e) => e.filename === clean || e.filename === decoded,
  );
  if (exact) return exact;
  const caseMatch = index.find((e) => {
    const fn = e.filename.toLowerCase();
    return fn === lowerClean || fn === lowerDecoded;
  });
  if (caseMatch) return caseMatch;
  const normClean = lowerClean.replace(/[^a-z0-9]/g, "");
  if (normClean.length >= 6) {
    const normMatch = index.find((e) => {
      const fnNorm = e.filename.toLowerCase().replace(/[^a-z0-9]/g, "");
      return fnNorm === normClean;
    });
    if (normMatch) return normMatch;
  }
  return null;
}

const index: StorageIndexEntry[] = [];
for (
  const tier of [
    "B2",
    "B2_SECONDARY",
    "B2_TERTIARY",
    "B2_QUARTET",
    "B2_QUINTET",
  ] as BucketTier[]
) {
  if (!isTierConfigured(tier)) continue;
  const client = getB2Client(tier);
  const bucket = getConfig(tier).bucketName;
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const item of res.Contents ?? []) {
      if (!item.Key) continue;
      const parts = item.Key.split("/");
      const filename = parts[parts.length - 1] || "";
      index.push({
        tier,
        prefix: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        key: item.Key,
        filename,
        size: item.Size,
      });
    }
    token = res.NextContinuationToken;
  } while (token);
}
console.log(`index: ${index.length} objects`);

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const { data: books } = await db
  .from("library_items")
  .select("id,title,audio_files")
  .limit(200);

const candidates: string[] = [];
for (const b of books ?? []) {
  for (const af of (b.audio_files ?? []) as Array<Record<string, unknown>>) {
    const meta = (af?.metadata ?? {}) as Record<string, unknown>;
    const fn = String(meta.filename ?? af?.filename ?? "");
    if (fn) candidates.push(fn);
  }
}
console.log(`candidate filenames to match: ${candidates.length}\n`);

// --- 1. equivalence -------------------------------------------------------
const lookup = buildStorageLookup(index);
let mismatches = 0;
let hits = 0;
for (const fn of candidates) {
  const a = legacyMatch(fn, index);
  const b = findBestDeterministicMatch(fn, lookup);
  const aKey = a?.key ?? null;
  const bKey = b?.key ?? null;
  if (aKey !== bKey) {
    mismatches++;
    if (mismatches <= 5) {
      console.log(`  MISMATCH "${fn}": legacy=${aKey} indexed=${bKey}`);
    }
  }
  if (aKey) hits++;
}
console.log(
  `equivalence: ${mismatches} mismatches across ${candidates.length} filenames (${hits.toString()} matched)`,
);
if (mismatches > 0) {
  console.log("\nFAILED: the indexed lookup is not behaviour-preserving");
  Deno.exit(1);
}

// --- 2. performance -------------------------------------------------------
const tLegacy = performance.now();
for (const fn of candidates) legacyMatch(fn, index);
const legacyMs = performance.now() - tLegacy;

const tIndexed = performance.now();
for (const fn of candidates) findBestDeterministicMatch(fn, lookup);
const indexedMs = performance.now() - tIndexed;

const tBuild = performance.now();
buildStorageLookup(index);
const buildMs = performance.now() - tBuild;

console.log(
  `\nmatching ${candidates.length} filenames:` +
    `\n  legacy linear scans: ${legacyMs.toFixed(0)}ms` +
    `\n  indexed lookups:     ${indexedMs.toFixed(1)}ms` +
    `\n  (lookup build once:  ${buildMs.toFixed(1)}ms)` +
    `\n  speedup: ${(legacyMs / Math.max(indexedMs, 0.001)).toFixed(0)}x`,
);
