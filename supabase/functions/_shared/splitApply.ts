/**
 * Split Apply — the write path of the merged-books auto-splitter.
 *
 * Extracted from split_merged_books.ts so the most dangerous code in the
 * repo (rewriting library_items) is unit-testable with a fake client.
 *
 * Crash-safety ordering (the whole point of this module):
 *   1. Insert ALL sibling items first.
 *   2. Shrink the kept item LAST.
 *   3. Abort the item on the FIRST error — no kept-update after a failed
 *      sibling insert (that order strands tracks nowhere: removed from the
 *      kept item, never inserted as a sibling).
 *
 * A failed item reports { applied: false } with partial createdIds so the
 * operator can reconcile via library_item_split_audit; the source row is
 * left untouched, so a re-run re-decides rather than compounding.
 */

export interface SplitAnalyzedEntry {
  raw: Record<string, unknown>;
}

export interface SplitAttribution {
  title: string;
  author: string;
  source: string;
}

export interface SplitPlanInput {
  folder: string;
  trackCount: number;
  entryIndexes: number[];
  attr: SplitAttribution;
}

export interface SplitApplyItem {
  id: string;
  library_id: string;
  media_type?: string | null;
  title?: string | null;
  library_files?: unknown;
}

export interface SplitApplyResult {
  applied: boolean;
  keptId?: string;
  createdIds: string[];
  /** Human-readable failure, set when applied === false. */
  error?: string;
}

export function entryDurationOf(raw: Record<string, unknown>): number {
  const md = (raw.metadata ?? {}) as Record<string, unknown>;
  for (const candidate of [md.duration, raw.duration]) {
    const n = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export function entrySizeOf(raw: Record<string, unknown>): number {
  const md = (raw.metadata ?? {}) as Record<string, unknown>;
  return Number(raw.size ?? md.size ?? 0) || 0;
}

interface DbClient {
  from(table: string): any;
}

function reindexed(
  analyzed: SplitAnalyzedEntry[],
  indexes: number[],
): Record<string, unknown>[] {
  return indexes.map((srcIdx, pos) => ({
    ...analyzed[srcIdx].raw,
    index: pos + 1,
  }));
}

function subsetLibraryFiles(
  item: SplitApplyItem,
  analyzed: SplitAnalyzedEntry[],
  indexes: number[],
): Record<string, unknown>[] {
  const inos = new Set(
    indexes.map((i) => String(analyzed[i].raw.ino ?? "")),
  );
  const libFiles = Array.isArray(item.library_files) ? item.library_files : [];
  return (libFiles as Record<string, unknown>[]).filter((lf) =>
    inos.has(String(lf.ino ?? ""))
  );
}

/**
 * Execute one decided split. `planGroups` must be ordered largest-first
 * (plan[0] stays in place); flat strays in `strayIndexes` ride with it.
 */
export async function applySplitPlan(
  supabase: DbClient,
  item: SplitApplyItem,
  analyzed: SplitAnalyzedEntry[],
  planGroups: SplitPlanInput[],
  strayIndexes: number[],
): Promise<SplitApplyResult> {
  const createdIds: string[] = [];
  const fail = (error: string): SplitApplyResult => ({
    applied: false,
    createdIds,
    error,
  });

  if (planGroups.length === 0) {
    return fail("empty split plan");
  }
  const itemTitle = String(item.title ?? "Untitled");

  try {
    // 1. Siblings first — every group except the kept (largest) one.
    for (const g of planGroups.slice(1)) {
      const files = reindexed(analyzed, g.entryIndexes);
      const newId = crypto.randomUUID();
      const newTitle = g.attr.title || `${itemTitle} — ${g.folder}`;
      const duration = Math.round(
        g.entryIndexes.reduce(
          (s, i) => s + entryDurationOf(analyzed[i].raw),
          0,
        ),
      );
      const size = g.entryIndexes.reduce(
        (s, i) => s + entrySizeOf(analyzed[i].raw),
        0,
      );
      const { error: insErr } = await supabase.from("library_items").insert({
        id: newId,
        library_id: item.library_id,
        media_type: item.media_type || "book",
        media_id: newId,
        path: `${item.library_id}/${newTitle}`,
        rel_path: newTitle,
        title: newTitle,
        author_names_first_last: g.attr.author || null,
        audio_files: files,
        library_files: subsetLibraryFiles(item, analyzed, g.entryIndexes),
        duration,
        size,
        is_missing: false,
      });
      if (insErr) {
        return fail(
          `sibling insert failed for "${newTitle}": ${insErr.message}`,
        );
      }

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
          .eq("name", authorName)
          .eq("library_id", item.library_id)
          .maybeSingle();
        if ((existingAuthor as { id?: string } | null)?.id) {
          await supabase.from("book_authors").upsert(
            {
              library_item_id: newId,
              author_id: (existingAuthor as { id: string }).id,
            },
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
        track_count: g.entryIndexes.length,
        decided_by: g.attr.source,
      });
      createdIds.push(newId);
    }

    // 2. Kept item LAST — only reachable when every sibling exists.
    const kept = planGroups[0];
    const keptIndexes = [...kept.entryIndexes, ...strayIndexes];
    const { error: upErr } = await supabase.from("library_items").update({
      audio_files: reindexed(analyzed, keptIndexes),
      library_files: subsetLibraryFiles(item, analyzed, keptIndexes),
      duration: Math.round(
        keptIndexes.reduce((s, i) => s + entryDurationOf(analyzed[i].raw), 0),
      ),
      size: keptIndexes.reduce((s, i) => s + entrySizeOf(analyzed[i].raw), 0),
    }).eq("id", item.id);
    if (upErr) {
      return fail(`kept-item update failed: ${upErr.message}`);
    }

    return { applied: true, keptId: item.id, createdIds };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
