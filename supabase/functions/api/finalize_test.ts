import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { executeFinalize } from "./routes/downloads.ts";

type Row = Record<string, unknown> & { id: string };

class MockQuery {
  private filters: { col: string; val: unknown }[] = [];
  private orExpr = "";
  private limitN: number | null = null;
  private pendingWrite: {
    kind: "update" | "delete";
    patch?: Record<string, unknown>;
  } | null = null;

  constructor(
    private table: Row[],
    private patchLog: Record<string, unknown>[],
  ) {}

  select(_cols: string): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }

  or(expr: string): this {
    this.orExpr = expr;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private matches(row: Row): boolean {
    for (const f of this.filters) {
      if (row[f.col] !== f.val) return false;
    }
    if (this.orExpr) {
      const ok = this.orExpr.split(",").some((part) => {
        const m = part.trim().match(/^(\w+)\.eq\.(.+)$/);
        if (!m) return false;
        return row[m[1]] === m[2];
      });
      if (!ok) return false;
    }
    return true;
  }

  private apply(): Row[] {
    const rows = this.table.filter((r) => this.matches(r));
    return this.limitN !== null ? rows.slice(0, this.limitN) : rows;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.apply()[0] ?? null, error: null };
  }

  update(patch: Record<string, unknown>): this {
    this.pendingWrite = { kind: "update", patch };
    return this;
  }

  delete(): this {
    this.pendingWrite = { kind: "delete" };
    return this;
  }

  then(
    resolve: (v: { data: Row[] | null; error: null }) => void,
    reject: (e: unknown) => void,
  ): Promise<void> {
    let value: { data: Row[] | null; error: null };
    try {
      if (!this.pendingWrite) {
        value = { data: this.apply(), error: null };
      } else {
        const { kind, patch } = this.pendingWrite;
        if (kind === "update") {
          for (const row of this.apply()) {
            Object.assign(row, JSON.parse(JSON.stringify(patch)));
          }
          this.patchLog.push(patch!);
          value = { data: this.apply(), error: null };
        } else {
          const doomed = new Set(this.apply().map((r) => r.id));
          for (let i = this.table.length - 1; i >= 0; i--) {
            if (doomed.has(this.table[i].id)) this.table.splice(i, 1);
          }
          value = { data: [], error: null };
        }
      }
      resolve(value);
    } catch (e) {
      reject(e);
    }
    return Promise.resolve();
  }

  async insert(rows: Row | Row[]): Promise<{ error: null }> {
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      this.table.push(JSON.parse(JSON.stringify(r)));
    }
    return { error: null };
  }

  async upsert(
    rows: Row | Row[],
    _opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): Promise<{ error: null }> {
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      const existing = this.table.find((x) => x.id === r.id);
      if (existing) {
        Object.assign(existing, JSON.parse(JSON.stringify(r)));
      } else {
        this.table.push(JSON.parse(JSON.stringify(r)));
      }
    }
    return { error: null };
  }
}

class MockSupabase {
  tables: Record<string, Row[]>;
  patchLog: Record<string, unknown>[] = [];
  storageRemoveCalls: string[][] = [];

  constructor(tables: Record<string, Row[]>) {
    this.tables = tables;
  }

  from(table: string): MockQuery {
    this.tables[table] ??= [];
    return new MockQuery(this.tables[table], this.patchLog);
  }

  get storage() {
    return {
      from: (_bucket: string) => ({
        remove: async (paths: string[]) => {
          this.storageRemoveCalls.push(paths);
          return { error: null };
        },
      }),
    };
  }
}

function makeC(body: unknown): any {
  return {
    get: (key: string) => key === "user" ? { id: "test-user" } : null,
    req: {
      json: async () => {
        if (body === "__INVALID_JSON__") {
          throw new SyntaxError("Unexpected token");
        }
        return body;
      },
    },
  };
}

const LIB_ID = "207ad239-f42e-40dd-b9b2-d71054cb36f0";
const OK_FILES = [
  {
    name: "Chapter 01.mp3",
    size: 12347,
    type: "audio/mpeg",
    storagePath: "b2-tertiary://book-1/Chapter 01.mp3",
  },
  {
    name: "Chapter 02.mp3",
    size: 12347,
    type: "audio/mpeg",
    storagePath: "b2-tertiary://book-1/Chapter 02.mp3",
  },
];

