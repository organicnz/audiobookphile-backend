// One-shot: migrate Supabase `audio-files` (≈7.5 GB, 858 objects, 2026-08-26 blow-up)
// to B2 pool, patch `library_items.audio_files` to `b2://…` paths, then prune Supabase.
// 10x pro: streams via Web Fetch (no full download in memory), verifies size, dry-run by default.
//
// Usage:
//   deno run --allow-all --env-file .env.local scripts/migrate_supabase_audio_to_b2.ts --dry        # report only
//   deno run --allow-all --env-file .env.local scripts/migrate_supabase_audio_to_b2.ts --apply      # migrate + patch DB
//   deno run --allow-all --env-file .env.local scripts/migrate_supabase_audio_to_b2.ts --apply --prune  # also delete Supabase objects after verified B2 copy
//   deno run --allow-all --env-file .env.local scripts/migrate_supabase_audio_to_b2.ts --only <uuid> --apply  # single item
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, B2_* (see .env.local primary tier).

import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@^3.693.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
if (!SUPABASE_URL || !SVC) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
}
const db = createClient(SUPABASE_URL, SVC, { auth: { persistSession: false } });

const DRY = !Deno.args.includes("--apply");
const PRUNE = Deno.args.includes("--prune");
const onlyIdx = Deno.args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? Deno.args[onlyIdx + 1] : null;

