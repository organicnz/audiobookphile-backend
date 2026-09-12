import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluatePasswordStrength,
  LoginBodySchema,
  SignupBodySchema,
} from "./_shared/domain/auth.ts";
import { resolveTitleAndAuthor } from "./_shared/domain/downloads.ts";
import {
  LibraryItemsCache,
  parseSortParams,
} from "./_shared/domain/libraries.ts";
import {
  generateManifest,
  normalizeAudioFile,
  resolveSyncConflict,
  type SyncInput,
} from "./_shared/domain/playback.ts";

// === Auth Domain Tests ===
Deno.test("Auth Domain: evaluatePasswordStrength evaluates complexity", () => {
  const weak = evaluatePasswordStrength("short");
  assertEquals(weak.score < 2, true);
  assertEquals(weak.feedback.length > 0, true);

  const strong = evaluatePasswordStrength("P@ssw0rd123!Robust");
  assertEquals(strong.score >= 3, true);
  assertEquals(strong.feedback.length, 0);
});

Deno.test("Auth Domain: Zod schemas validate input", () => {
  const validLogin = LoginBodySchema.safeParse({
    username: "user@example.com",
    password: "validpassword123",
  });
  assertEquals(validLogin.success, true);

  const invalidLogin = LoginBodySchema.safeParse({
    username: "",
    password: "",
  });
  assertEquals(invalidLogin.success, false);

  const validSignup = SignupBodySchema.safeParse({
    email: "user@example.com",
    password: "securePassword123!",
  });
  assertEquals(validSignup.success, true);
});

// === Downloads Domain Tests ===
Deno.test("Downloads Domain: resolveTitleAndAuthor extracts metadata from filename", async () => {
  const res1 = await resolveTitleAndAuthor(
    "Brandon Sanderson - Mistborn.m4b",
    "",
    "",
  );
  assertEquals(res1.title, "Mistborn.m4b");
  assertEquals(res1.author, "Brandon Sanderson");

  const res2 = await resolveTitleAndAuthor(
    "Essential CISSP by Phil Martin",
    "",
    "",
  );
  assertEquals(res2.title, "Essential CISSP");
  assertEquals(res2.author, "Phil Martin");

  const res3 = await resolveTitleAndAuthor("UnknownAudiobook.mp3", "", "");
  assertEquals(res3.title, "UnknownAudiobook.mp3");
  assertEquals(res3.author, "Unknown Author");
});

// === Libraries Domain Tests ===
Deno.test("Libraries Domain: LibraryItemsCache sets, gets, and invalidates", () => {
  const cache = new LibraryItemsCache();
  const mockItems = [{ id: "book-1", title: "Test Book" }];
  const key = cache.buildKey("lib-1", { filter: "all" });

  cache.set(key, mockItems, 1);
  const cached = cache.get(key);
  assertEquals(cached !== null, true);
  assertEquals(cached?.items, mockItems);
  assertEquals(cached?.count, 1);

  cache.invalidateLibrary("lib-1");
  assertEquals(cache.get(key), null);
});

Deno.test("Libraries Domain: parseSortParams correctly parses column and order", () => {
  assertEquals(parseSortParams("title", false), {
    column: "title",
    ascending: true,
  });
  assertEquals(parseSortParams("author_names_first_last", true), {
    column: "author_names_first_last",
    ascending: false,
  });
  assertEquals(parseSortParams("created_at", true), {
    column: "created_at",
    ascending: false,
  });
  assertEquals(parseSortParams("invalid_col", false), {
    column: "created_at",
    ascending: true,
  });
});

// === Playback Domain Tests ===
Deno.test("Playback Domain: normalizeAudioFile standardizes various shapes", () => {
  const raw1 = {
    index: 1,
    ino: "123",
    metadata: {
      filename: "chapter1.mp3",
      size: 5000000,
    },
    duration: 1200,
  };
  const norm1 = normalizeAudioFile(raw1, 0);
  assertEquals(norm1.index, 1);
  assertEquals(norm1.filename, "chapter1.mp3");
  assertEquals(norm1.duration, 1200);

  const raw2 = {
    index: 2,
    filename: "track02.m4b",
    duration: 3600,
    size: 20000000,
  };
  const norm2 = normalizeAudioFile(raw2, 1);
  assertEquals(norm2.index, 2);
  assertEquals(norm2.filename, "track02.m4b");
  assertEquals(norm2.duration, 3600);
});

Deno.test("Playback Domain: resolveSyncConflict chooses latest progress safely", () => {
  const client: SyncInput = {
    currentTime: 500,
    duration: 1000,
    updatedAt: 1700000100,
    isFinished: false,
  };
  const server: SyncInput = {
    currentTime: 400,
    duration: 1000,
    updatedAt: 1700000000,
    isFinished: false,
  };

  const result = resolveSyncConflict(client, server);
  assertEquals(result.currentTime, 500);
  assertEquals(result.winner, "client");

  // Server updated much later and client is not far ahead
  const client2: SyncInput = {
    currentTime: 100,
    duration: 1000,
    updatedAt: 1700000000,
    isFinished: false,
  };
  const server2: SyncInput = {
    currentTime: 102,
    duration: 1000,
    updatedAt: 1700000500,
    isFinished: false,
  };
  const result2 = resolveSyncConflict(client2, server2);
  assertEquals(result2.currentTime, 102);
  assertEquals(result2.winner, "server");
});

Deno.test("Playback Domain: generateManifest calculates cumulative offsets", () => {
  const files = [
    normalizeAudioFile({
      index: 0,
      filename: "part1.mp3",
      duration: 100,
      size: 1000,
    }, 0),
    normalizeAudioFile({
      index: 1,
      filename: "part2.mp3",
      duration: 150,
      size: 1500,
    }, 1),
    normalizeAudioFile({
      index: 2,
      filename: "part3.mp3",
      duration: 200,
      size: 2000,
    }, 2),
  ];

  const signedUrls = new Map<string, string>([
    ["part1.mp3", "https://signed.url/1"],
    ["part2.mp3", "https://signed.url/2"],
    ["part3.mp3", "https://signed.url/3"],
  ]);

  const manifest = generateManifest("book-1", files, signedUrls);
  assertEquals(manifest.mediaItemId, "book-1");
  assertEquals(manifest.totalDuration, 450);
  assertEquals(manifest.tracks.length, 3);
  assertEquals(manifest.tracks[0].startOffset, 0);
  assertEquals(manifest.tracks[1].startOffset, 100);
  assertEquals(manifest.tracks[2].startOffset, 250);
});
