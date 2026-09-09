// Bulk-import or single-import library books from a source directory tree into B2.
// Supabase `audio-files` is legacy and capped at 10 MiB per file (see 20260830000000_storage_hardening.sql).
// All audio MUST go to B2 via presigned S3 or PutObject.
//
// 10x Pro Improvements:
//   - Single config source: imports getConfig and isTierConfigured from b2-config.ts
//   - Dynamic targets: --item-id <uuid>, --title <title>, or --auto-match
//   - Real duration extraction via music-metadata
//   - Overwrites stale b2-*:// / supabase:// paths with new canonical URI
//   - Updates library_items.duration and size
//   - Resumable: skips existing B2 objects with matching size
//   - Dry-run by default, --apply writes
//
// Usage:
//   # 1. Single book import (point directly at folder of .mp3 files):
//   deno run --allow-all --env-file=env/local.env scripts/import_missing_books.ts "/path/to/21 Lessons" --item-id 788c1e1d-cd44-4169-8b55-0347d1796a63 [--apply] [--b2-tier B2|B2_SECONDARY|B2_TERTIARY|B2_QUARTET|B2_QUINTET]
//
//   # 2. Single book by title search:
//   deno run --allow-all --env-file=env/local.env scripts/import_missing_books.ts "/path/to/21 Lessons" --title "21 Lessons" [--apply]
//
//   # 3. Auto-match all subfolders in a library tree against database items:
//   deno run --allow-all --env-file=env/local.env scripts/import_missing_books.ts "/path/to/library_root" --auto-match [--apply]
//
//   # 4. Built-in plan scan:
//   deno run --allow-all --env-file=env/local.env scripts/import_missing_books.ts "/path/to/library_root" [--apply]

import { createClient } from "@supabase/supabase-js";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { parseBuffer } from "music-metadata";

import {
  BUCKET_Tiers,
  getConfig,
  isTierConfigured,
} from "../supabase/functions/_shared/b2-config.ts";
import { BucketTier } from "../supabase/functions/_shared/b2-types.ts";
import { tierToPrefix } from "../supabase/functions/_shared/storage-router.ts";

const URL_BASE = Deno.env.get("SUPABASE_URL") ||
  Deno.env.get("NEXT_PUBLIC_SUPABASE_URL") || "";
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_KEY") || "";

if (!URL_BASE || !SVC) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in environment",
  );
}
const db = createClient(URL_BASE, SVC, { auth: { persistSession: false } });

// CLI flags
const args = Deno.args;
const APPLY = args.includes("--apply");
const AUTO_MATCH = args.includes("--auto-match");

const itemIdIdx = args.indexOf("--item-id") !== -1
  ? args.indexOf("--item-id")
  : args.indexOf("--book-id");
const TARGET_ITEM_ID = itemIdIdx !== -1 ? args[itemIdIdx + 1] : null;

const titleIdx = args.indexOf("--title");
const TARGET_TITLE = titleIdx !== -1 ? args[titleIdx + 1] : null;

const tierIdx = args.indexOf("--b2-tier");
const rawTier =
  (tierIdx !== -1
    ? args[tierIdx + 1]
    : (Deno.env.get("ACTIVE_B2_TIER") || "B2")).toUpperCase();
const B2_TIER: BucketTier =
  (BUCKET_Tiers as readonly string[]).includes(rawTier)
    ? (rawTier as BucketTier)
    : "B2";

const positionalArgs = args.filter((a, i) => {
  if (a.startsWith("-")) return false;
  const prev = args[i - 1];
  if (
    prev &&
    ["--item-id", "--book-id", "--title", "--b2-tier", "--dir"].includes(prev)
  ) {
    return false;
  }
  return true;
});

const dirIdx = args.indexOf("--dir");
const SOURCE_ROOT = dirIdx !== -1 ? args[dirIdx + 1] : positionalArgs[0];

if (!SOURCE_ROOT) {
  console.error(
    "Usage: deno run --allow-all scripts/import_missing_books.ts <sourcePath> [options]",
  );
  console.error(
    "Options: --apply, --item-id <uuid>, --title <string>, --auto-match, --b2-tier <tier>",
  );
  Deno.exit(1);
}

const AUDIO = [
  ".mp3",
  ".m4b",
  ".m4a",
  ".ogg",
  ".flac",
  ".wav",
  ".aac",
  ".opus",
];

