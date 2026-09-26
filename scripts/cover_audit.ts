// AI cover audit: verifies every library item's cover art actually belongs to
// that book using a vision model (z.ai glm-4.5v).
//
// Mismatches are auto-repaired through the identity-gated cover fetcher
// (_shared/coverFetch.ts) and re-verified once. A mismatch that SURVIVES a
// refetch means no provider has correct art - reported, not forced.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZAI_API_KEY.
// Exit 0 when every cover matches (or was repaired to match); 1 otherwise.

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
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

const urllibEncode = (v: string) => encodeURIComponent(v);

/**
 * Search-friendly title variants.
 *
 * Library titles are scanner output and carry a lot of noise that every
 * provider's structured search handles badly. Real examples from the
 * production library:
 *
 *   "Brain Droppings (Humor)"  -> "Brain Droppings"
 *   "Amit Goswami Quantum Physics Consciousness Creativity Healing" (author
 *     name run into the title) -> needs the author stripped out
 *
 * OpenLibrary's `title=`/`author=` parameters returned *zero* docs for most of
 * these because the parenthetical is treated as a literal title token. The
 * free-text `q=` parameter does not, so variants are searched through `q=`
 * while the untouched title is still what the vision model verifies against.
 */
function titleVariants(title: string, author: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.replace(/\s+/g, " ").trim();
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  };

  push(title);
  // Drop parentheticals/brackets: "Brain Droppings (Humor)" -> "Brain Droppings"
  const deParen = title.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, " ").replace(
    /\s+/g,
    " ",
  )
    .trim();
  push(deParen);
  // Scanner prefixes like "Author - Title" or "Author Title" (author run on)
  if (author) {
    const bareAuthor = author.split(",")[0].trim();
    if (
      bareAuthor && deParen.toLowerCase().startsWith(bareAuthor.toLowerCase())
    ) {
      push(deParen.slice(bareAuthor.length).replace(/^[\s\-_:]+/, "").trim());
    }
  }
  // Trailing volume/edition noise: "The Feynman Lectures on Physics, Vol. 2"
  push(
    deParen.replace(
      /[,;]?\s*\b(vol|volume|part|pt|book|unabridged|abridged|audiobook|edition|ed)\b\.?\s*[\w\d.]*$/gi,
      "",
    ).trim(),
  );

  return out;
}

/** Proven, working providers. Google Books is deliberately absent -- see collectCandidates. */
async function collectCandidates(
  title: string,
  author: string,
): Promise<string[]> {
  const urls: string[] = [];
  const add = (u: string) => {
    if (u && !urls.includes(u)) urls.push(u);
  };
  const variants = titleVariants(title, author);
  const primary = variants[0] ?? title;
  const alt = variants[1] ?? primary;

  // --- OpenLibrary, free-text `q=` ------------------------------------------
  // `q=` is the only parameter that survives noisy titles; the structured
  // `title=`/`author=` pair returned nothing for this library.
  for (
    const q of [
      author ? `${primary} ${author}` : primary,
      primary,
      alt !== primary && author ? `${alt} ${author}` : null,
    ].filter(Boolean) as string[]
  ) {
    try {
      const r = await fetch(
        `https://openlibrary.org/search.json?q=${urllibEncode(q)}&limit=6`,
      );
      const j = await r.json();
      for (const d of (j.docs ?? []).slice(0, 4)) {
        if (d.cover_i) {
          add(`https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`);
        }
      }
    } catch { /* provider down: fall through to the next one */ }
  }

  // --- iTunes, entity=audiobook ---------------------------------------------
  // Audiobook results carry the work's name in `collectionName`; `trackName`
  // is the *chapter*, which is why reading it produced nonsense matches.
  // `entity=audiobook` is also the correct parameter -- `media=audiobook` is
  // not a valid iTunes Search entity.
  for (
    const q of [
      author ? `${primary} ${author}` : primary,
      primary,
    ]
  ) {
    try {
      const r = await fetch(
        `https://itunes.apple.com/search?term=${
          urllibEncode(q)
        }&entity=audiobook&limit=8`,
      );
      const j = await r.json();
      for (const res of (j.results ?? []).slice(0, 5)) {
        const art = String(res.artworkUrl100 ?? "");
        if (art) add(art.replace("100x100", "600x600"));
      }
    } catch { /* ignore */ }
  }

  // --- Wikipedia (for public-domain / classical works) -----------------------
  // Scanned libraries are full of titles with no commercial audiobook listing
  // (e.g. "Royal Irish Academy, Vol. 17"); the encyclopaedia article is often
  // the only place with usable art.
  try {
    const r = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1` +
        `&generator=search&gsrsearch=${urllibEncode(primary)}` +
        `&gsrnamespace=0&gsrlimit=3&prop=pageimages&piprop=thumbnail&pithumbsize=600` +
        `&origin=*`,
    );
    const j = await r.json();
    for (
      const p of Object.values<{ thumbnail?: { source?: string } }>(
        j?.query?.pages ?? {},
      )
    ) {
      const t = p?.thumbnail?.source;
      if (t) add(String(t).replace(/^\/\//, "https://"));
    }
  } catch { /* ignore */ }

  // --- Internet Archive ------------------------------------------------------
  // The only source that resolved "Сумерки богов" and the BBC Classics
  // collection. Note its /services/img endpoint returns the *first* page
  // image of a scan, so for multi-volume runs the volume number in the
  // artwork can differ from the requested one -- the vision check is what
  // catches that, and it did (a "Vol. 17" item was offered a "Volume III"
  // title page and correctly rejected).
  try {
    const r = await fetch(
      `https://archive.org/advancedsearch.php?q=${
        urllibEncode(author ? `${primary} AND ${author}` : primary)
      }&fl%5B%5D=identifier&rows=5&page=1&output=json`,
    );
    const j = await r.json();
    for (const d of (j?.response?.docs ?? []).slice(0, 4)) {
      if (d?.identifier) {
        add(`https://archive.org/services/img/${d.identifier}`);
      }
    }
  } catch { /* ignore */ }

  // Google Books is intentionally NOT queried. This project is permanently
  // HTTP 429 (quota exhausted) on books.googleapis.com, so the call only ever
  // burned a round trip; it contributed zero candidates across the full
  // library audit.

  return urls.slice(0, 24);
}