function runFinalize(
  supabase: MockSupabase,
  body: unknown,
  fileExists: (path: string) => Promise<boolean> = async () => true,
  deletedPaths: string[] = [],
) {
  return executeFinalize(makeC(body), {
    supabase,
    // Audio is B2-only: orphan cleanup goes through deletePath (B2 delete),
    // never supabase.storage.from("audio-files").remove.
    storageRouter: {
      fileExists,
      deletePath: async (p: string) => {
        deletedPaths.push(p);
        return true;
      },
    },
  });
}

Deno.test("finalize: invalid JSON returns 400", async () => {
  const sb = new MockSupabase({});
  const res = await runFinalize(sb, "__INVALID_JSON__");
  assertEquals(res.status, 400);
  assertEquals(res.json, { error: "Invalid JSON" });
});

Deno.test("finalize: missing library fails zod validation with 400", async () => {
  const sb = new MockSupabase({});
  const res = await runFinalize(sb, {
    title: "Some Book",
    files: OK_FILES,
  });
  assertEquals(res.status, 400);
  assertEquals((res.json as { error: string }).error, "Validation error");
});

Deno.test("finalize: files missing in storage returns 400", async () => {
  const sb = new MockSupabase({});
  const res = await runFinalize(
    sb,
    {
      title: "Some Book",
      library: LIB_ID,
      mediaType: "book",
      files: OK_FILES,
    },
    async () => false,
  );
  assertEquals(res.status, 400);
  assertEquals(
    (res.json as { error: string }).error,
    "Files missing in storage",
  );
});

Deno.test("finalize: NEW book creates a library_items row (regression: inserts were silently skipped)", async () => {
  const sb = new MockSupabase({});
  const res = await runFinalize(sb, {
    bookId: "11111111-2222-3333-4444-555555555555",
    title: "Brand New Book",
    library: LIB_ID,
    mediaType: "book",
    files: OK_FILES,
    overwrite: false,
  });
  assertEquals(res.status, 200);
  const items = sb.tables["library_items"] ?? [];
  assertEquals(items.length, 1);
  assertEquals(
    items[0].id,
    (res.json as { libraryItemId: string }).libraryItemId,
  );
  assertEquals(items[0].title, "Brand New Book");
  assertEquals(items[0].media_id, "11111111-2222-3333-4444-555555555555");
  assertEquals(items[0].library_id, LIB_ID);
  assertEquals((items[0].audio_files as unknown[]).length, 2);
  const secondUpdate = sb.patchLog.find((p) => "library_files" in p);
  assertEquals((secondUpdate?.library_files as unknown[]).length, 2);
});

Deno.test("finalize: duplicate book with overwrite=false returns 409 and cleans up orphan files", async () => {
  const existingId = "existing-item-1";
  const sb = new MockSupabase({
    library_items: [{
      id: existingId,
      media_id: "99999999-0000-0000-0000-000000000000",
      title: "Brand New Book",
      library_id: LIB_ID,
      audio_files: [],
      library_files: [],
      size: 0,
      duration: 0,
    }],
  });
  const deletedPaths: string[] = [];
  const res = await runFinalize(
    sb,
    {
      bookId: "11111111-2222-3333-4444-555555555555",
      title: "Brand New Book",
      library: LIB_ID,
      mediaType: "book",
      files: OK_FILES,
      overwrite: false,
    },
    async () => true,
    deletedPaths,
  );
  assertEquals(res.status, 409);
  assertEquals((res.json as { existingId: string }).existingId, existingId);
  assertEquals((sb.tables["library_items"] ?? []).length, 1);
  // Audio is B2-only: orphans are deleted via StorageRouter.deletePath (B2),
  // never via Supabase audio-files bucket (covers/light only).
  assertEquals(deletedPaths, OK_FILES.map((f) => f.storagePath));
  assertEquals(sb.storageRemoveCalls.length, 0);
});

Deno.test("finalize: duplicate book with overwrite=true rebinds to existing record and merges files", async () => {
  const existingId = "existing-item-1";
  const sb = new MockSupabase({
    library_items: [{
      id: existingId,
      media_id: "11111111-2222-3333-4444-555555555555",
      title: "Brand New Book",
      library_id: LIB_ID,
      audio_files: [{
        index: 1,
        metadata: { filename: "Chapter 01.mp3", path: "old/path" },
      }],
      library_files: [{
        metadata: { filename: "Chapter 01.mp3", path: "old/path" },
      }],
      size: 100,
      duration: 0,
    }],
  });
  const res = await runFinalize(sb, {
    bookId: "11111111-2222-3333-4444-555555555555",
    title: "Brand New Book",
    library: LIB_ID,
    mediaType: "book",
    files: OK_FILES,
    overwrite: true,
  });
  assertEquals(res.status, 200);
  assertEquals(
    (res.json as { libraryItemId: string }).libraryItemId,
    existingId,
  );
  const item = (sb.tables["library_items"] ?? [])[0];
  assertEquals(item.id, existingId);
  const files = item.audio_files as any[];
  assertEquals(files.length, 2); // Chapter 01 merged (dedup), Chapter 02 added
  const ch1 = files.find((f: any) => f.metadata.filename === "Chapter 01.mp3");
  assertEquals(ch1.metadata.path, "b2-tertiary://book-1/Chapter 01.mp3");
  assertEquals(item.size, 100 + 12347 * 2);
});

