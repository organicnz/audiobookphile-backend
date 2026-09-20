#!/usr/bin/env -S deno run --allow-all
/* ============================================================================
 * RECONCILE STORAGE CLI — AI & DETERMINISTIC MULTI-TIER RECONCILIATION
 *
 * Usage:
 *   deno run --allow-all --env-file=.env scripts/reconcile_storage.ts             # Dry-run
 *   deno run --allow-all --env-file=.env scripts/reconcile_storage.ts --apply     # Apply DB changes
 *   deno run --allow-all --env-file=.env scripts/reconcile_storage.ts --apply --clean-test-data
 * ========================================================================== */

import { createClient } from "@supabase/supabase-js";
import {
  findBestDeterministicMatch,
  getFolderSummaries,
  matchStorageFolderWithAI,
  refreshStorageIndex,
} from "../supabase/functions/_shared/intelligentStorageResolver.ts";
import {
  StorageRouter,
  tierToPrefix,
} from "../supabase/functions/_shared/storage-router.ts";

interface ReconciledEntry {
  id: string;
  title: string;
  prefix: string;
  tier: string;
  method: string;
  tracks: number;
}

interface MissingEntry {
  id: string;
  title: string;
  tracks?: number;
  reason: string;
}

interface ValidEntry {
  id: string;
  title: string;
  prefix: string;
}

interface AudioFileEntry {
  filename?: string;
  storage_path?: string;
  metadata?: {
    filename?: string;
    relPath?: string;
    path?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
  Deno.env.get("ZHIPU_API_KEY") ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
  );
  Deno.exit(1);
}

const args = Deno.args;
const apply = args.includes("--apply");
const cleanTestData = args.includes("--clean-test-data");

console.log(`\n======================================================`);
console.log(`  Audiobookphile Multi-Tier Storage Reconciliation`);
console.log(
  `  Mode: ${apply ? "APPLY (writing to database)" : "DRY-RUN (preview only)"}`,
);
console.log(`  Clean Test Data: ${cleanTestData ? "YES" : "NO"}`);
console.log(`  Z.AI Enabled: ${zaiApiKey ? "YES (GLM-4)" : "NO"}`);
console.log(`======================================================\n`);

const supabase = createClient(supabaseUrl, serviceRoleKey);

// 1. Index storage
console.log("-> Indexing all B2 storage tiers...");
const index = await refreshStorageIndex(true);
const availableFolders = getFolderSummaries(index);
console.log(
  `   Found ${index.length} objects across ${availableFolders.length} distinct storage folders.\n`,
);

// 2. Fetch catalog items
console.log("-> Fetching real library items from Supabase...");
const { data: books, error } = await supabase
  .from("library_items")
  .select(
    "id, title, author_names_first_last, rel_path, path, audio_files, is_missing",
  )
  .not("title", "like", "PW %");

if (error || !books) {
  console.error("Failed to query library items:", error?.message);
  Deno.exit(1);
}

console.log(`   Found ${books.length} non-test library items in database.\n`);

const reconciled: ReconciledEntry[] = [];
const missing: MissingEntry[] = [];
const alreadyValid: ValidEntry[] = [];

const router = new StorageRouter(supabase);
const claimedPrefixes = new Set<string>();

