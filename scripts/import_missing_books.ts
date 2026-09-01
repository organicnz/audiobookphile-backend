// Bulk-import library books from a source directory tree into B2 (NOT Supabase
// Storage). Supabase `audio-files` is legacy and capped at 10 MiB per file
// (see 20260830000000_storage_hardening.sql) – it blew to 7.5 GB / 858 objects
// on 2026-08-26 by bypassing B2. All new audio MUST go to B2 via presigned S3.
//
// This script now uploads to the B2 pool (primary→secondary→tertiary→quartet→quinta)
// using @aws-sdk/client-s3 PutObject, then patches `library_items.audio_files`
// with `b2://{id}/{filename}` paths so StorageRouter can sign them.
//
// Safety: resumable (skips existing B2 objects with matching size), dry-run
// by default, `--apply` writes. No Supabase Storage `audio-files` writes.
//
// Usage: deno run --allow-all --env-file .env.local scripts/import_missing_books.ts <sourceRoot> [--apply] [--b2-tier B2|B2_SECONDARY|B2_TERTIARY|B2_QUARTET|B2_QUINTET]
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@^3.693.0";

const URL_BASE = Deno.env.get("SUPABASE_URL") ?? "";
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!URL_BASE || !SVC) throw new Error("env required");
const db = createClient(URL_BASE, SVC, { auth: { persistSession: false } });

const SOURCE_ROOT = Deno.args[0];
const APPLY = Deno.args.includes("--apply");
const AUDIO = [".mp3", ".m4b", ".m4a", ".ogg", ".flac"];

