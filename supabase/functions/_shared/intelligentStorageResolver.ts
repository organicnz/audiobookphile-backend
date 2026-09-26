/* ============================================================================
 * INTELLIGENT STORAGE RESOLVER — AI & DETERMINISTIC MULTI-TIER SELF-HEALING
 *
 * PURPOSE: Connects audiobooks in library_items to physical audio objects in B2
 * when standard path/ID candidate probes fail (e.g. legacy folder UUIDs
 * from previous Audiobookshelf/SQLite imports).
 *
 * STRATEGY:
 *   1. In-memory cached B2 storage index across all configured tiers.
 *   2. Fast deterministic filename match (exact, URI-decoded, normalized).
 *   3. AI-powered semantic matching via Z.AI (GLM-4) when track names or
 *      folder structures differ, strictly gated by titlesLikelySameWork.
 *   4. Verified byte existence via HeadObjectCommand before presigning.
 * ========================================================================== */

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from "npm:@aws-sdk/client-s3@^3.693.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@^3.693.0";

import { BucketTier } from "./b2-types.ts";
import { getConfig, isTierConfigured } from "./b2-config.ts";
import { getB2Client } from "./b2-bucket-pool.ts";
import { StorageRouter, tierToPrefix } from "./storage-router.ts";
import { titlesLikelySameWork } from "./titleMatch.ts";
import { ZAI_CHAT_MODEL } from "./zai.ts";

export interface StorageIndexEntry {
  tier: BucketTier;
  prefix: string;
  key: string;
  filename: string;
  size?: number;
}

export interface StorageFolderSummary {
  tier: BucketTier;
  prefix: string;
  sampleFilenames: string[];
  fileCount: number;
}

export interface ResolvedBookStorage {
  tier: BucketTier;
  winningPrefix: string;
  signedUrl: string;
  canonicalPath: string;
  matchedBy: "deterministic" | "ai_semantic";
}

let cachedIndex: StorageIndexEntry[] | null = null;
let indexExpiresAt = 0;
const INDEX_TTL_MS = 60 * 60 * 1000; // 1 hour TTL

/**
 * Lists all objects across all configured B2 tiers and caches the catalog.
 */