for (const book of books) {
  const rawAudioFiles = (
    Array.isArray(book.audio_files) ? book.audio_files : []
  ) as AudioFileEntry[];
  if (!rawAudioFiles.length) {
    missing.push({
      id: book.id,
      title: book.title || "Untitled",
      reason: "0 tracks listed in DB",
    });
    if (apply && !book.is_missing) {
      await supabase.from("library_items").update({ is_missing: true }).eq(
        "id",
        book.id,
      );
    }
    continue;
  }

  // 1. Verify if book's current audio path is already valid in B2
  const firstAf = rawAudioFiles[0];
  const existingPath = String(
    firstAf?.metadata?.path || firstAf?.storage_path || "",
  );
  const parsedExisting = existingPath ? router.parsePath(existingPath) : null;
  if (parsedExisting && parsedExisting.tier !== "SUPABASE") {
    const foundEntry = index.find(
      (e) => e.tier === parsedExisting.tier && e.key === parsedExisting.key,
    );
    if (foundEntry) {
      if (foundEntry.prefix) {
        claimedPrefixes.add(`${foundEntry.tier}:::${foundEntry.prefix}`);
      }
      if (apply && book.is_missing) {
        await supabase
          .from("library_items")
          .update({ is_missing: false })
          .eq("id", book.id);
      }
      alreadyValid.push({
        id: book.id,
        title: book.title || "Untitled",
        prefix: existingPath,
      });
      continue;
    }
  }

  const candidateFilenames = rawAudioFiles.map((af) =>
    af.metadata?.filename || af.metadata?.relPath || af.filename || ""
  ).filter(Boolean);

  let matchedEntry = null;
  for (const fn of candidateFilenames) {
    matchedEntry = findBestDeterministicMatch(fn, index);
    if (matchedEntry) break;
  }

  let method = "deterministic";

  // 2. Exact track list signature matching for unreferenced, unclaimed folders
  if (!matchedEntry) {
    const normPunct = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const trackFilenames = new Set(
      rawAudioFiles.map((af) =>
        normPunct(
          String(
            af?.metadata?.filename || af?.filename || af?.metadata?.relPath ||
              "",
          ),
        )
      ).filter((s) => s.length > 0),
    );
    const candidateFolders = availableFolders.filter((f) =>
      f.fileCount === rawAudioFiles.length &&
      !claimedPrefixes.has(`${f.tier}:::${f.prefix}`)
    );
    for (const cf of candidateFolders) {
      const filesInFolder = index.filter((e) =>
        e.tier === cf.tier && e.prefix === cf.prefix
      );
      const matchingCount = filesInFolder.filter((f) =>
        trackFilenames.has(normPunct(f.filename))
      ).length;
      if (matchingCount === rawAudioFiles.length && rawAudioFiles.length > 0) {
        matchedEntry = filesInFolder[0] || null;
        method = "track_signature_match";
        break;
      }
    }
  }

  if (!matchedEntry && zaiApiKey) {
    const unclaimedFolders = availableFolders.filter(
      (f) => !claimedPrefixes.has(`${f.tier}:::${f.prefix}`),
    );
    const aiFolder = await matchStorageFolderWithAI(
      book.title || "",
      book.author_names_first_last || "",
      candidateFilenames,
      unclaimedFolders,
      zaiApiKey,
    );
    if (aiFolder) {
      const inFolder = index.filter((e) =>
        e.tier === aiFolder.tier && e.prefix === aiFolder.prefix
      );
      matchedEntry = inFolder[0] || null;
      method = "ai_semantic";
    }
  }

  if (matchedEntry) {
    claimedPrefixes.add(`${matchedEntry.tier}:::${matchedEntry.prefix}`);
    const prefixStr = matchedEntry.prefix ? `${matchedEntry.prefix}/` : "";
    const winningPrefix = `${tierToPrefix(matchedEntry.tier)}${prefixStr}`;

    // Check if already pointing to this prefix
    const firstAf = rawAudioFiles[0];
    const existingPath = String(
      firstAf.metadata?.path || firstAf.storage_path || "",
    );
    if (existingPath.startsWith(winningPrefix)) {
      alreadyValid.push({
        id: book.id,
        title: book.title || "Untitled",
        prefix: winningPrefix,
      });
      continue;
    }

    const inFolder = index.filter(
      (e) => e.tier === matchedEntry.tier && e.prefix === matchedEntry.prefix,
    );
    const updatedAudioFiles = rawAudioFiles.map((af, idx) => {
      const afMeta = (af.metadata as Record<string, unknown>) || {};
      const fname = String(
        afMeta.filename || af.filename || afMeta.relPath || "",
      ).split("/").pop() || "";
      const normFname = fname.toLowerCase().replace(/[^a-z0-9]/g, "");

      const physicalFile = inFolder.find((e) => e.filename === fname) ||
        inFolder.find((e) =>
          e.filename.toLowerCase() === fname.toLowerCase()
        ) ||
        (normFname.length >= 6
          ? inFolder.find(
            (e) =>
              e.filename.toLowerCase().replace(/[^a-z0-9]/g, "") === normFname,
          )
          : null) ||
        inFolder[idx];

      const physicalName = physicalFile ? physicalFile.filename : fname;
      const canonical = `${winningPrefix}${physicalName}`;
      return {
        ...af,
        storage_path: canonical,
        metadata: {
          ...afMeta,
          path: canonical,
          filename: physicalName,
          ...(physicalFile?.size ? { size: physicalFile.size } : {}),
        },
      };
    });

    if (apply) {
      await supabase.from("library_items").update({
        audio_files: updatedAudioFiles,
        is_missing: false,
      }).eq("id", book.id);
    }

    reconciled.push({
      id: book.id,
      title: book.title || "Untitled",
      prefix: winningPrefix,
      tier: matchedEntry.tier,
      method,
      tracks: rawAudioFiles.length,
    });
  } else {
    missing.push({
      id: book.id,
      title: book.title || "Untitled",
      tracks: rawAudioFiles.length,
      reason: "No physical audio files found in B2",
    });
    if (apply && !book.is_missing) {
      await supabase.from("library_items").update({ is_missing: true }).eq(
        "id",
        book.id,
      );
    }
  }
}

