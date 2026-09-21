import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideSplit,
  deriveRelKey,
  findCrossFolderCollisions,
  groupEntriesByFolder,
  isDiscLikeFolderName,
  type SplitEntry,
} from "../_shared/splitDecider.ts";

function entries(relKeys: string[]): SplitEntry[] {
  return relKeys.map((relKey) => ({
    relKey,
    basename: relKey.split("/").pop() || "",
  }));
}

Deno.test("splitDecider: disc-like folders are exempt", () => {
  for (const d of ["Disc 1", "CD02", "Part 3", "Volume 1", "bonus", "side 2"]) {
    assertEquals(isDiscLikeFolderName(d), true);
  }
  for (const d of ["Daniel Pratt", "Book One", "", "10 Books in 1"]) {
    assertEquals(isDiscLikeFolderName(d), false);
  }
});

Deno.test("splitDecider: relKey derives folder identity from storage paths", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assertEquals(
    deriveRelKey(`b2-tertiary://${id}/Daniel Pratt/Chapter 1.mp3`, id),
    "Daniel Pratt/Chapter 1.mp3",
  );
  assertEquals(
    deriveRelKey(`b2-tertiary://${id}/Chapter 1.mp3`, id),
    "Chapter 1.mp3",
  );
  assertEquals(deriveRelKey(`${id}/../../evil.mp3`, id), "evil.mp3");
  assertEquals(
    deriveRelKey("/legacy/absolute/path.mp3", id),
    "legacy/absolute/path.mp3",
  );
});

Deno.test("splitDecider: flat single-book batches resolve keep", () => {
  const d = decideSplit(entries(["Ch 1.mp3", "Ch 2.mp3", "Ch 3.mp3"]));
  assertEquals(d.action, "keep");
  assertEquals(d.reasons, ["SINGLE_FOLDER"]);
});

Deno.test("splitDecider: multi-disc books resolve keep", () => {
  const d = decideSplit(entries([
    "Disc 1/Track 01.mp3",
    "Disc 1/Track 02.mp3",
    "Disc 2/Track 01.mp3",
    "Disc 2/Track 02.mp3",
  ]));
  assertEquals(d.action, "keep");
  assertEquals(d.reasons, ["MULTI_DISC_BOOK"]);
});

Deno.test("splitDecider: Dark Psychology shape resolves split with per-folder plan", () => {
  const rel = [
    "Daniel Pratt/Chapter 1.mp3",
    "Daniel Pratt/Chapter 2.mp3",
    "Daniel Pratt/Chapter 3.mp3",
    "Deborah Weiss/Chapter 1.mp3",
    "Deborah Weiss/Chapter 2.mp3",
    "Deborah Weiss/Chapter 3.mp3",
  ];
  const groups = groupEntriesByFolder(entries(rel));
  assertEquals(groups.length, 2);
  assertEquals(findCrossFolderCollisions(entries(rel)), [
    "chapter 1.mp3",
    "chapter 2.mp3",
    "chapter 3.mp3",
  ]);
  const d = decideSplit(entries(rel));
  assertEquals(d.action, "split");
  assertEquals(d.plan.length, 2);
  assertEquals(d.plan[0].trackCount, 3);
});

Deno.test("splitDecider: tiny colliding group resolves review (stowaway-shaped)", () => {
  const d = decideSplit(entries([
    "Book A/Chapter 1.mp3",
    "Book A/Chapter 2.mp3",
    "Book A/Chapter 3.mp3",
    "Book B/Chapter 1.mp3",
  ]));
  assertEquals(d.action, "review");
  assertEquals(d.reasons[0].startsWith("SMALL_GROUP"), true);
});

Deno.test("splitDecider: multi-folder without collisions resolves review (omnibus-safe)", () => {
  const d = decideSplit(entries([
    "Book One/Alpha.mp3",
    "Book One/Beta.mp3",
    "Book Two/Gamma.mp3",
    "Book Two/Delta.mp3",
  ]));
  assertEquals(d.action, "review");
  assertEquals(d.reasons, ["MULTI_FOLDER_NO_COLLISION"]);
});

Deno.test("splitDecider: colliding flat strays resolve review, never silent drop", () => {
  const d = decideSplit(entries([
    "Book A/Chapter 1.mp3",
    "Book A/Chapter 2.mp3",
    "Book A/Chapter 3.mp3",
    "Book B/Chapter 1.mp3",
    "Book B/Chapter 2.mp3",
    "Book B/Chapter 3.mp3",
    "Chapter 1.mp3",
  ]));
  assertEquals(d.action, "review");
  assertEquals(d.reasons, ["FLAT_STRAY_COLLISION"]);
});
