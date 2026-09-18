// Restore missing author avatars to Supabase storage.
// Uses the 3-tier waterfall in supabase/functions/_shared/avatarFetcher.ts:
//   1. Wikipedia API (500px thumb)
//   2. OpenLibrary API
//   3. DiceBear deterministic SVG fallback
//
// Usage:
//   deno run --allow-all --env-file=.env scripts/restore_author_avatars.ts [--force] [--limit N]

import { createClient } from "@supabase/supabase-js";
import { fetchAuthorAvatar } from "../supabase/functions/_shared/avatarFetcher.ts";

const url = Deno.env.get("SUPABASE_URL") ||
  Deno.env.get("NEXT_PUBLIC_SUPABASE_URL") || "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_KEY") || "";

if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  Deno.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const args = Deno.args;
const force = args.includes("--force");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : undefined;

console.log("\n======================================================");
console.log("  Audiobookphile Author Avatar Recovery Pipeline");
console.log("======================================================\n");

const { data: authors, error } = await supabase
  .from("authors")
  .select("id, name, image_path")
  .order("name", { ascending: true });

if (error || !authors) {
  console.error("Failed to query authors:", error);
  Deno.exit(1);
}

console.log(`Found ${authors.length} author(s) in database.`);

let processed = 0;
let existing = 0;
let restored = 0;
let failed = 0;

for (const author of authors) {
  if (limit && processed >= limit) break;
  processed++;

  if (!author.name || author.name.trim() === "") {
    continue;
  }

  const existingPath = author.image_path;
  let needsFetch = force || !existingPath || existingPath === "missing";

  if (!needsFetch && existingPath) {
    // Check if the object actually exists in storage
    const cleanPath = existingPath.replace(/^covers\//, "");
    try {
      const { data: blob, error: downloadErr } = await supabase.storage
        .from("covers")
        .download(cleanPath);

      if (downloadErr || !blob) {
        needsFetch = true;
      }
    } catch {
      needsFetch = true;
    }
  }

  if (!needsFetch) {
    existing++;
    console.log(
      `[${processed}/${authors.length}] 🟢 ${author.name}: already in storage (${existingPath})`,
    );
    continue;
  }

  console.log(
    `[${processed}/${authors.length}] 🔄 ${author.name}: fetching avatar...`,
  );
  try {
    const storagePath = await fetchAuthorAvatar(supabase, {
      id: author.id,
      name: author.name,
    });

    if (storagePath) {
      const { error: updateErr } = await supabase
        .from("authors")
        .update({ image_path: storagePath })
        .eq("id", author.id);

      if (updateErr) {
        console.warn(
          `  ⚠️  DB update failed for ${author.name}:`,
          updateErr.message,
        );
        failed++;
      } else {
        restored++;
        console.log(`  ✅ Restored -> ${storagePath}`);
      }
    } else {
      console.warn(`  ❌ No avatar returned for ${author.name}`);
      failed++;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Error fetching avatar for ${author.name}:`, msg);
    failed++;
  }

  // Graceful rate pacing between requests
  await new Promise((r) => setTimeout(r, 150));
}

console.log("\n======================================================");
console.log("  Author Avatar Recovery Summary");
console.log("======================================================");
console.log(`Total Authors Checked: ${processed}`);
console.log(`Already In Storage:    ${existing}`);
console.log(`Successfully Restored: ${restored}`);
console.log(`Failed / Skipped:      ${failed}`);
console.log("======================================================\n");
