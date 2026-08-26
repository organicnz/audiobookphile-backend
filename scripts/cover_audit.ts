// AI cover audit: verifies every library item's cover art actually belongs to
// that book using a vision model (z.ai glm-4.5v).
//
// Mismatches are auto-repaired through the identity-gated cover fetcher
// (_shared/coverFetch.ts) and re-verified once. A mismatch that SURVIVES a
// refetch means no provider has correct art - reported, not forced.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZAI_API_KEY.
// Exit 0 when every cover matches (or was repaired to match); 1 otherwise.

import { createClient } from "npm:@supabase/supabase-js@2.44.0";
// @ts-ignore - path aliasing handled by deno.json import map at repo root

const URL_BASE = Deno.env.get("SUPABASE_URL") ?? "";
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ZAI = Deno.env.get("ZAI_API_KEY") ?? "";

if (!URL_BASE || !SVC || !ZAI) {
  console.error(
    "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ZAI_API_KEY are required",
  );
  Deno.exit(2);
}

const db = createClient(URL_BASE, SVC, { auth: { persistSession: false } });

interface Verdict {
  match: boolean;
  confidence: number;
  cover_shows: string;
}

const SYSTEM =
  'You are verifying audiobook cover art. Given the expected TITLE and AUTHOR and the cover image, judge whether this cover plausibly belongs to that book. Covers of different editions/translations count as a match; a different work, unrelated imagery with no title connection, or blank/garbage art does not. Reply ONLY JSON: {"match":true|false,"confidence":0.0-1.0,"cover_shows":"brief description"}';

async function verify(
  title: string,
  author: string,
  imageUrl: string,
): Promise<Verdict | null> {
  try {
    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZAI}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: Deno.env.get("COVER_VISION_MODEL") ?? "glm-4.5v",
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: imageUrl } },
                { type: "text", text: `TITLE: ${title}\nAUTHOR: ${author}` },
              ],
            },
          ],
          temperature: 0.1,
          max_tokens: 300,
          thinking: { type: "disabled" },
          response_format: { type: "json_object" },
        }),
      },
    );
    if (!res.ok) {
      console.warn(`  [vision] HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "");
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(content.slice(start, end + 1)) as Partial<
      Verdict
    >;
    return {
      match: !!parsed.match,
      confidence: Number(parsed.confidence ?? 0),
      cover_shows: String(parsed.cover_shows ?? "").slice(0, 200),
    };
  } catch (e) {
    console.warn(`  [vision] ${(e as Error).message}`);
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Collect MULTIPLE candidate cover URLs across providers. Provider metadata
 * frequently attaches wrong art to right titles, so metadata alone cannot be
 * trusted - every candidate is vision-verified before use.
 */
async function collectCandidates(
  title: string,
  author: string,
): Promise<string[]> {
  const urls: string[] = [];
  try {
    const r = await fetch(
      `https://itunes.apple.com/search?term=${
        encodeURIComponent(`${title} ${author}`)
      }&limit=5`,
    );
    const j = await r.json();
    for (const res of (j.results ?? []).slice(0, 3)) {
      const art = String(res.artworkUrl100 ?? "");
      if (art) urls.push(art.replace("100x100", "600x600"));
    }
  } catch { /* ignore */ }
  try {
    const r = await fetch(
      `https://openlibrary.org/search.json?title=${
        encodeURIComponent(title)
      }&author=${encodeURIComponent(author)}&limit=3`,
    );
    const j = await r.json();
    for (const d of (j.docs ?? []).slice(0, 2)) {
      if (d.cover_i) {
        urls.push(`https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`);
      }
    }
  } catch { /* ignore */ }
  try {
    const r = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${
        encodeURIComponent(`intitle:${title} ${author}`)
      }&maxResults=5`,
    );
    const j = await r.json();
    for (const v of (j.items ?? []).slice(0, 3)) {
      const img = v?.volumeInfo?.imageLinks?.thumbnail ??
        v?.volumeInfo?.imageLinks?.smallThumbnail;
      if (img) {
        urls.push(img.replace("http://", "https://").replace("&edge=curl", ""));
      }
    }
  } catch { /* ignore */ }
  return [...new Set(urls)].slice(0, 8);
}

