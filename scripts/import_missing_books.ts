// Bulk-import byte-less library books from a source directory tree into
// Supabase Storage under {library_item_id}/{filename} - the exact key pattern
// playback resolution probes. Resumable: existing objects with matching size
// are skipped, so the script can be re-run after interruptions.
//
// Usage: deno run --allow-all scripts/import_missing_books.ts <sourceRoot> [--apply]
import { createClient } from "npm:@supabase/supabase-js@2.44.0";

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

async function existingSizes(itemId: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
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
  return m;
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

let up = 0,
  sk = 0,
  fl = 0,
  gb = 0;

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

  let iUp = 0,
    iSk = 0,
    iFl = 0;
  const renames: Array<[string, string]> = [];
  for (const f of files) {
    if (existing.get(f.name) === f.size) {
      iSk++;
      continue;
    }
    if (!APPLY) continue;
    let uploaded = false;
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
        let targetName = f.name;
        const first = await db.storage.from("audio-files").upload(
          `${itemId}/${targetName}`,
          buf,
          { upsert: true, contentType: ct },
        );
        if (first.error && first.error.message.includes("Invalid key")) {
          // Supabase rejects certain characters (~). Sanitize the key and
          // sync DB metadata so filename-based resolution still matches.
          targetName = f.name.replace(/~/g, "-").replace(
            /[^A-Za-z0-9 ._\-]/g,
            "_",
          );
          const up2 = await db.storage.from("audio-files").upload(
            `${itemId}/${targetName}`,
            buf,
            { upsert: true, contentType: ct },
          );
          if (up2.error) throw new Error(up2.error.message);
          renames.push([f.name, targetName]);
        } else if (first.error) {
          throw new Error(first.error.message);
        }
        uploaded = true;
        iUp++;
        gb += buf.length / 1e9;
        process.stdout.write(
          `\r  ${plan.titleLike.slice(0, 22)}: ${iUp + iSk}/${files.length}`,
        );
      } catch (e) {
        if (attempt === 4) {
          iFl++;
          console.log(
            `\n  FAIL ${f.name}: ${(e as Error).message.slice(0, 80)}`,
          );
        } else {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
  }
  if (renames.length > 0 && APPLY) {
    const { data: cur } = await db.from("library_items").select(
      "audio_files",
    ).eq("id", itemId).single();
    const af = ((cur?.audio_files as any[]) ?? []).map((f) => ({ ...f }));
    for (const [from, to] of renames) {
      for (const f of af) {
        if (String(f?.metadata?.filename ?? "") === from) {
          f.metadata.filename = to;
          if (f.metadata.relPath === from) f.metadata.relPath = to;
        }
      }
    }
    const { error } = await db.from("library_items").update({
      audio_files: af as any,
    }).eq("id", itemId);
    console.log(
      error
        ? `metadata rename sync FAILED: ${error.message}`
        : `synced ${renames.length} sanitized name(s) into metadata`,
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
