// Unit tests for the storage-resolver helpers that keep the nightly
// reconciliation affordable.
//
// Regression context: admin/reconcile-storage walked every library item and, for
// each one whose deterministic match failed, made a Z.AI model call. With a
// 100-book library where most books have no audio in storage at all, that was
// ~73 sequential model calls inside a single edge invocation. It returned
// HTTP 546 WORKER_RESOURCE_LIMIT every night, so the storage index was never
// actually reconciled and nobody noticed, because a dead run and a clean run
// both produced no output.
//
// The fix is a purely local gate: every track of a book lives in one folder, so
// a folder whose file count is far from the book's track count cannot be the
// match. These tests pin that arithmetic, including the tolerance edges --
// being too strict would silently stop repairing real books.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStorageLookup,
  filterPlausibleFolders,
  findBestDeterministicMatch,
  getFolderEntries,
  getFolderSummaries,
  isGenericTrackFilename,
  type StorageIndexEntry,
} from "../_shared/intelligentStorageResolver.ts";

/**
 * The pre-index implementation of findBestDeterministicMatch, kept verbatim as
 * an oracle. The indexed version replaced three linear scans with hash lookups
 * to bring reconciliation back inside the edge function's CPU budget; this
 * pins that the replacement is behaviour-preserving, because a silently
 * different match would rebind a book to the wrong storage folder -- the worst
 * failure this code can have.
 */
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

/** Index with a deliberate mix of exact/case/punctuation collisions + noise. */
const mixedIndex: StorageIndexEntry[] = [
  {
    tier: "B2",
    prefix: "alpha",
    key: "alpha/Chapter 01.mp3",
    filename: "Chapter 01.mp3",
    size: 1,
  },
  {
    tier: "B2",
    prefix: "alpha",
    key: "alpha/Some Chapter Name.mp3",
    filename: "Some Chapter Name.mp3",
    size: 1,
  },
  {
    tier: "B2",
    prefix: "beta",
    key: "beta/Disc%201%20-%20Track.mp3",
    filename: "Disc%201%20-%20Track.mp3",
    size: 1,
  },
  {
    tier: "B2",
    prefix: "beta",
    key: "beta/Disc 1 - Track.mp3",
    filename: "Disc 1 - Track.mp3",
    size: 1,
  },
  {
    tier: "B2_SECONDARY",
    prefix: "gamma",
    key: "gamma/The Feynman Lectures Vol II.mp3",
    filename: "The Feynman Lectures Vol II.mp3",
    size: 1,
  },
  {
    tier: "B2_SECONDARY",
    prefix: "gamma",
    key: "gamma/short.mp3",
    filename: "short.mp3",
    size: 1,
  },
  {
    tier: "B2",
    prefix: "delta",
    key: "delta/1.mp3",
    filename: "1.mp3",
    size: 1,
  },
  {
    tier: "B2",
    prefix: "delta",
    key: "delta/2.mp3",
    filename: "2.mp3",
    size: 1,
  },
];

const equivalenceProbes = [
  "Chapter 01.mp3",
  "chapter 01.mp3",
  "CHAPTER 01.MP3",
  "Some Chapter Name.mp3",
  "Some-Chapter-Name.mp3",
  "some_chapter_name.mp3",
  "Disc 1 - Track.mp3",
  "Disc%201%20-%20Track.mp3",
  "DISC 1 TRACK.mp3",
  "The Feynman Lectures Vol II.mp3",
  "thefeynmanlecturesvolii.mp3",
  "short.mp3",
  "short",
  "1.mp3",
  "2.mp3",
  "Chapter 7.mp3",
  "does-not-exist-at-all.mp3",
  "",
  "/nested/path/Chapter 01.mp3",
  "Some%20Chapter%20Name.mp3",
];

Deno.test("indexed lookup is behaviour-identical to the original linear scans", () => {
  const lookup = buildStorageLookup(mixedIndex);
  for (const probe of equivalenceProbes) {
    const expected = legacyMatch(probe, mixedIndex)?.key ?? null;
    const actual = findBestDeterministicMatch(probe, lookup)?.key ?? null;
    assertEquals(
      actual,
      expected,
      `probe "${probe}" diverged from the legacy implementation`,
    );
  }
});

Deno.test("indexed lookup preserves the real-world library's match decisions", () => {
  // Same probes, run through the array overload so the lazy-build path is
  // covered too: callers that pass a raw index must get identical results.
  const lookup = buildStorageLookup(mixedIndex);
  for (const probe of equivalenceProbes) {
    assertEquals(
      findBestDeterministicMatch(probe, mixedIndex)?.key ?? null,
      findBestDeterministicMatch(probe, lookup)?.key ?? null,
      `array overload diverged for "${probe}"`,
    );
  }
});