Deno.test("finalize: author metadata upserts authors and book_authors", async () => {
  const sb = new MockSupabase({});
  const res = await runFinalize(sb, {
    bookId: "11111111-2222-3333-4444-555555555555",
    title: "Authored Book",
    author: "Jane Doe",
    library: LIB_ID,
    mediaType: "book",
    files: OK_FILES,
    overwrite: false,
  });
  assertEquals(res.status, 200);
  const authors = sb.tables["authors"] ?? [];
  assertEquals(authors.length, 1);
  assertEquals(authors[0].name, "Jane Doe");
  const links = sb.tables["book_authors"] ?? [];
  assertEquals(links.length, 1);
  assertEquals(links[0].author_id, authors[0].id);
});

Deno.test("finalize: series metadata upserts series and book_series", async () => {
  const sb = new MockSupabase({});
  const res = await runFinalize(sb, {
    bookId: "11111111-2222-3333-4444-555555555555",
    title: "Series Book",
    author: "Jane Doe",
    series: "Epic Saga",
    library: LIB_ID,
    mediaType: "book",
    files: OK_FILES,
    overwrite: false,
  });
  assertEquals(res.status, 200);
  const seriesRows = sb.tables["series"] ?? [];
  assertEquals(seriesRows.length, 1);
  assertEquals(seriesRows[0].name, "Epic Saga");
  const links = sb.tables["book_series"] ?? [];
  assertEquals(links.length, 1);
  assertEquals(links[0].series_id, seriesRows[0].id);
});

Deno.test("finalize: same bookId re-upload with overwrite=false is rejected with 409 once a row exists (regression: silently returned 200 before)", async () => {
  const sb = new MockSupabase({});
  const first = await runFinalize(sb, {
    bookId: "11111111-2222-3333-4444-555555555555",
    title: "Dedup Book",
    library: LIB_ID,
    mediaType: "book",
    files: OK_FILES,
    overwrite: false,
  });
  assertEquals(first.status, 200);
  const items = sb.tables["library_items"] ?? [];
  assertEquals(items.length, 1);
  assertEquals((items[0].audio_files as unknown[]).length, 2);

  const second = await runFinalize(sb, {
    bookId: "11111111-2222-3333-4444-555555555555",
    title: "Dedup Book",
    library: LIB_ID,
    mediaType: "book",
    files: OK_FILES,
    overwrite: false,
  });
  assertEquals(second.status, 409);
  assertEquals(items.length, 1);
});

Deno.test("finalize: batch spanning two books with colliding chapter names is rejected with MULTIPLE_WORKS_DETECTED", async () => {
  // Dark Psychology class: 4 books sharing "Chapter N.mp3" must never merge.
  const sb = new MockSupabase({});
  const darkId = "22222222-3333-4444-5555-666666666666";
  const res = await runFinalize(sb, {
    bookId: darkId,
    title: "Dark Psychology Audiobook Collection",
    library: LIB_ID,
    mediaType: "book",
    files: [
      {
        name: "Chapter 1.mp3",
        size: 1000,
        type: "audio/mpeg",
        storagePath: `b2-test://${darkId}/Daniel Pratt/Chapter 1.mp3`,
      },
      {
        name: "Chapter 1.mp3",
        size: 1100,
        type: "audio/mpeg",
        storagePath: `b2-test://${darkId}/Deborah Weiss/Chapter 1.mp3`,
      },
    ],
    overwrite: false,
  });
  assertEquals(res.status, 400);
  assertEquals(
    (res.json as { code: string }).code,
    "MULTIPLE_WORKS_DETECTED",
  );
  const splits = (res.json as { splits: { folder: string }[] }).splits;
  assertEquals(splits.length, 2);
  assertEquals(
    (res.json as { collidingFiles: string[] }).collidingFiles,
    ["chapter 1.mp3"],
  );
  // Gate fires before any write: no row is created.
  assertEquals((sb.tables["library_items"] ?? []).length, 0);
});

