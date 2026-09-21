import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applySplitPlan,
  type SplitApplyItem,
  type SplitPlanInput,
} from "../_shared/splitApply.ts";

interface Call {
  table: string;
  op: string;
  payload?: unknown;
}

function track(name: string, duration = 10, size = 1200, ino?: string) {
  return {
    ino: ino ?? `ino-${name}`,
    duration,
    size,
    metadata: { filename: name, duration, size },
  };
}

/** Minimal fake supabase client recording every write in order. */
function fakeDb(opts?: {
  failInsertTitle?: string;
  failUpdate?: boolean;
}): { client: any; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          calls.push({ table, op: "insert", payload });
          if (
            opts?.failInsertTitle &&
            String(
              (payload as Record<string, unknown>).title ?? "",
            ).includes(opts.failInsertTitle)
          ) {
            return Promise.resolve({ error: { message: "boom-insert" } });
          }
          return Promise.resolve({ error: null });
        },
        update(payload: unknown) {
          return {
            eq: () => {
              calls.push({ table, op: "update", payload });
              if (opts?.failUpdate) {
                return Promise.resolve({ error: { message: "boom-update" } });
              }
              return Promise.resolve({ error: null });
            },
          };
        },
        upsert(payload: unknown, _opts?: unknown) {
          calls.push({ table, op: "upsert", payload });
          return Promise.resolve({ error: null });
        },
        select(_cols?: string) {
          return {
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: { id: "author-1" },
                    error: null,
                  }),
              }),
            }),
          };
        },
      };
    },
  };
  return { client, calls };
}

const ITEM: SplitApplyItem = {
  id: "source-id",
  library_id: "lib-1",
  media_type: "book",
  title: "Collection",
  library_files: [],
};

function analyzed() {
  return [
    { raw: track("A1.mp3", 10, 1000, "a1") },
    { raw: track("A2.mp3", 20, 2000, "a2") },
    { raw: track("B1.mp3", 30, 3000, "b1") },
    { raw: track("B2.mp3", 40, 4000, "b2") },
  ];
}

function plan(): SplitPlanInput[] {
  return [
    {
      folder: "Author A",
      trackCount: 2,
      entryIndexes: [0, 1],
      attr: { title: "Book A", author: "Author A", source: "llm" },
    },
    {
      folder: "Author B",
      trackCount: 2,
      entryIndexes: [2, 3],
      attr: { title: "Book B", author: "Author B", source: "llm" },
    },
  ];
}

Deno.test("splitApply: siblings are inserted BEFORE the kept item is shrunk", async () => {
  const { client, calls } = fakeDb();
  const res = await applySplitPlan(client, ITEM, analyzed(), plan(), []);
  assertEquals(res.applied, true);
  assertEquals(res.keptId, "source-id");
  assertEquals(res.createdIds.length, 1);

  const ops = calls
    .filter((c) => c.table === "library_items")
    .map((c) => c.op);
  assertEquals(ops, ["insert", "update"]);

  const inserted = calls.find((c) => c.op === "insert")!
    .payload as Record<string, unknown>;
  assertEquals(inserted.title, "Book B");
  assertEquals(inserted.duration, 70);
  assertEquals(inserted.size, 7000);
  assertEquals(
    ((inserted.audio_files ?? []) as Record<string, unknown>[]).map((f) =>
      f.index
    ),
    [1, 2],
  );

  const updated = calls.find((c) => c.op === "update")!
    .payload as Record<string, unknown>;
  assertEquals(updated.duration, 30);
  const keptFiles = (updated.audio_files ?? []) as Record<string, unknown>[];
  assertEquals(keptFiles.length, 2);

  // Audit row trails the sibling it describes.
  const audit = calls.find((c) => c.table === "library_item_split_audit")!;
  assertEquals(
    (audit.payload as Record<string, unknown>).source_item_id,
    "source-id",
  );
});

Deno.test("splitApply: failed sibling insert leaves the source row untouched", async () => {
  const { client, calls } = fakeDb({ failInsertTitle: "Book B" });
  const res = await applySplitPlan(client, ITEM, analyzed(), plan(), []);
  assertEquals(res.applied, false);
  assertEquals(res.createdIds.length, 0);
  assertEquals(
    calls.some((c) => c.table === "library_items" && c.op === "update"),
    false,
  );
  assertEquals(String(res.error).includes("Book B"), true);
});

Deno.test("splitApply: failed kept update is reported with siblings listed", async () => {
  const { client, calls } = fakeDb({ failUpdate: true });
  const res = await applySplitPlan(client, ITEM, analyzed(), plan(), []);
  assertEquals(res.applied, false);
  assertEquals(res.createdIds.length, 1);
  assertEquals(
    calls.filter((c) => c.table === "library_items" && c.op === "insert")
      .length,
    1,
  );
  assertEquals(String(res.error).includes("kept-item"), true);
});

Deno.test("splitApply: flat strays ride with the kept item", async () => {
  const { client, calls } = fakeDb();
  const withStray = [
    ...analyzed(),
    { raw: track("loose.mp3", 5, 500, "loose") },
  ];
  const res = await applySplitPlan(client, ITEM, withStray, plan(), [4]);
  assertEquals(res.applied, true);
  const updated = calls.find((c) => c.op === "update")!
    .payload as Record<string, unknown>;
  assertEquals(updated.duration, 35);
  assertEquals(
    ((updated.audio_files ?? []) as Record<string, unknown>[]).length,
    3,
  );
});