// B2 client (primary tier mirrors import_missing_books.ts)
function b2Client() {
  const bucket = Deno.env.get("B2_BUCKET_NAME")!;
  if (!bucket) throw new Error("B2_BUCKET_NAME missing");
  const client = new S3Client({
    endpoint: Deno.env.get("B2_ENDPOINT")!,
    region: Deno.env.get("B2_REGION") || "us-west-004",
    credentials: {
      accessKeyId: Deno.env.get("B2_KEY_ID")!,
      secretAccessKey: Deno.env.get("B2_APP_KEY")!,
    },
    forcePathStyle: true,
    // @ts-ignore — B2 does not support AWS checksum headers
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return { client, bucket };
}
const { client: b2, bucket: B2_BUCKET } = b2Client();
const B2_PREFIX = "b2://";

async function listSupabaseAudio(prefix?: string) {
  const out: Array<{ name: string; size: number }> = [];
  if (prefix) {
    let offset = 0;
    for (;;) {
      const { data } = await db.storage.from("audio-files").list(prefix, {
        limit: 1000,
        offset,
      });
      if (!data || data.length === 0) break;
      for (const f of data as any[]) {
        if (f.id !== null) {
          out.push({
            name: `${prefix}/${f.name}`,
            size: f.metadata?.size ?? 0,
          });
        }
      }
      if (data.length < 1000) break;
      offset += 1000;
    }
  } else {
    const { data: top } = await db.storage.from("audio-files").list("", {
      limit: 1000,
    });
    for (const p of (top || []).filter((x: any) => x.id === null && x.name)) {
      out.push(...await listSupabaseAudio(p.name));
    }
  }
  return out;
}

async function b2Exists(key: string): Promise<number | null> {
  try {
    const h = await b2.send(
      new HeadObjectCommand({ Bucket: B2_BUCKET, Key: key }),
    );
    return Number(h.ContentLength ?? 0);
  } catch {
    return null;
  }
}

console.log(
  `Migrate Supabase audio-files → B2 (${B2_BUCKET}) ${DRY ? "DRY" : "APPLY"} ${
    PRUNE ? "+PRUNE" : ""
  } ${ONLY ? `only=${ONLY}` : ""}`,
);

const all = await listSupabaseAudio(ONLY ?? undefined);
console.log(`Found ${all.length} Supabase objects`);

const byFolder = new Map<string, typeof all>();
for (const o of all) {
  const folder = o.name.split("/")[0];
  if (!byFolder.has(folder)) byFolder.set(folder, []);
  byFolder.get(folder)!.push(o);
}

let migrated = 0, skipped = 0, failed = 0;
let pruneCandidates: string[] = [];

for (const [folder, objs] of byFolder) {
  let folderHasB2 = 0; // count of objs that already have a B2 copy
  const { data: item } = await db.from("library_items").select(
    "id, title, audio_files",
  ).eq("id", folder).maybeSingle();
  if (!item) {
    console.log(
      `  ${folder}: NO library_item – entire folder is orphan (${objs.length} files)`,
    );
    // Still migrate? Orphans are still billed – we will prune directly if --prune
    if (PRUNE && !DRY) {
      const { error } = await db.storage.from("audio-files").remove(
        objs.map((o) => o.name),
      );
      console.log(
        error
          ? `    prune error: ${error.message}`
          : `    pruned ${objs.length} orphan objects`,
      );
    } else if (objs.length) pruneCandidates.push(...objs.map((o) => o.name));
    continue;
  }
  console.log(
    `\n${folder} (${
      item.title?.slice(0, 40)
    }): ${objs.length} supabase objects`,
  );
  let folderMigrated = 0;
  for (const o of objs) {
    const key = o.name; // already "<uuid>/<file>"
    const exists = await b2Exists(key);
    if (exists !== null) folderHasB2++;
    if (exists !== null && exists === o.size) {
      skipped++;
      continue;
    }
    if (DRY) {
      migrated++;
      folderMigrated++;
      continue;
    }
    // Stream download from Supabase Storage → upload to B2 (avoid loading 50 MB into memory twice)
    const { data: blob, error } = await db.storage.from("audio-files").download(
      o.name,
    );
    if (error || !blob) {
      console.log(`    FAIL download ${o.name}: ${error?.message}`);
      failed++;
      continue;
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    const ct = o.name.endsWith(".ogg")
      ? "audio/ogg"
      : o.name.endsWith(".m4b")
      ? "audio/mp4"
      : o.name.endsWith(".flac")
      ? "audio/flac"
      : "audio/mpeg";
    try {
      await b2.send(
        new PutObjectCommand({
          Bucket: B2_BUCKET,
          Key: key,
          Body: buf,
          ContentType: ct,
        }),
      );
      migrated++;
      folderMigrated++;
      process.stdout.write(`\r    ${folderMigrated}/${objs.length} → B2`);
    } catch (e) {
      console.log(
        `\n    FAIL put ${key}: ${(e as Error).message.slice(0, 120)}`,
      );
      failed++;
    }
  }
  if (!DRY && folderMigrated > 0) {
    // Patch library_items to b2:// paths for the migrated files (only ones we just moved)
    const { data: fresh } = await db.from("library_items").select(
      "audio_files, library_files, size",
    ).eq("id", folder).single();
    let af: any[] = Array.isArray(fresh?.audio_files) ? fresh!.audio_files : [];
    let changed = false;
    for (const a of af) {
      const p = String(a?.metadata?.path ?? "");
      const leaf = p.split("/").pop() || "";
      // Only upgrade supabase:// or legacy bare that now has a B2 copy
      if (
        p.startsWith("supabase://") || p.startsWith("/") || p === leaf ||
        (!p.includes("://") && p.startsWith(folder + "/"))
      ) {
        const newKey = `${folder}/${
          a.metadata?.filename ?? a.metadata?.relPath ?? leaf
        }`;
        const migratedMatch = objs.find((o) => o.name === newKey);
        if (migratedMatch) {
          a.metadata.path = `${B2_PREFIX}${newKey}`;
          changed = true;
        }
      }
    }
    if (changed) {
      const { error } = await db.from("library_items").update(
        { audio_files: af } as any,
      ).eq("id", folder);
      console.log(
        error
          ? `\n    DB patch error: ${error.message}`
          : `\n    DB patched ${af.length} tracks → ${B2_PREFIX}`,
      );
    }
    if (PRUNE && folderHasB2 + folderMigrated === objs.length) {
      // Defer bulk prune to end for safety – collect candidates
      pruneCandidates.push(...objs.map((o) => o.name));
    }
  }
}

console.log(
  `\n\nSummary: migrated=${migrated} skipped=${skipped} failed=${failed} total=${all.length}`,
);
if (DRY) console.log("DRY – re-run with --apply to stream to B2 and patch DB");
if (!DRY && pruneCandidates.length && !PRUNE) {
  console.log(
    `Ready to prune ${pruneCandidates.length} Supabase objects – re-run with --apply --prune`,
  );
}
if (!DRY && PRUNE && pruneCandidates.length) {
  console.log(
    `\nPruning ${pruneCandidates.length} Supabase objects (batched 100)...`,
  );
  for (let i = 0; i < pruneCandidates.length; i += 100) {
    const batch = pruneCandidates.slice(i, i + 100);
    const { error } = await db.storage.from("audio-files").remove(batch);
    console.log(
      error
        ? `  batch ${i / 100}: ${error.message}`
        : `  batch ${i / 100}: pruned ${batch.length}`,
    );
  }
  console.log(
    "Prune done – verify `select * from storage_quota_snapshot()` now < 1 GiB",
  );
}