const PLAN: Array<{ dir: string; titleLike: string }> = [
  {
    dir: "21 Lessons for the 21st Century - Yuval Noah Harari (Unabridged)",
    titleLike: "21 Lessons for the 21st Century",
  },
  {
    dir: "Yuval Noah Harari/21 Lessons for the 21st Century",
    titleLike: "21 Lessons for the 21st Century",
  },
  {
    dir:
      "Christopher HItchens/Christopher Hitchens - Mortality [96] Unabridged",
    titleLike: "Mortality",
  },
  {
    dir:
      "[Audiobook] Carl Sagan - The Demon-Haunted World - Science as a Candle in the Dark",
    titleLike: "Demon-Haunted World",
  },
  {
    dir: "Isaac Asimov/Book 1 - Foundation",
    titleLike: "Isaac Asimov Foundation",
  },
  {
    dir:
      "Christopher HItchens/Christopher Hitchens The Missionary Position - Mother Teresa in Theory and Practice",
    titleLike: "Mother Teresa",
  },
  {
    dir: "Christopher HItchens/Christopher Hitchens - God Is Not Great",
    titleLike: "God is Not Great",
  },
  {
    dir: "Christopher HItchens/Christopher Hitchens - Hitch-22",
    titleLike: "Hitch-22",
  },
  {
    dir:
      "Blockchain The Complete Guide to Uncovering Bitcoin, Cryptocurrency, Bitcoin Technology and the Future of Money",
    titleLike: "Blockchain",
  },
  { dir: "Eat and Run [bobpocket]", titleLike: "Eat and Run" },
  {
    dir: "Afua Hirsch - 2020 - We Need to Talk About the British Empire",
    titleLike: "We Need to Talk About",
  },
  {
    dir: "The Magic of Reality - Richard Dawkins",
    titleLike: "Magic of Reality",
  },
  {
    dir:
      "Critical Thinking How to Effectively Reason, Understand Irrationality, and Make Better Decisions",
    titleLike: "Critical Thinking How to",
  },
  {
    dir: "Eugenia Cheng - The Art of Logic in an Illogical World",
    titleLike: "Art of Logic",
  },
  {
    dir: "What They Don't Teach You at Harvard Business School - 1",
    titleLike: "Harvard Business School",
  },
  { dir: "The Willpower Instinct", titleLike: "Willpower Instinct" },
  {
    dir:
      "Talking to Strangers What We Should Know About the People We Don’t Know Malcom Gladwell",
    titleLike: "Talking to Strangers",
  },
  {
    dir: "Eric Silberstein - 2021 - The Insecure Mind of Sergei Kraev (Sci-Fi)",
    titleLike: "Insecure Mind",
  },
  { dir: "DK - How Money Works", titleLike: "How Money Works" },
  {
    dir: "When the Body Says No - The Cost of Hidden Stress - Gabor Mate",
    titleLike: "When the Body Says No",
  },
  { dir: "Brief Candle in the Dark", titleLike: "Brief Candle" },
  { dir: "Andy Weir - Project Hail Mary", titleLike: "Project Hail Mary" },
  {
    dir:
      "Walter Isaacson - Steve Jobs - 2011 (unabridged) - Collectors edition",
    titleLike: "Steve Jobs",
  },
  {
    dir: "Walter Isaacson - 2023 - Elon Musk (Biography)",
    titleLike: "Elon Musk",
  },
  {
    dir: "Letters to a Young Contrarian",
    titleLike: "Letters to a Young Contrarian",
  },
  { dir: "Arguably Essays by Christopher Hitchens", titleLike: "Arguably" },
  {
    dir: "BBC Classics Ultimate Story Collection 90 Unmissable Tales",
    titleLike: "BBC Classics",
  },
  {
    dir: "The God Delusion and God is Not Great -on one CD",
    titleLike: "God Delusion",
  },
];

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function itemIdFor(
  titleLike: string,
): Promise<{ id: string; title: string } | null> {
  const want = normKey(titleLike);
  const probe = `%${titleLike.slice(0, 20)}%`;
  const { data } = await db
    .from("library_items")
    .select("id,title")
    .ilike("title", probe)
    .limit(25);

  if (!data?.length) return null;
  const hit = data.find((r) =>
    normKey(r.title).includes(want.slice(0, 12)) ||
    want.includes(normKey(r.title))
  );
  return hit ?? data[0];
}

// B2 Client Initialization using b2-config.ts single source of truth
if (!isTierConfigured(B2_TIER)) {
  console.error(`B2 Tier "${B2_TIER}" is not configured in environment!`);
  Deno.exit(1);
}