// 3. Clean test data if requested
let cleanedTestCount = 0;
if (cleanTestData && apply) {
  console.log("-> Cleaning orphaned 'PW %' and fixture test items...");
  const { data: pwItems } = await supabase
    .from("library_items")
    .select("id")
    .or("title.like.PW %,title.like.%Fixture%");
  const ids = pwItems?.map((i: { id: string }) => i.id) || [];
  if (ids.length > 0) {
    await supabase.from("media_progress").delete().in("library_item_id", ids);
    await supabase.from("book_authors").delete().in("library_item_id", ids);
    await supabase.from("book_series").delete().in("library_item_id", ids);
    await supabase.from("collection_items").delete().in("library_item_id", ids);
    const { data: deleted } = await supabase
      .from("library_items")
      .delete()
      .in("id", ids)
      .select("id");
    cleanedTestCount = deleted?.length || 0;
  }
  console.log(`   Deleted ${cleanedTestCount} orphaned test library items.\n`);
}

// 4. Report
console.log(`======================================================`);
console.log(`  RECONCILIATION REPORT`);
console.log(`======================================================`);
console.log(`Total Books Scanned:        ${books.length}`);
console.log(`Already Valid:              ${alreadyValid.length}`);
console.log(`Newly Reconciled:           ${reconciled.length}`);
console.log(`Missing Physical Audio:     ${missing.length}`);
if (cleanTestData) {
  console.log(`Cleaned Test Items:         ${cleanedTestCount}`);
}
console.log(`======================================================\n`);

if (reconciled.length > 0) {
  console.log(`-> Newly Reconciled Books:`);
  for (const r of reconciled) {
    console.log(
      `   ✓ [${r.tier}] "${r.title}" (${r.tracks} tracks, method: ${r.method})`,
    );
    console.log(`     Prefix: ${r.prefix}`);
  }
  console.log();
}

if (!apply) {
  console.log(
    `NOTE: This was a DRY-RUN. Run with '--apply' to persist these updates to Supabase.\n`,
  );
} else {
  console.log(
    `SUCCESS: All updates successfully applied to Supabase database!\n`,
  );
}
