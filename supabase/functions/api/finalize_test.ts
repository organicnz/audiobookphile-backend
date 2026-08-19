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
) {
  return executeFinalize(makeC(body), {
    supabase,
    storageRouter: { fileExists },
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
  const res = await runFinalize(sb, {
    bookId: "11111111-2222-3333-4444-555555555555",
    title: "Brand New Book",
    library: LIB_ID,
    mediaType: "book",
    files: OK_FILES,
    overwrite: false,
  });
  assertEquals(res.status, 409);
  assertEquals((res.json as { existingId: string }).existingId, existingId);
  assertEquals((sb.tables["library_items"] ?? []).length, 1);
  assertEquals(sb.storageRemoveCalls.length, 1);
  assertEquals(
    sb.storageRemoveCalls[0],
    OK_FILES.map((f) => f.storagePath),
  );
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