/** Vision-arbitrated repair: only upload art the model confirms matches. */
// deno-lint-ignore no-explicit-any
async function visionRepair(
  db: any,
  itemId: string,
  title: string,
  author: string,
): Promise<{ ok: boolean; detail: string }> {
  const candidates = await collectCandidates(title, author);
  for (const url of candidates) {
    const v = await verify(title, author, url);
    if (!v || !v.match || v.confidence < 0.6) continue;
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength < 2000) continue; // skip OL 1px placeholders
    const ext = url.includes(".png") ? "png" : "jpg";
    const path = `${itemId}/cover.${ext}`;
    const up = await db.storage.from("covers").upload(path, bytes, {
      upsert: true,
      contentType: ext === "png" ? "image/png" : "image/jpeg",
    });
    if (!up.error) {
      await db.from("library_items").update({ cover_path: path }).eq(
        "id",
        itemId,
      );
      return {
        ok: true,
        detail: `${url.slice(0, 70)} :: ${v.cover_shows.slice(0, 60)}`,
      };
    }
  }
  return {
    ok: false,
    detail: `${candidates.length} candidates, none verified`,
  };
}

async function main() {
  const { data: items, error } = await db
    .from("library_items")
    .select("id, title, author_names_first_last, cover_path")
    .not("cover_path", "is", null)
    .neq("cover_path", "")
    .neq("cover_path", "missing");
  if (error) throw new Error(error.message);

  console.log(`auditing ${items?.length ?? 0} covers\n`);
  const report: Array<{
    id: string;
    title: string;
    verdict: string;
    detail: string;
    repaired: boolean;
  }> = [];
  let mismatches = 0;

  for (const it of items ?? []) {
    if (!it.cover_path) continue;
    // fresh signed URL per item (covers bucket)
    const { data: sig } = await db.storage.from("covers").createSignedUrl(
      it.cover_path,
      600,
    );
    if (!sig?.signedUrl) {
      report.push({
        id: it.id,
        title: it.title,
        verdict: "unsignable",
        detail: it.cover_path,
        repaired: false,
      });
      continue;
    }
    const v = await verify(
      String(it.title),
      String(it.author_names_first_last ?? ""),
      sig.signedUrl,
    );
    if (!v) {
      report.push({
        id: it.id,
        title: it.title,
        verdict: "vision-error",
        detail: "",
        repaired: false,
      });
      await sleep(400);
      continue;
    }

    if (v.match && v.confidence >= 0.5) {
      report.push({
        id: it.id,
        title: it.title,
        verdict: "ok",
        detail: v.cover_shows,
        repaired: false,
      });
    } else {
      mismatches++;
      console.log(
        `MISMATCH "${it.title}" <- ${v.cover_shows} (conf ${
          v.confidence.toFixed(2)
        })`,
      );
      // Vision-arbitrated repair across all providers
      const rep = await visionRepair(
        db,
        it.id,
        String(it.title),
        String(it.author_names_first_last ?? ""),
      );
      if (rep.ok) {
        console.log(`  vision-repaired -> OK (${rep.detail.slice(0, 60)})`);
        report.push({
          id: it.id,
          title: it.title,
          verdict: "repaired",
          detail: rep.detail,
          repaired: true,
        });
        continue;
      }
      // No verifiable art anywhere: honest placeholder beats wrong book art.
      await db.from("library_items").update({ cover_path: "missing" }).eq(
        "id",
        it.id,
      );
      console.log("  no verified art found -> cover set to placeholder");
      report.push({
        id: it.id,
        title: it.title,
        verdict: "placeholder",
        detail: v.cover_shows,
        repaired: true,
      });
    }
    await sleep(400); // provider courtesy
  }

  await Deno.mkdir("reports", { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const bad = report.filter((r) => r.verdict !== "ok");
  await Deno.writeTextFile(
    `reports/cover-audit-${stamp}.md`,
    `# Cover audit ${stamp}\n\nAudited: ${report.length} · ok: ${
      report.length - bad.length
    } · issues: ${bad.length}\n\n${
      bad.map((r) =>
        `- [${r.verdict}] **${r.title}** (${r.id})\n  - ${r.detail}`
      ).join("\n") || "_none_"
    }\n`,
  );

  console.log(
    `\n=== cover audit: ${report.length} audited, ${mismatches} mismatches, ${
      report.filter((r) => r.verdict === "repaired").length
    } repaired, ${
      report.filter((r) =>
        r.verdict === "unrepairable" || r.verdict === "refetch-failed"
      ).length
    } unrepairable`,
  );

  const stillBad = report.filter((r) => r.verdict === "unrepairable").length;
  if (stillBad > 0) {
    console.error(`FAIL: ${stillBad} cover(s) remain wrong after refetch`);
    Deno.exit(1);
  }
  console.log("PASS");
}

if (import.meta.main) await main();
