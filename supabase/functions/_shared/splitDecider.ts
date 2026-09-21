/**
 * Split Decider — pure, testable judgment for the merged-books auto-splitter.
 *
 * A library_item is auto-splittable ONLY in the corruption shape:
 *   1. tracks partition into 2+ top-level subfolders (non-disc-like names), AND
 *   2. basenames collide across those folders (certain flat-key overwrite +
 *      dedup collapse — the Dark Psychology incident), AND
 *   3. every resulting group holds >= MIN_GROUP_TRACKS tracks (a 1–2 file
 *      group is stowaway-shaped and belongs to the stowaway flow, not a split).
 *
 * Everything else resolves to `keep` (single work) or `review` (needs the
 * LLM attribution step in split_merged_books.ts or a human — never an
 * autonomous write). Box-set omnibuses ("Book 1..3", distinct basenames, no
 * collisions) deliberately resolve to `review`, not `split`.
 *
 * NOTE on the "" (book-root) group: when a split proceeds, entries outside
 * every plan group (flat strays) MUST stay with the kept (largest) item.
 */

export const MIN_GROUP_TRACKS = 3;
export const MAX_SPLIT_GROUPS = 8;

/** Minimal observable shape of one audio_files entry for split judgment. */
export interface SplitEntry {
  /** Key relative to the book folder, e.g. "Disc 1/Track 01.mp3" or "Ch 1.mp3". */
  relKey: string;
  /** Bare filename for collision checks, e.g. "Track 01.mp3". */
  basename: string;
}

export interface SplitGroup {
  /** Top-level subfolder ("" = book root). */
  folder: string;
  /** Indexes into the input entries array, in original order. */
  entryIndexes: number[];
}

export type SplitAction = "split" | "keep" | "review";

export interface SplitPlanGroup {
  folder: string;
  trackCount: number;
  entryIndexes: number[];
}

export interface SplitDecision {
  action: SplitAction;
  /** Machine-readable reason codes, most significant first. */
  reasons: string[];
  /** Populated only when action === "split". Largest group first. */
  plan: SplitPlanGroup[];
}

/**
 * Disc-like folder names belong to ONE multi-disc work — never a signal of
 * distinct books. Kept in sync with isDiscLikeFolder() in
 * api/_shared/domain/downloads.ts (duplicated to keep this module
 * dependency-free for edge + script runtimes).
 */
export function isDiscLikeFolderName(name: string): boolean {
  return /^(disc|disk|cd|part|pt|vol|volume|bonus|side)[\s._-]*\d*$/i.test(
    name.trim(),
  );
}

/**
 * Recover a file's key relative to its book folder from an already-uploaded
 * storage path: strip scheme + leading `<bookId>/`, drop `.`/`..`/empty
 * segments, URI-decode the rest. Mirrors deriveRelKey() in
 * api/_shared/domain/downloads.ts (duplicated for the same reason).
 * NEVER rewrites storage — grouping identity only.
 */
export function deriveRelKey(storagePath: string, bookId = ""): string {
  let key = String(storagePath || "")
    .replace(/^[a-z0-9-_]+:\/\//i, "")
    .replace(/^\/+/, "");
  if (bookId) {
    if (key === bookId) return "";
    const prefix = `${bookId}/`;
    if (key.startsWith(prefix)) key = key.slice(prefix.length);
  }
  const segments: string[] = [];
  for (const raw of key.split("/")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") continue;
    try {
      segments.push(decodeURIComponent(trimmed));
    } catch {
      segments.push(trimmed);
    }
  }
  return segments.join("/");
}

/** Partition entry indexes by top-level subfolder ("" included). */
export function groupEntriesByFolder(entries: SplitEntry[]): SplitGroup[] {
  const map = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const slash = e.relKey.indexOf("/");
    const folder = slash === -1 ? "" : e.relKey.slice(0, slash);
    if (!map.has(folder)) map.set(folder, []);
    map.get(folder)!.push(i);
  });
  return [...map.entries()]
    .map(([folder, entryIndexes]) => ({ folder, entryIndexes }))
    .sort((a, b) => b.entryIndexes.length - a.entryIndexes.length);
}