export async function refreshStorageIndex(
  force = false,
): Promise<StorageIndexEntry[]> {
  if (!force && cachedIndex && Date.now() < indexExpiresAt) {
    return cachedIndex;
  }

  const tiers: BucketTier[] = [
    "B2",
    "B2_SECONDARY",
    "B2_TERTIARY",
    "B2_QUARTET",
    "B2_QUINTET",
  ];

  const configuredTiers = tiers.filter((t) => isTierConfigured(t));
  const entries: StorageIndexEntry[] = [];

  for (const tier of configuredTiers) {
    try {
      const client = getB2Client(tier);
      const bucket = getConfig(tier).bucketName;
      let continuationToken: string | undefined = undefined;

      do {
        const res: ListObjectsV2CommandOutput = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
          }),
        );

        if (res.Contents) {
          for (const item of res.Contents) {
            if (!item.Key) continue;
            const parts = item.Key.split("/");
            const filename = parts[parts.length - 1] || "";
            const prefix = parts.length > 1 ? parts.slice(0, -1).join("/") : "";

            entries.push({
              tier,
              prefix,
              key: item.Key,
              filename,
              size: item.Size,
            });
          }
        }
        continuationToken = res.NextContinuationToken;
      } while (continuationToken);
    } catch (err: unknown) {
      console.warn(
        `[IntelligentStorageResolver] Failed to index tier ${tier}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  cachedIndex = entries;
  indexExpiresAt = Date.now() + INDEX_TTL_MS;
  console.info(
    `[IntelligentStorageResolver] Indexed ${entries.length} total objects across B2 storage tiers.`,
  );
  return entries;
}

/**
 * Detects if a filename is a generic sequence number (e.g. "1.mp3", "Chapter 1.mp3", "01.mp3")
 * where matching across folders without multi-track confirmation would be unsafe.
 */
export function isGenericTrackFilename(filename: string): boolean {
  const base = filename.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "").trim()
    .toLowerCase() || "";
  return /^(track|chapter|disc|disk|cd|part)?[\s_-]*\d{1,4}$/i.test(base);
}

/**
 * Fast deterministic match of a filename against the cached storage index.
 * Generic names ("1.mp3", "Chapter 1.mp3") are rejected unless they match specific patterns.
 */
export function findBestDeterministicMatch(
  filename: string,
  index: StorageIndexEntry[],
): StorageIndexEntry | null {
  if (!filename) return null;
  const clean = filename.split("/").pop() || "";
  if (!clean) return null;

  // Refuse single-file match on purely generic sequence names (e.g. "1.mp3")
  if (isGenericTrackFilename(clean)) {
    return null;
  }

  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // ignore
  }

  const lowerClean = clean.toLowerCase();
  const lowerDecoded = decoded.toLowerCase();

  // 1. Exact match on raw or decoded filename
  const exact = index.find(
    (e) => e.filename === clean || e.filename === decoded,
  );
  if (exact) return exact;

  // 2. Case-insensitive match
  const caseMatch = index.find((e) => {
    const fn = e.filename.toLowerCase();
    return fn === lowerClean || fn === lowerDecoded;
  });
  if (caseMatch) return caseMatch;

  // 3. Punctuation-normalized alphanumeric match
  const normClean = lowerClean.replace(/[^a-z0-9]/g, "");
  if (normClean.length >= 6) {
    const normMatch = index.find((e) => {
      const fnNorm = e.filename.toLowerCase().replace(/[^a-z0-9]/g, "");
      return fnNorm === normClean;
    });
    if (normMatch) return normMatch;
  }

  return null;
}

/**
 * Groups indexed files into folder summaries for AI semantic matching.
 */
export function getFolderSummaries(
  index: StorageIndexEntry[],
): StorageFolderSummary[] {
  const map = new Map<string, StorageFolderSummary>();

  for (const entry of index) {
    if (!entry.prefix) continue;
    const folderKey = `${entry.tier}:::${entry.prefix}`;
    if (!map.has(folderKey)) {
      map.set(folderKey, {
        tier: entry.tier,
        prefix: entry.prefix,
        sampleFilenames: [],
        fileCount: 0,
      });
    }
    const folder = map.get(folderKey)!;
    folder.fileCount++;
    if (folder.sampleFilenames.length < 5 && entry.filename) {
      folder.sampleFilenames.push(entry.filename);
    }
  }

  return Array.from(map.values());
}

/**
 * Narrows storage folders to those that could plausibly hold `trackCount`
 * tracks, using only local arithmetic.
 *
 * This is the gate that keeps reconciliation affordable. Every audiobook's
 * tracks live in one folder, so a 343-track book cannot be sitting in a
 * 9-file folder. Consulting the model without this check meant one LLM call per
 * unmatched book -- the nightly reconcile made ~73 sequential model calls in a
 * single edge invocation and died with WORKER_RESOURCE_LIMIT (HTTP 546) every
 * night, so the storage index never actually got reconciled.
 *
 * The window is deliberately generous: it only has to exclude the obviously
 * impossible, because a false negative here means a real book is never
 * repaired. Book scans routinely miss or gain a file or two (a stray
 * `cover.jpg`, an `.m4b` that didn't convert), so ±25% plus a small absolute
 * cushion is the right trade.
 */
export function filterPlausibleFolders(
  folders: StorageFolderSummary[],
  trackCount: number,
): StorageFolderSummary[] {
  if (trackCount <= 0) return [];
  const tolerance = Math.max(3, Math.ceil(trackCount * 0.25));
  const min = Math.max(1, trackCount - tolerance);
  const max = trackCount + tolerance;
  return folders.filter((f) => f.fileCount >= min && f.fileCount <= max);
}

/**
 * AI Semantic Matcher: Uses Z.AI (GLM-4) to match an audiobook to an unindexed B2 storage folder.
 * Enforces strict titlesLikelySameWork validation to avoid false merges.
 */
export async function matchStorageFolderWithAI(
  bookTitle: string,
  bookAuthor: string,
  sampleTrackNames: string[],
  availableFolders: StorageFolderSummary[],
  zaiApiKey: string,
): Promise<StorageFolderSummary | null> {
  if (!bookTitle || availableFolders.length === 0 || !zaiApiKey) {
    return null;
  }

  // Pre-filter candidate folders: only pass folders that have at least some keyword relevance
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "part",
    "vol",
    "chapter",
    "audiobook",
    "edition",
    "unabridged",
    "collection",
  ]);
  const searchTerms = `${bookTitle} ${bookAuthor || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  const candidateFolders = availableFolders.filter((f) => {
    const text = `${f.prefix} ${f.sampleFilenames.join(" ")}`.toLowerCase();
    return searchTerms.some((term) => text.includes(term));
  });

  if (candidateFolders.length === 0) {
    return null;
  }

  // Cap candidate folders to top 10 most relevant to keep prompt lean and fast
  const targetFolders = candidateFolders.slice(0, 10);

  try {
    const prompt =
      `You are an authoritative digital audiobook librarian and storage auditor.
Match this audiobook to the single storage folder where its audio files are stored:

Target Book:
- Title: "${bookTitle}"
- Author: "${bookAuthor || "Unknown"}"
- Sample Expected Tracks: ${JSON.stringify(sampleTrackNames.slice(0, 5))}

Available Candidate Folders:
${
        JSON.stringify(
          targetFolders.map((f) => ({
            tier: f.tier,
            prefix: f.prefix,
            sampleFiles: f.sampleFilenames,
            fileCount: f.fileCount,
          })),
        )
      }

CRITICAL RULES:
1. Different books by the same author (e.g. "Sapiens" vs "Homo Deus" vs "21 Lessons") MUST NEVER MATCH.
2. Different volumes in a series (e.g. Vol 1 vs Vol 2) MUST NEVER MATCH.
3. Match ONLY if the sample files or folder represent the EXACT same work (ignoring subtitle differences or narrator tags).
4. Return ONLY a valid JSON object: {"matchedPrefix": "prefix-string", "matchedTier": "TIER_NAME"} or {"matchedPrefix": null, "matchedTier": null}`;

    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ZAI_CHAT_MODEL,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: prompt }],
          temperature: 0.0,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed.matchedPrefix) {
          const matchedFolder = targetFolders.find(
            (f) =>
              f.prefix === parsed.matchedPrefix &&
              (!parsed.matchedTier || f.tier === parsed.matchedTier),
          );

          if (matchedFolder) {
            // Deterministic code-level safety gate
            const folderText = matchedFolder.sampleFilenames.join(" ");
            const isCorroborated =
              titlesLikelySameWork(bookTitle, folderText) ||
              matchedFolder.sampleFilenames.some((fn) =>
                titlesLikelySameWork(bookTitle, fn)
              );

            if (!isCorroborated) {
              console.warn(
                `[IntelligentStorageResolver] REJECTED AI match "${bookTitle}" → prefix "${matchedFolder.prefix}": titles failed safety gate.`,
              );
              return null;
            }

            console.info(
              `[IntelligentStorageResolver] AI matched "${bookTitle}" to storage prefix "${matchedFolder.prefix}" on tier ${matchedFolder.tier}`,
            );
            return matchedFolder;
          }
        }
      }
    }
  } catch (err: unknown) {
    console.warn(
      `[IntelligentStorageResolver] AI matching error for "${bookTitle}":`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return null;
}

/**
 * Main Resolver: Resolves a library item to its real B2 storage path and presigns track 0.
 */
export async function resolveBookStorage(
  item: Record<string, unknown>,
  firstTrack: { filename: string; storagePath: string },
  expiresIn = 604800,
  options: { useAI?: boolean } = {},
): Promise<ResolvedBookStorage | null> {
  // Deterministic-first, AI-second. The AI folder matcher costs a network
  // round trip and is the slowest step in the whole resolver, so callers can
  // run the cheap filename pass on a short budget and only escalate to the
  // model once that has failed. Matching was previously all-or-nothing behind
  // a single 3.5s race in playbackService, which reliably killed the AI stage
  // before it could ever answer.
  const useAI = options.useAI ?? true;
  const index = await refreshStorageIndex();
  if (!index || index.length === 0) {
    return null;
  }

  // 0. Try existing storage path if already specified on firstTrack
  const router = new StorageRouter(null);
  const parsedFirst = firstTrack.storagePath
    ? router.parsePath(firstTrack.storagePath)
    : null;
  let matchedEntry: StorageIndexEntry | null = null;
  if (parsedFirst && parsedFirst.tier !== "SUPABASE") {
    matchedEntry = index.find(
      (e) => e.tier === parsedFirst.tier && e.key === parsedFirst.key,
    ) || null;
  }

  // 1. Try deterministic match using candidate filenames
  const rawAudioFiles = Array.isArray(item.audio_files) ? item.audio_files : [];
  const candidateFilenames = [
    firstTrack.filename,
    ...rawAudioFiles.map((af: any) =>
      af?.metadata?.filename || af?.metadata?.relPath || af?.filename || ""
    ),
  ].filter(Boolean);

  if (!matchedEntry) {
    for (const fn of candidateFilenames) {
      matchedEntry = findBestDeterministicMatch(fn, index);
      if (matchedEntry) break;
    }
  }

  let matchedBy: "deterministic" | "ai_semantic" = "deterministic";

  // 2. If deterministic fails, invoke AI semantic matcher
  if (!matchedEntry && useAI) {
    const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
      Deno.env.get("ZHIPU_API_KEY") ?? "";
    if (zaiApiKey) {
      const folders = getFolderSummaries(index);
      const matchedFolder = await matchStorageFolderWithAI(
        String(item.title || ""),
        String(item.author_names_first_last || ""),
        candidateFilenames,
        folders,
        zaiApiKey,
      );

      if (matchedFolder) {
        // Find matching key within that folder
        const inFolder = index.filter(
          (e) =>
            e.tier === matchedFolder.tier && e.prefix === matchedFolder.prefix,
        );
        matchedEntry = inFolder.find((e) =>
          findBestDeterministicMatch(firstTrack.filename, [e])
        ) || inFolder[0] || null;
        matchedBy = "ai_semantic";
      }
    }
  }

  if (!matchedEntry) {
    return null;
  }

  // 3. Verify object existence via HeadObjectCommand
  try {
    const client = getB2Client(matchedEntry.tier);
    const bucket = getConfig(matchedEntry.tier).bucketName;

    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: matchedEntry.key,
      }),
    );

    const signedUrl = await getSignedUrl(
      // @ts-ignore
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: matchedEntry.key,
      }),
      { expiresIn },
    );

    const prefixStr = matchedEntry.prefix ? `${matchedEntry.prefix}/` : "";
    const winningPrefix = `${tierToPrefix(matchedEntry.tier)}${prefixStr}`;
    const canonicalPath = `${
      tierToPrefix(matchedEntry.tier)
    }${matchedEntry.key}`;

    return {
      tier: matchedEntry.tier,
      winningPrefix,
      signedUrl,
      canonicalPath,
      matchedBy,
    };
  } catch (probeErr: unknown) {
    console.warn(
      `[IntelligentStorageResolver] HeadObject verification failed for key "${matchedEntry.key}" on ${matchedEntry.tier}:`,
      probeErr instanceof Error ? probeErr.message : String(probeErr),
    );
    return null;
  }
}