const config = getConfig(B2_TIER);
const b2 = new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  credentials: {
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
  },
  forcePathStyle: true,
  // @ts-ignore: S3Client checksum options exist at runtime; the pinned SDK types lag behind
  requestChecksumCalculation: "WHEN_REQUIRED",
  // @ts-ignore: S3Client checksum options exist at runtime; the pinned SDK types lag behind
  responseChecksumValidation: "WHEN_REQUIRED",
});

const B2_BUCKET = config.bucketName;
const B2_PREFIX = tierToPrefix(B2_TIER);

async function b2HeadExists(key: string): Promise<number | null> {
  try {
    const out = await b2.send(
      new HeadObjectCommand({ Bucket: B2_BUCKET, Key: key }),
    );
    return Number(out.ContentLength ?? 0);
  } catch {
    return null;
  }
}

async function walkAudio(dir: string): Promise<
  Array<{ path: string; name: string; size: number }>
> {
  const out: Array<{ path: string; name: string; size: number }> = [];
  const seen = new Set<string>();

  async function rec(d: string) {
    try {
      for await (const e of Deno.readDir(d)) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory && !e.name.startsWith(".")) {
          await rec(p);
        } else if (
          e.isFile &&
          !e.name.startsWith("._") &&
          AUDIO.some((x) => e.name.toLowerCase().endsWith(x))
        ) {
          const key = e.name.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (seen.has(key)) continue;
          seen.add(key);
          let size = 0;
          try {
            size = (await Deno.stat(p)).size;
          } catch {
            continue;
          }
          out.push({ path: p, name: e.name, size });
        }
      }
    } catch (err) {
      console.warn(
        `Could not read dir "${d}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  await rec(dir);
  // Sort naturally by filename
  out.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
  return out;
}

interface ImportTarget {
  dirPath: string;
  itemId: string;
  bookTitle: string;
}

/// One row of the `library_items.audio_files` JSONB column. `metadata` is
/// required here because this script normalizes every entry on write; rows
/// read back from the DB always carry it.
interface LibraryFileEntry {
  index?: number;
  ino?: string;
  duration?: number;
  codec?: string;
  mimeType?: string;
  addedAt?: number;
  updatedAt?: number;
  metadata: {
    filename?: string;
    relPath?: string;
    path?: string;
    size?: number;
    duration?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function collectTargets(): Promise<ImportTarget[]> {
  const targets: ImportTarget[] = [];

  // Mode 1: Targeted Item ID
  if (TARGET_ITEM_ID) {
    const { data: item } = await db
      .from("library_items")
      .select("id, title")
      .eq("id", TARGET_ITEM_ID)
      .single();

    if (!item) {
      throw new Error(`Item with ID ${TARGET_ITEM_ID} not found in database.`);
    }
    targets.push({
      dirPath: SOURCE_ROOT,
      itemId: item.id,
      bookTitle: item.title,
    });
    return targets;
  }

  // Mode 2: Targeted Title
  if (TARGET_TITLE) {
    const hit = await itemIdFor(TARGET_TITLE);
    if (!hit) {
      throw new Error(`No book found matching title "${TARGET_TITLE}".`);
    }
    targets.push({
      dirPath: SOURCE_ROOT,
      itemId: hit.id,
      bookTitle: hit.title,
    });
    return targets;
  }

  // Mode 3: Auto-Match subdirectories
  if (AUTO_MATCH) {
    console.log(`Scanning "${SOURCE_ROOT}" for book subdirectories...`);
    const { data: allItems } = await db.from("library_items").select(
      "id, title, path",
    );
    const items = allItems || [];

    for await (const entry of Deno.readDir(SOURCE_ROOT)) {
      if (!entry.isDirectory || entry.name.startsWith(".")) continue;
      const subDir = `${SOURCE_ROOT}/${entry.name}`;
      const folderKey = normKey(entry.name);

      const matched = items.find((it) => {
        const titleKey = normKey(it.title || "");
        const pathKey = normKey(it.path || "");
        return (
          folderKey.includes(titleKey) ||
          titleKey.includes(folderKey) ||
          (pathKey && folderKey.includes(pathKey))
        );
      });

      if (matched) {
        targets.push({
          dirPath: subDir,
          itemId: matched.id,
          bookTitle: matched.title,
        });
      } else {
        console.log(
          `  [auto-match] No DB item match for folder "${entry.name}"`,
        );
      }
    }
    return targets;
  }

  // Mode 4: Built-in Plan
  for (const plan of PLAN) {
    const fullDir = `${SOURCE_ROOT}/${plan.dir}`;
    try {
      await Deno.stat(fullDir);
    } catch {
      continue;
    }
    const hit = await itemIdFor(plan.titleLike);
    if (hit) {
      targets.push({
        dirPath: fullDir,
        itemId: hit.id,
        bookTitle: hit.title,
      });
    }
  }

  // If no plan matches, but SOURCE_ROOT itself has audio files, try matching SOURCE_ROOT folder name
  if (targets.length === 0) {
    const baseDir = SOURCE_ROOT.split("/").filter(Boolean).pop() || "";
    const hit = await itemIdFor(baseDir);
    if (hit) {
      targets.push({
        dirPath: SOURCE_ROOT,
        itemId: hit.id,
        bookTitle: hit.title,
      });
    }
  }

  return targets;
}

console.log(`\n=== 10x Pro B2 Audio Importer ===`);
console.log(`Target B2 Tier: ${B2_TIER} (${B2_BUCKET}) via ${B2_PREFIX}`);
console.log(`Mode: ${APPLY ? "WRITE (APPLY)" : "DRY RUN (no writes)"}`);
console.log(`Source Root: ${SOURCE_ROOT}\n`);

const targets = await collectTargets();
if (targets.length === 0) {
  console.log(
    "No matching targets found to process. Check directory or provide --item-id.",
  );
  Deno.exit(0);
}

console.log(`Found ${targets.length} target book(s) to process:`);
for (const t of targets) {
  console.log(`  - [${t.itemId}] "${t.bookTitle}" (folder: ${t.dirPath})`);
}
console.log();

let totalUploaded = 0;
let totalSkipped = 0;
let totalFailed = 0;
let totalGigabytes = 0;

for (const target of targets) {
  const { dirPath, itemId, bookTitle } = target;
  const files = await walkAudio(dirPath);

  if (files.length === 0) {
    console.log(`SKIP (no audio files): "${bookTitle}" in ${dirPath}`);
    continue;
  }

  console.log(`\nProcessing: "${bookTitle}" (${files.length} audio files)`);

  let iUp = 0;
  let iSk = 0;
  let iFl = 0;
  const renames: Array<[string, string]> = [];
  const fileMetadataMap = new Map<
    string,
    { duration: number; codec: string; mimeType: string }
  >();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Sanitize B2 key
    const safeName = f.name.replace(/~/g, "-").replace(
      /[^A-Za-z0-9 ._\-]/g,
      "_",
    );
    if (safeName !== f.name) renames.push([f.name, safeName]);

    const b2Key = `${itemId}/${safeName}`;
    const b2Size = await b2HeadExists(b2Key);

    const ext = safeName.split(".").pop()!.toLowerCase();
    const ct = ext === "ogg"
      ? "audio/ogg"
      : ext === "m4b" || ext === "m4a" || ext === "mp4"
      ? "audio/mp4"
      : ext === "flac"
      ? "audio/flac"
      : ext === "wav"
      ? "audio/wav"
      : "audio/mpeg";

    const codec = ct.includes("mp4")
      ? "aac"
      : ct.includes("ogg")
      ? "vorbis"
      : ct.includes("flac")
      ? "flac"
      : "mp3";

    // Read buffer for metadata duration (or upload)
    let buf: Uint8Array | null = null;
    let duration = 0;

    try {
      buf = new Uint8Array(await Deno.readFile(f.path));
      try {
        const parsed = await parseBuffer(buf, ct);
        duration = Math.round(parsed.format.duration || 0);
      } catch {
        duration = 0;
      }
    } catch (err) {
      console.warn(
        `  Failed reading file ${f.path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    fileMetadataMap.set(safeName, { duration, codec, mimeType: ct });

    if (b2Size !== null && b2Size === f.size) {
      iSk++;
      console.log(
        `  [${i + 1}/${files.length}] Exists on B2: ${safeName} (${
          (f.size / 1e6).toFixed(1)
        } MB, ${duration}s)`,
      );
      continue;
    }

    if (!APPLY) {
      console.log(
        `  [DRY] Would upload [${
          i + 1
        }/${files.length}]: ${safeName} -> ${B2_PREFIX}${b2Key}`,
      );
      iUp++;
      continue;
    }

    if (!buf) {
      iFl++;
      continue;
    }

    let uploaded = false;
    for (let attempt = 1; attempt <= 4 && !uploaded; attempt++) {
      try {
        await b2.send(
          new PutObjectCommand({
            Bucket: B2_BUCKET,
            Key: b2Key,
            Body: buf,
            ContentType: ct,
          }),
        );
        uploaded = true;
        iUp++;
        totalGigabytes += buf.length / 1e9;
        console.log(
          `  Uploaded [${
            i + 1
          }/${files.length}]: ${safeName} -> ${B2_PREFIX}${b2Key} (${
            (buf.length / 1e6).toFixed(1)
          } MB, ${duration}s)`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === 4) {
          iFl++;
          console.error(`  FAIL [${attempt}/4] ${safeName}: ${msg}`);
        } else {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
  }

  // Database Patching
  if (APPLY && (iUp > 0 || iSk > 0)) {
    const { data: cur } = await db
      .from("library_items")
      .select("id, audio_files, size, duration")
      .eq("id", itemId)
      .single();

    const existingAf: LibraryFileEntry[] = Array.isArray(cur?.audio_files)
      ? cur!.audio_files
      : [];
    const byName = new Map(
      existingAf.map((x: LibraryFileEntry) => [
        String(x?.metadata?.filename ?? x?.metadata?.relPath ?? ""),
        x,
      ]),
    );

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const safeName = renames.find(([orig]) => orig === f.name)?.[1] ?? f.name;
      const b2Key = `${itemId}/${safeName}`;
      const b2Path = `${B2_PREFIX}${b2Key}`;
      const meta = fileMetadataMap.get(safeName) ||
        { duration: 0, codec: "mp3", mimeType: "audio/mpeg" };

      const existingEntry = byName.get(safeName) ?? byName.get(f.name);
      if (!existingEntry) {
        byName.set(safeName, {
          index: i + 1,
          ino: crypto.randomUUID(),
          duration: meta.duration,
          codec: meta.codec,
          mimeType: meta.mimeType,
          metadata: {
            filename: safeName,
            ext: "." + safeName.split(".").pop()!.toLowerCase(),
            path: b2Path,
            relPath: safeName,
            size: f.size,
            duration: meta.duration,
            codec: meta.codec,
            mtimeMs: Date.now(),
            ctimeMs: Date.now(),
            birthtimeMs: Date.now(),
            mimeType: meta.mimeType,
          },
          addedAt: Date.now(),
          updatedAt: Date.now(),
        });
      } else {
        // Unconditionally update storage path to newly verified/uploaded B2 path
        existingEntry.metadata.path = b2Path;
        existingEntry.metadata.filename = safeName;
        existingEntry.metadata.relPath = safeName;
        existingEntry.metadata.size = f.size;
        if (meta.duration > 0) {
          existingEntry.duration = meta.duration;
          existingEntry.metadata.duration = meta.duration;
        }
        existingEntry.updatedAt = Date.now();
        byName.set(safeName, existingEntry);
      }
    }

    const merged = Array.from(byName.values());
    merged.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    merged.forEach((x: LibraryFileEntry, idx: number) => {
      x.index = idx + 1;
    });

    const totalSize = merged.reduce(
      (s: number, x: LibraryFileEntry) => s + Number(x?.metadata?.size ?? 0),
      0,
    );
    const totalDuration = merged.reduce(
      (d: number, x: LibraryFileEntry) =>
        d + Number(x?.duration ?? x?.metadata?.duration ?? 0),
      0,
    );

    const updatePayload: Record<string, unknown> = {
      audio_files: merged,
      library_files: merged.map((x: LibraryFileEntry) => ({
        ino: x.ino,
        metadata: x.metadata,
        addedAt: x.addedAt,
        updatedAt: x.updatedAt,
      })),
      size: totalSize,
    };
    if (totalDuration > 0) {
      updatePayload.duration = totalDuration;
    }

    const { error: updateErr } = await db
      .from("library_items")
      .update(updatePayload)
      .eq("id", itemId);

    if (updateErr) {
      console.error(
        `  Database update FAILED for "${bookTitle}": ${updateErr.message}`,
      );
    } else {
      console.log(
        `  Database patched: ${merged.length} tracks -> ${B2_PREFIX} (Duration: ${
          Math.round(totalDuration / 60)
        }m, Size: ${(totalSize / 1e6).toFixed(1)} MB)`,
      );
    }
  }

  totalUploaded += iUp;
  totalSkipped += iSk;
  totalFailed += iFl;
}

console.log(`\n========================================`);
console.log(`Summary: mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`  Uploaded: ${totalUploaded}`);
console.log(`  Skipped (existing): ${totalSkipped}`);
console.log(`  Failed: ${totalFailed}`);
console.log(`  Data transferred: ${totalGigabytes.toFixed(2)} GB`);
console.log(`========================================\n`);