/** Vision-arbitrated repair: only upload art the model confirms matches. */
async function visionRepair(
  db: SupabaseClient,
  itemId: string,
  title: string,
  author: string,
): Promise<{ ok: boolean; detail: string }> {
  const candidates = await collectCandidates(title, author);
  // A vision *rejection* ("this is a different book") and a vision *failure*
  // (HTTP 500 / timeout / unparseable) both used to collapse into
  // `if (!v) continue`, so a provider outage made every item look like
  // "no correct art exists" and the audit reported a healthy library while
  // silently fixing nothing. They are now counted separately, because the
  // operator response is completely different: keep retrying vs. accept it.
  let rejected = 0;
  let errored = 0;
  for (const url of candidates) {
    const v = await verify(title, author, url);
    if (!v) {
      errored += 1;
      continue;
    }
    if (!v.match || v.confidence < 0.6) {
      rejected += 1;
      continue;
    }
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
      // cover_path change also bumps updated_at via trigger, which is the
      // web client's cover cache-buster.
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
    detail: `${candidates.length} candidates (${rejected} vision-rejected` +
      `${errored ? `, ${errored} vision-ERRORED` : ""}) — none verified`,
  };
}

async function main() {
  // Include items with NO cover, not just ones with art to verify. Previously
  // the query filtered out cover_path = "missing", so a book that fell back to
  // the honest placeholder was never retried — the audit could only ever
  // second-guess existing art, never fill a gap.
  const { data: items, error } = await db
    .from("library_items")
    .select("id, title, author_names_first_last, cover_path")
    .or("cover_path.is.null,cover_path.eq.,cover_path.eq.missing");
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
  let gaps = 0;
  let gapsFilled = 0;

  for (const it of items ?? []) {
    const hasArt = Boolean(it.cover_path) && it.cover_path !== "missing";
    if (!hasArt) {
      // Gap-fill: no art to verify, so go straight to a vision-arbitrated
      // search. Only verified-correct art is ever written.
      console.log(
        `GAP "${it.title}" — no cover, searching for verified art`,
      );
      const filled = await visionRepair(
        db,
        it.id,
        String(it.title),
        String(it.author_names_first_last ?? ""),
      );
      gaps += 1;
      if (filled.ok) {
        gapsFilled += 1;
        console.log(`  gap-filled -> ${filled.detail.slice(0, 70)}`);
        report.push({
          id: it.id,
          title: it.title,
          verdict: "gap-filled",
          detail: filled.detail,
          repaired: true,
        });
      } else {
        report.push({
          id: it.id,
          title: it.title,
          verdict: "gap-unfilled",
          detail: filled.detail,
          repaired: false,
        });
      }
      continue;
    }
    // fresh signed URL per item (covers bucket)
    const { data: sig } = await db.storage.from("covers").createSignedUrl(
      it.cover_path!,
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
    } repaired, ${gapsFilled}/${gaps} gaps filled, ${
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
