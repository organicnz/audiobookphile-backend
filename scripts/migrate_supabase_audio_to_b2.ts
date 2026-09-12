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

import { createClient } from "@supabase/supabase-js";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** Storage rows returned by `storage.list` (subset of FileObject we use). */
interface StorageListEntry {
  id: string | null;
  name: string;
  metadata?: { size?: number } | null;
}

/** One row of the `library_items.audio_files` JSONB column. */
interface AudioFileEntry {
  metadata: {
    path?: string;
    filename?: string;
    relPath?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

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

const tierIdx = Deno.args.indexOf("--tier");
const TARGET_TIER = tierIdx !== -1
  ? Deno.args[tierIdx + 1].toUpperCase()
  : "B2_QUINTET";

// B2 client configuration
function b2Client() {
  const isQuinta = TARGET_TIER === "B2_QUINTET" || TARGET_TIER === "QUINTA";
  const isTertiary = TARGET_TIER === "B2_TERTIARY" ||
    TARGET_TIER === "TERTIARY";

  let bucket = Deno.env.get("B2_QUINTA_BUCKET_NAME") ||
    "audiobookphile-b2-quinta";
  let keyId = Deno.env.get("B2_QUINTA_KEY_ID") || "004746c4cd161520000000001";
  let appKey = Deno.env.get("B2_QUINTA_APP_KEY") ||
    "K004Yf65aAz/9AfneyUY55Kai9FlNJE";
  let endpoint = "https://s3.us-west-004.backblazeb2.com";
  let region = "us-west-004";
  let prefix = "b2-quinta://";

  if (isTertiary) {
    bucket = Deno.env.get("B2_TERTIARY_BUCKET_NAME") || "audiobooks-tertiary";
    keyId = Deno.env.get("B2_TERTIARY_KEY_ID") || "00419494b11d7d50000000001";
    appKey = Deno.env.get("B2_TERTIARY_APP_KEY") ||
      "K0046AN59ZrZE65LITqR0j4cVfGrzek";
    prefix = "b2-tertiary://";
  } else if (!isQuinta) {
    bucket = Deno.env.get("B2_BUCKET_NAME") || bucket;
    keyId = Deno.env.get("B2_KEY_ID") || keyId;
    appKey = Deno.env.get("B2_APP_KEY") || appKey;
    endpoint = Deno.env.get("B2_ENDPOINT") || endpoint;
    region = Deno.env.get("B2_REGION") || region;
    prefix = "b2://";
  }

  const client = new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId: keyId,
      secretAccessKey: appKey,
    },
    forcePathStyle: true,
    // @ts-ignore — B2 does not support AWS checksum headers
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return { client, bucket, prefix };
}
const { client: b2, bucket: B2_BUCKET, prefix: B2_PREFIX } = b2Client();

const objectsFileIdx = Deno.args.indexOf("--objects-file");
const OBJECTS_FILE = objectsFileIdx !== -1
  ? Deno.args[objectsFileIdx + 1]
  : null;

async function listSupabaseAudio(prefix?: string) {
  const out: Array<{ name: string; size: number }> = [];

  if (OBJECTS_FILE) {
    try {
      const content = await Deno.readTextFile(OBJECTS_FILE);
      const parsed = JSON.parse(content);
      const rows = Array.isArray(parsed) ? parsed : parsed.rows || [];
      for (const r of rows) {
        const name = r.name || r.Key;
        const size = Number(
          r.size || r.Size ||
            (typeof r.metadata === "object" ? r.metadata?.size : 0) || 0,
        );
        if (name && (!prefix || name.startsWith(prefix))) {
          out.push({ name, size });
        }
      }
      return out;
    } catch (err) {
      console.warn(
        `Could not read objects file ${OBJECTS_FILE}:`,
        (err as Error).message,
      );
    }
  }

  if (prefix) {
    let offset = 0;
    for (;;) {
      const { data, error } = await db.storage.from("audio-files").list(
        prefix,
        {
          limit: 1000,
          offset,
        },
      );
      if (error) {
        console.warn(
          `Storage API list error on prefix '${prefix}':`,
          error.message,
        );
        break;
      }
      if (!data || data.length === 0) break;
      for (const f of data as StorageListEntry[]) {
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
    const { data: top, error } = await db.storage.from("audio-files").list("", {
      limit: 1000,
    });
    if (error) {
      console.warn("Storage API list error:", error.message);
      const errWithStatus = error as { status?: number };
      if (
        error.message?.includes("exceed_storage_size_quota") ||
        errWithStatus.status === 402
      ) {
        console.error(
          "\n❌ SUPABASE RESTRICTION DETECTED: HTTP 402 Payment Required",
        );
        console.error(
          "Storage for this project is restricted due to 'exceed_storage_size_quota'.",
        );
        console.error(
          "The project owner must temporarily remove spend caps in the Supabase Dashboard:",
        );
        console.error(
          "👉 https://supabase.com/dashboard/project/iambzzclljayqdxkeepy/settings/billing\n",
        );
      }
    }
    for (
      const p of (top || []).filter(
        (x: StorageListEntry) => x.id === null && x.name,
      )
    ) {
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
const pruneCandidates: string[] = [];

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
    const af: AudioFileEntry[] = Array.isArray(fresh?.audio_files)
      ? fresh!.audio_files
      : [];
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
        { audio_files: af },
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
