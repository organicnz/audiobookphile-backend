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
  filterPlausibleFolders,
  getFolderSummaries,
  type StorageIndexEntry,
} from "../_shared/intelligentStorageResolver.ts";

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