/**
 * Lowercased basenames present in 2+ folders where at least one holder is
 * NOT disc-like. Empty basenames are ignored.
 */
export function findCrossFolderCollisions(
  entries: SplitEntry[],
  groups: SplitGroup[],
): string[] {
  void groups;
  const holders = new Map<string, Set<string>>();
  const folderOf = new Map<number, string>();
  for (const g of groupEntriesByFolder(entries)) {
    for (const i of g.entryIndexes) folderOf.set(i, g.folder);
  }
  entries.forEach((e, i) => {
    const key = e.basename.trim().toLowerCase();
    if (!key) return;
    if (!holders.has(key)) holders.set(key, new Set());
    holders.get(key)!.add(folderOf.get(i) ?? "");
  });
  const out: string[] = [];
  for (const [base, folders] of holders) {
    if (folders.size < 2) continue;
    if ([...folders].every(isDiscLikeFolderName)) continue;
    out.push(base);
  }
  return out.sort();
}

/**
 * Judge one item's entries. Pure: no I/O, no LLM — the autonomous
 * self-decision. Ambiguous shapes resolve to `review`, never `split`.
 */
export function decideSplit(entries: SplitEntry[]): SplitDecision {
  if (entries.length === 0) {
    return { action: "keep", reasons: ["EMPTY_ITEM"], plan: [] };
  }
  const groups = groupEntriesByFolder(entries);
  const nonEmpty = groups.filter((g) => g.folder !== "");
  if (nonEmpty.length < 2) {
    return { action: "keep", reasons: ["SINGLE_FOLDER"], plan: [] };
  }
  if (nonEmpty.every((g) => isDiscLikeFolderName(g.folder))) {
    return { action: "keep", reasons: ["MULTI_DISC_BOOK"], plan: [] };
  }
  if (groups.length > MAX_SPLIT_GROUPS) {
    return { action: "review", reasons: ["TOO_MANY_GROUPS"], plan: [] };
  }
  const collisions = findCrossFolderCollisions(entries, groups);
  if (collisions.length === 0) {
    // Distinct folders, distinct names: possibly an omnibus, possibly distinct
    // works — a naming judgment call, not a corruption certainty. LLM/human.
    return {
      action: "review",
      reasons: ["MULTI_FOLDER_NO_COLLISION"],
      plan: [],
    };
  }
  const plan: SplitPlanGroup[] = groups
    .filter((g) => g.folder !== "")
    .map((g) => ({
      folder: g.folder,
      trackCount: g.entryIndexes.length,
      entryIndexes: [...g.entryIndexes],
    }));
  // Flat strays ("") can ride along only when they collide with nothing;
  // colliding strays make the split ambiguous → human review.
  const flatGroup = groups.find((g) => g.folder === "");
  if (flatGroup) {
    const flatBases = new Set(
      flatGroup.entryIndexes.map((i) =>
        entries[i].basename.trim().toLowerCase()
      ).filter(Boolean),
    );
    const strayCollision = collisions.some((c) => flatBases.has(c));
    if (strayCollision) {
      return {
        action: "review",
        reasons: ["FLAT_STRAY_COLLISION"],
        plan: [],
      };
    }
  }
  const small = plan.filter((p) => p.trackCount < MIN_GROUP_TRACKS);
  if (small.length > 0) {
    return {
      action: "review",
      reasons: [
        `SMALL_GROUP:${
          small.map((p) => `${p.folder}=${p.trackCount}`).join(",")
        }`,
      ],
      plan: [],
    };
  }
  return {
    action: "split",
    reasons: [
      `CROSS_FOLDER_COLLISION:${collisions.slice(0, 5).join(",")}`,
    ],
    plan,
  };
}