Deno.test("finalize: multi-disc batch with same basenames is kept as distinct tracks", async () => {
  const sb = new MockSupabase({});
  const discId = "33333333-4444-5555-6666-777777777777";
  const discFiles = [
    "Disc 1/Track 01.mp3",
    "Disc 1/Track 02.mp3",
    "Disc 2/Track 01.mp3",
    "Disc 2/Track 02.mp3",
  ].map((rel) => ({
    name: rel.split("/").pop()!,
    size: 2000,
    type: "audio/mpeg",
    storagePath: `b2-test://${discId}/${rel}`,
  }));
  const res = await runFinalize(sb, {
    bookId: discId,
    title: "Two Disc Book",
    library: LIB_ID,
    mediaType: "book",
    files: discFiles,
    overwrite: false,
  });
  assertEquals(res.status, 200);
  const item = (sb.tables["library_items"] ?? [])[0];
  const rows = item.audio_files as any[];
  assertEquals(rows.length, 4);
  assertEquals(
    rows.map((r: any) => r.metadata.relPath).sort(),
    [
      "Disc 1/Track 01.mp3",
      "Disc 1/Track 02.mp3",
      "Disc 2/Track 01.mp3",
      "Disc 2/Track 02.mp3",
    ],
  );
  // Folder-aware sort: Disc 1 precedes Disc 2.
  assertEquals(rows[0].metadata.relPath.startsWith("Disc 1"), true);
  assertEquals(rows[2].metadata.relPath.startsWith("Disc 2"), true);
  const warnings = (res.json as { warnings?: { code: string }[] }).warnings ??
    [];
  assertEquals(
    warnings.some((w) => w.code === "MULTI_FOLDER_BATCH"),
    true,
  );
});

Deno.test("finalize: structured re-upload of a flat book rebinds by basename without doubling tracks", async () => {
  const bookUuid = "44444444-5555-6666-7777-888888888888";
  const sb = new MockSupabase({
    library_items: [{
      id: "existing-item-2",
      media_id: bookUuid,
      title: "Structured Book",
      library_id: LIB_ID,
      audio_files: [{
        index: 1,
        duration: 60,
        metadata: {
          filename: "Chapter 01.mp3",
          relPath: "Chapter 01.mp3",
          path: "old/path",
        },
      }],
      library_files: [],
      size: 100,
      duration: 60,
    }],
  });
  const res = await runFinalize(sb, {
    bookId: bookUuid,
    title: "Structured Book",
    library: LIB_ID,
    mediaType: "book",
    files: [
      {
        name: "Chapter 01.mp3",
        size: 1234,
        type: "audio/mpeg",
        storagePath: `b2-test://${bookUuid}/Disc 1/Chapter 01.mp3`,
      },
      {
        name: "Chapter 02.mp3",
        size: 1234,
        type: "audio/mpeg",
        storagePath: `b2-test://${bookUuid}/Disc 1/Chapter 02.mp3`,
      },
    ],
    overwrite: true,
  });
  assertEquals(res.status, 200);
  const item = (sb.tables["library_items"] ?? [])[0];
  const rows = item.audio_files as any[];
  assertEquals(rows.length, 2);
  const ch1 = rows.find((r: any) => r.metadata.filename === "Chapter 01.mp3");
  // Adopts the fresh structured path while preserving the proven duration.
  assertEquals(
    ch1.metadata.path,
    `b2-test://${bookUuid}/Disc 1/Chapter 01.mp3`,
  );
  assertEquals(ch1.duration, 60);
  assertEquals(item.duration, 60);
});

Deno.test("finalize: path traversal segments in storage keys are neutralized in recorded relPath", async () => {
  const sb = new MockSupabase({});
  const travId = "55555555-6666-7777-8888-999999999999";
  const res = await runFinalize(sb, {
    bookId: travId,
    title: "Traversal Book",
    library: LIB_ID,
    mediaType: "book",
    files: [{
      name: "evil.mp3",
      size: 100,
      type: "audio/mpeg",
      storagePath: `b2-test://${travId}/../../evil.mp3`,
    }],
    overwrite: false,
  });
  assertEquals(res.status, 200);
  const rows = ((sb.tables["library_items"] ?? [])[0].audio_files) as any[];
  assertEquals(rows[0].metadata.relPath, "evil.mp3");
  // Recorded identity is traversal-free (the verbatim storagePath in
  // metadata.path is untouched — the object genuinely lives at that key).
  assertEquals(rows[0].metadata.relPath.includes(".."), false);
});