const PLAN: Array<{ dir: string; titleLike: string }> = [
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

async function itemIdFor(titleLike: string): Promise<string | null> {
  const want = normKey(titleLike);
  const probe = `%${titleLike.slice(0, 20)}%`;
  const { data } = await db.from("library_items").select("id,title").ilike(
    "title",
    probe,
  ).limit(25);
  if (!data?.length) return null;
  const hit = data.find((r) =>
    normKey(r.title).includes(want.slice(0, 12)) ||
    want.includes(normKey(r.title))
  );
  return hit?.id ?? data[0].id;
}

// ── B2 pool (mirrors supabase/functions/_shared/b2-bucket-pool.ts) ──
const TIER_ENV: Record<
  string,
  { key: string; app: string; ep: string; bucket: string; region: string }
> = {
  B2: {
    key: "B2_KEY_ID",
    app: "B2_APP_KEY",
    ep: "B2_ENDPOINT",
    bucket: "B2_BUCKET_NAME",
    region: "B2_REGION",
  },
  B2_SECONDARY: {
    key: "B2_SECONDARY_KEY_ID",
    app: "B2_SECONDARY_APP_KEY",
    ep: "B2_SECONDARY_ENDPOINT",
    bucket: "B2_SECONDARY_BUCKET_NAME",
    region: "B2_SECONDARY_REGION",
  },
  B2_TERTIARY: {
    key: "B2_TERTIARY_KEY_ID",
    app: "B2_TERTIARY_APP_KEY",
    ep: "B2_TERTIARY_ENDPOINT",
    bucket: "B2_TERTIARY_BUCKET_NAME",
    region: "B2_TERTIARY_REGION",
  },
  B2_QUARTET: {
    key: "B2_QUARTET_KEY_ID",
    app: "B2_QUARTET_APP_KEY",
    ep: "B2_QUARTET_ENDPOINT",
    bucket: "B2_QUARTET_BUCKET_NAME",
    region: "B2_QUARTET_REGION",
  },
  B2_QUINTET: {
    key: "B2_QUINTA_KEY_ID",
    app: "B2_QUINTA_APP_KEY",
    ep: "B2_QUINTA_ENDPOINT",
    bucket: "B2_QUINTA_BUCKET_NAME",
    region: "B2_QUINTA_REGION",
  },
};
function b2Client(
  tier: string,
): { client: S3Client; bucket: string; prefix: string } {
  const e = TIER_ENV[tier] ?? TIER_ENV.B2;
  const bucket = Deno.env.get(e.bucket)!;
  if (!bucket) throw new Error(`Missing ${e.bucket} for tier ${tier}`);
  const client = new S3Client({
    endpoint: Deno.env.get(e.ep)!,
    region: Deno.env.get(e.region) || "us-west-004",
    credentials: {
      accessKeyId: Deno.env.get(e.key)!,
      secretAccessKey: Deno.env.get(e.app)!,
    },
    forcePathStyle: true,
    // @ts-ignore
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return {
    client,
    bucket,
    prefix: tier === "B2"
      ? "b2://"
      : tier.toLowerCase().replace("_", "-") + "://",
  };
}
const B2_TIER = Deno.args[Deno.args.indexOf("--b2-tier") + 1] ??
  Deno.env.get("ACTIVE_B2_TIER") ?? "B2";
const { client: b2, bucket: B2_BUCKET, prefix: B2_PREFIX } = b2Client(
  B2_TIER.toUpperCase(),
);

async function existingSizes(itemId: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  // Probe B2 (primary) + Supabase fallback for legacy objects – we skip upload if size matches on either
  try {
    // Cheap: Head each candidate on B2 lazily in caller; here we list Supabase for legacy skip only
    let offset = 0;
    for (;;) {
      const { data } = await db.storage.from("audio-files").list(itemId, {
        limit: 1000,
        offset,
      });
      if (!data || data.length === 0) break;
      for (const f of data) {
        if (f.id !== null) m.set(f.name, f.metadata?.size ?? 0);
      }
      if (data.length < 1000) break;
      offset += 1000;
    }
  } catch { /* legacy Supabase list may fail */ }
  // Also probe B2 via HeadObject in per-file loop (b2HeadExists)
  return m;
}
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
    for await (const e of Deno.readDir(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory && !e.name.startsWith(".")) await rec(p);
      else if (
        e.isFile &&
        !e.name.startsWith("._") && AUDIO.some((x) =>
          e.name.toLowerCase().endsWith(x)
        )
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
  }
  await rec(dir);
  return out;
}

console.log(
  `B2 target: ${B2_BUCKET} via ${B2_PREFIX} (tier ${B2_TIER}) – dry=${!APPLY}`,
);
let up = 0, sk = 0, fl = 0, gb = 0;

for (const plan of PLAN) {
  const fullDir = `${SOURCE_ROOT}/${plan.dir}`;
  try {
    await Deno.stat(fullDir);
  } catch {
    console.log(`SKIP (no dir): ${plan.dir.slice(0, 50)}`);
    continue;
  }
  const itemId = await itemIdFor(plan.titleLike);
  if (!itemId) {
    console.log(`SKIP (no item): ${plan.titleLike}`);
    continue;
  }
  const files = await walkAudio(fullDir);
  if (files.length === 0) {
    console.log(`SKIP (no audio): ${plan.dir.slice(0, 50)}`);
    continue;
  }
  const existing = await existingSizes(itemId);

  let iUp = 0, iSk = 0, iFl = 0;
  const renames: Array<[string, string]> = [];
  // Build a B2-aware skip map: check B2 head for each file (fast) + legacy Supabase list
  for (const f of files) {
    if (existing.get(f.name) === f.size) {
      iSk++;
      continue;
    }
    const b2Key = `${itemId}/${f.name}`;
    const b2Size = await b2HeadExists(b2Key);
    if (b2Size !== null && b2Size === f.size) {
      iSk++;
      continue;
    }
    if (!APPLY) continue;
    let uploaded = false;
    let targetName = f.name;
    for (let attempt = 1; attempt <= 4 && !uploaded; attempt++) {
      try {
        const buf = new Uint8Array(await Deno.readFile(f.path));
        const ct = f.name.endsWith(".ogg")
          ? "audio/ogg"
          : f.name.endsWith(".m4b") || f.name.endsWith(".m4a")
          ? "audio/mp4"
          : f.name.endsWith(".flac")
          ? "audio/flac"
          : "audio/mpeg";
        // Sanitize B2 key (B2 also rejects control chars)
        const safeName = targetName.replace(/~/g, "-").replace(
          /[^A-Za-z0-9 ._\-]/g,
          "_",
        );
        if (safeName !== targetName) renames.push([targetName, safeName]);
        targetName = safeName;
        const key = `${itemId}/${targetName}`;
        // 10x pro: audio MUST go to B2 – never to Supabase storage
        await b2.send(
          new PutObjectCommand({
            Bucket: B2_BUCKET,
            Key: key,
            Body: buf,
            ContentType: ct,
          }),
        );
        uploaded = true;
        iUp++;
        gb += buf.length / 1e9;
        process.stdout.write(
          `\r  ${plan.titleLike.slice(0, 22)}: ${
            iUp + iSk
          }/${files.length} → ${B2_PREFIX}${key.slice(0, 40)}`,
        );
        // Patch DB: insert/update audio_files entry with b2:// path so playback signs from B2
        // We do this per-file to be resumable; the full item patch happens after loop too.
      } catch (e) {
        if (attempt === 4) {
          iFl++;
          console.log(
            `\n  FAIL ${f.name}: ${(e as Error).message.slice(0, 120)}`,
          );
        } else await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  // Patch library_items.audio_files to point at B2 (and apply any renames)
  if (APPLY && (iUp > 0 || renames.length > 0)) {
    const { data: cur } = await db.from("library_items").select(
      "id, audio_files, size",
    ).eq("id", itemId).single();
    const existingAf: any[] = Array.isArray(cur?.audio_files)
      ? cur!.audio_files
      : [];
    const byName = new Map(
      existingAf.map((
        x: any,
      ) => [String(x?.metadata?.filename ?? x?.metadata?.relPath ?? ""), x]),
    );
    for (const f of files) {
      const name = renames.find(([a]) => a === f.name)?.[1] ?? f.name;
      const key = `${itemId}/${name}`;
      const b2Path = `${B2_PREFIX}${key}`;
      const ct = name.endsWith(".ogg")
        ? "audio/ogg"
        : name.endsWith(".m4b") || name.endsWith(".m4a")
        ? "audio/mp4"
        : name.endsWith(".flac")
        ? "audio/flac"
        : "audio/mpeg";
      if (!byName.has(name) && !byName.has(f.name)) {
        byName.set(name, {
          index: byName.size + 1,
          ino: crypto.randomUUID(),
          duration: 0,
          codec: ct.includes("mp4")
            ? "aac"
            : ct.includes("ogg")
            ? "vorbis"
            : "mp3",
          metadata: {
            filename: name,
            ext: "." + name.split(".").pop()!.toLowerCase(),
            path: b2Path,
            relPath: name,
            size: f.size,
            duration: 0,
            codec: "mp3",
            mtimeMs: Date.now(),
            ctimeMs: Date.now(),
            birthtimeMs: Date.now(),
            mimeType: ct,
          },
          addedAt: Date.now(),
          updatedAt: Date.now(),
          mimeType: ct,
        });
      } else {
        // Ensure existing entry's path is upgraded to B2 (migrate legacy /... or supabase://)
        const ent = byName.get(name) ?? byName.get(f.name);
        if (ent && String(ent?.metadata?.path ?? "").startsWith("/")) {
          ent.metadata.path = b2Path;
        }
        if (
          ent && String(ent?.metadata?.path ?? "").startsWith("supabase://")
        ) ent.metadata.path = b2Path;
      }
    }
    for (const [from, to] of renames) {
      const ent = byName.get(from);
      if (ent) {
        byName.delete(from);
        ent.metadata.filename = to;
        ent.metadata.relPath = to;
        byName.set(to, ent);
      }
    }
    const merged = Array.from(byName.values());
    // Re-index
    merged.forEach((x: any, i: number) => x.index = i + 1);
    const totalSize = merged.reduce(
      (s: number, x: any) => s + Number(x?.metadata?.size ?? 0),
      0,
    );
    const { error } = await db.from("library_items").update({
      audio_files: merged as any,
      library_files: merged.map((x: any) => ({
        ino: x.ino,
        metadata: x.metadata,
        addedAt: x.addedAt,
        updatedAt: x.updatedAt,
      })),
      size: totalSize,
    }).eq("id", itemId);
    console.log(
      error
        ? `  DB patch FAILED: ${error.message}`
        : `  DB patched ${merged.length} tracks → ${B2_PREFIX} (size ${
          (totalSize / 1e9).toFixed(2)
        } GB)`,
    );
  }
  up += iUp;
  sk += iSk;
  fl += iFl;
  console.log(
    `${APPLY ? "DONE" : "DRY"} "${
      plan.titleLike.slice(0, 28)
    }": up=${iUp} skip=${iSk} fail=${iFl} (of ${files.length})`,
  );
}
console.log(
  `\nTOTAL apply=${APPLY} uploaded=${up} skippedExisting=${sk} failed=${fl} data=${
    gb.toFixed(2)
  }GB`,
);