Deno.test("generic track names never match, indexed or not", () => {
  const lookup = buildStorageLookup(mixedIndex);
  // 1.mp3 and 2.mp3 exist in the index but must be refused: a bare number
  // cannot identify a book, and matching on it is what mis-binds folders.
  assertEquals(findBestDeterministicMatch("1.mp3", lookup), null);
  assertEquals(findBestDeterministicMatch("2.mp3", lookup), null);
  assertEquals(findBestDeterministicMatch("Chapter 7.mp3", lookup), null);
});

Deno.test("folder and key lookups are O(1) and exact", () => {
  const lookup = buildStorageLookup(mixedIndex);
  assertEquals(
    getFolderEntries(lookup, "B2", "alpha").map((e) => e.filename),
    ["Chapter 01.mp3", "Some Chapter Name.mp3"],
  );
  // Tiers are namespaced: the same prefix name on another tier must not leak.
  assertEquals(
    getFolderEntries(lookup, "B2_SECONDARY", "gamma").map((e) => e.filename),
    ["The Feynman Lectures Vol II.mp3", "short.mp3"],
  );
  assertEquals(getFolderEntries(lookup, "B2", "nope").length, 0);
  assertEquals(
    lookup.byKey.get("B2:::alpha/Some Chapter Name.mp3")?.filename,
    "Some Chapter Name.mp3",
  );
  assertEquals(lookup.byKey.get("B2:::missing.mp3"), undefined);
});

function folder(
  tier: StorageIndexEntry["tier"],
  prefix: string,
  fileCount: number,
): StorageIndexEntry[] {
  return Array.from({ length: fileCount }, (_, i) => ({
    tier,
    prefix,
    key: `${prefix}/track ${i}.mp3`,
    filename: `track ${i}.mp3`,
    size: 1024,
  }));
}

Deno.test("getFolderSummaries: counts files and keeps a filename sample per folder", () => {
  const index: StorageIndexEntry[] = [
    ...folder("B2", "alpha", 3),
    ...folder("B2_SECONDARY", "beta", 12),
  ];
  const summaries = getFolderSummaries(index);
  assertEquals(summaries.length, 2);
  const alpha = summaries.find((s) => s.prefix === "alpha")!;
  const beta = summaries.find((s) => s.prefix === "beta")!;
  assertEquals(alpha.fileCount, 3);
  assertEquals(beta.fileCount, 12);
  assertEquals(alpha.sampleFilenames.length, 3);
  // sample is capped so the model prompt stays lean
  assertEquals(beta.sampleFilenames.length, 5);
});

Deno.test("plausibility gate: excludes folders whose size cannot hold the book", () => {
  const folders = getFolderSummaries([
    ...folder("B2", "tiny", 9),
    ...folder("B2", "huge", 400),
    ...folder("B2", "exact", 57),
  ]);
  // A 57-track book cannot be in a 9-file or a 400-file folder.
  const plausible = filterPlausibleFolders(folders, 57);
  assertEquals(plausible.map((f) => f.prefix), ["exact"]);
});

Deno.test("plausibility gate: tolerates a few stray files in either direction", () => {
  const folders = getFolderSummaries([
    ...folder("B2", "off_by_few", 54),
    ...folder("B2", "off_by_more", 40),
  ]);
  // 57 tracks: 54 is within tolerance (scans gain/lose a file or two), 40 is
  // not. Over-strictness here would silently stop repairing real books.
  const plausible = filterPlausibleFolders(folders, 57);
  assertEquals(plausible.map((f) => f.prefix), ["off_by_few"]);
});

Deno.test("plausibility gate: short books get a generous absolute cushion", () => {
  const folders = getFolderSummaries([
    ...folder("B2", "one_track", 1),
    ...folder("B2", "two_track", 2),
    ...folder("B2", "five_track", 5),
  ]);
  // The absolute floor of +/-3 dominates for short books, so a 1-track book
  // admits folders from 1 to 4 files and a 2-track book up to 5. That is
  // intentional: a real folder often carries a couple of non-audio files
  // (cover.jpg, a stray .nfo), and a false negative here means a genuinely
  // recoverable book is never repaired. The gate only has to exclude the
  // arithmetically impossible.
  assertEquals(filterPlausibleFolders(folders, 1).map((f) => f.prefix), [
    "one_track",
    "two_track",
  ]);
  assertEquals(filterPlausibleFolders(folders, 2).map((f) => f.prefix), [
    "one_track",
    "two_track",
    "five_track",
  ]);
});

Deno.test("plausibility gate: a book with no tracks can never be placed", () => {
  const folders = getFolderSummaries(folder("B2", "anything", 10));
  // Guards the budget path: no tracks means no AI call is ever worth making.
  assertEquals(filterPlausibleFolders(folders, 0).length, 0);
});

Deno.test("plausibility gate: an empty index yields no candidates, not a crash", () => {
  assertEquals(filterPlausibleFolders([], 57).length, 0);
});
