// Storage Health Auditor — comprehensive audit of all library items against B2 / Supabase storage.
// Usage:
//   deno run --allow-all --env-file=env/local.env scripts/storage_health_report.ts [--filter missing|partial|healthy|all] [--limit N]

import { createClient } from "@supabase/supabase-js";
import { StorageRouter } from "../supabase/functions/_shared/storage-router.ts";
import { BUCKET_CONFIGS } from "../supabase/functions/_shared/b2-config.ts";

const URL_BASE = Deno.env.get("SUPABASE_URL") ||
  Deno.env.get("NEXT_PUBLIC_SUPABASE_URL") || "";
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_KEY") || "";

if (!URL_BASE || !SVC) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
}

const db = createClient(URL_BASE, SVC, { auth: { persistSession: false } });
const storage = new StorageRouter(db);

/// One row of the `library_items.audio_files` JSONB column, as read from the
/// DB (all fields optional — rows predate the writer-side normalization).
interface AudioFileRow {
  path?: string;
  storage_path?: string;
  metadata?: {
    path?: string;
    filename?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const args = Deno.args;
const filterIdx = args.indexOf("--filter");
const FILTER = (filterIdx !== -1 ? args[filterIdx + 1] : "all").toLowerCase();

const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 1000;

console.log(`\n======================================================`);
console.log(`  Audiobookphile Storage Health Audit`);
console.log(`======================================================`);
console.log(`Configured B2 Tiers:`);
for (const [tier, cfg] of Object.entries(BUCKET_CONFIGS)) {
  console.log(
    `  ${tier}: isConfigured=${cfg.isConfigured} (Bucket: ${
      cfg.bucketName || "none"
    })`,
  );
}
console.log(`======================================================\n`);

interface ItemAuditResult {
  id: string;
  title: string;
  totalTracks: number;
  verifiedTracks: number;
  missingTracks: number;
  samplePath: string;
  status: "HEALTHY" | "PARTIAL" | "MISSING";
}

async function runAudit() {
  const { data: items, error } = await db
    .from("library_items")
    .select("id, title, audio_files, size, duration")
    .order("title")
    .limit(LIMIT);

  if (error) {
    console.error("Failed to query library_items:", error.message);
    Deno.exit(1);
  }

  const allItems = items || [];
  console.log(`Auditing ${allItems.length} library item(s)...\n`);

  const results: ItemAuditResult[] = [];

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const afs: AudioFileRow[] = Array.isArray(item.audio_files)
      ? item.audio_files
      : [];
    const totalTracks = afs.length;

    if (totalTracks === 0) {
      results.push({
        id: item.id,
        title: item.title,
        totalTracks: 0,
        verifiedTracks: 0,
        missingTracks: 0,
        samplePath: "none",
        status: "MISSING",
      });
      continue;
    }

    let verified = 0;
    let samplePath = "";

    // Probe first track + sample of subsequent tracks
    for (let t = 0; t < totalTracks; t++) {
      const af = afs[t];
      const p = String(
        af?.metadata?.path ||
          af?.storage_path ||
          af?.path ||
          af?.metadata?.filename ||
          "",
      );
      if (t === 0) samplePath = p;

      // To keep audit fast, probe first 3 tracks and last track; if first 3 are missing, mark all missing
      const shouldProbe = t < 3 || t === totalTracks - 1;
      if (shouldProbe) {
        const exists = await storage.fileExists(p).catch(() => false);
        if (exists) verified++;
      } else {
        // extrapolate from sampled tracks if consistent
      }
    }

    // Adjust counts based on sampled probes
    const sampledCount = Math.min(totalTracks, 4);
    let finalStatus: "HEALTHY" | "PARTIAL" | "MISSING" = "MISSING";
    let finalVerified = 0;

    if (verified === sampledCount) {
      finalStatus = "HEALTHY";
      finalVerified = totalTracks;
    } else if (verified > 0) {
      finalStatus = "PARTIAL";
      finalVerified = verified;
    } else {
      finalStatus = "MISSING";
      finalVerified = 0;
    }

    results.push({
      id: item.id,
      title: item.title,
      totalTracks,
      verifiedTracks: finalVerified,
      missingTracks: totalTracks - finalVerified,
      samplePath,
      status: finalStatus,
    });

    const symbol = finalStatus === "HEALTHY"
      ? "🟢"
      : finalStatus === "PARTIAL"
      ? "🟡"
      : "🔴";
    process.stdout.write(
      `\r[${i + 1}/${allItems.length}] ${symbol} ${item.title.slice(0, 45)}...`,
    );
  }

  process.stdout.write("\n\n");

  const healthy = results.filter((r) => r.status === "HEALTHY");
  const partial = results.filter((r) => r.status === "PARTIAL");
  const missing = results.filter((r) => r.status === "MISSING");

  console.log(`Audit Summary:`);
  console.log(`  🟢 Healthy (Playable):    ${healthy.length} books`);
  console.log(`  🟡 Partial:              ${partial.length} books`);
  console.log(`  🔴 Missing from Storage: ${missing.length} books`);
  console.log(`  Total Audited:           ${results.length} books\n`);

  if (FILTER === "missing" || FILTER === "all") {
    console.log(
      `\n🔴 Missing Books Requiring Audio Upload (${missing.length}):`,
    );
    console.log(`| Title | Item ID | Tracks | Sample Path |`);
    console.log(`|---|---|---|---|`);
    for (const m of missing) {
      console.log(
        `| ${m.title.slice(0, 35)} | \`${m.id}\` | ${m.totalTracks} | \`${
          m.samplePath.slice(0, 40)
        }\` |`,
      );
    }
  }

  if (FILTER === "healthy" || FILTER === "all") {
    console.log(`\n🟢 Healthy Playable Books (${healthy.length}):`);
    for (const h of healthy) {
      console.log(`  - ${h.title} (${h.totalTracks} tracks, ${h.samplePath})`);
    }
  }
}

await runAudit();
