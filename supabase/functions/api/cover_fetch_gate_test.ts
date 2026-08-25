import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchBookMetadata } from "../_shared/coverFetch.ts";

/** Sequential fetch stub: each call consumes the next canned response. */
function stubFetchSequence(responses: unknown[]): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  const original = globalThis.fetch;
  let i = 0;
  (globalThis as Record<string, unknown>).fetch = ((
    input: RequestInfo | URL,
    _init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push(url);
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

Deno.test("coverFetch: provider result for a different work is rejected, not stored", async () => {
  // The production bug: "Art of War" by Machiavelli got "The Prince" art
  // because iTunes ranked it first for the query. The identity gate must
  // reject it and fall through (here: to a correct second provider).
  const itunesWrongBook = {
    results: [
      {
        trackName: "The Prince",
        artistName: "Niccolo Machiavelli",
        artworkUrl100: "https://example.invalid/prince100.jpg",
      },
    ],
  };
  const openLibraryRightBook = {
    docs: [
      {
        title: "Art of War",
        author_name: ["Niccolo Machiavelli"],
        first_publish_year: 1521,
        cover_i: 12345,
      },
    ],
  };
  const { calls, restore } = stubFetchSequence([
    itunesWrongBook,
    { results: [] }, // iTunes retry without author also finds nothing
    openLibraryRightBook,
    new ArrayBuffer(0), // cover image fetch (unused by assertion)
  ]);
  try {
    const result = await fetchBookMetadata("Art of War", "Nicolo Machiavelli");
    assertEquals(result.metadata?.title, "Art of War");
    // iTunes was consulted but its wrong-work result must not have won.
    assertEquals(
      calls.some((u) => u.includes("itunes.apple.com")),
      true,
    );
    assertEquals(
      calls.some((u) => u.includes("openlibrary.org")),
      true,
    );
  } finally {
    restore();
  }
});

Deno.test("coverFetch: same work with subtitle variant is accepted", async () => {
  const itunes = {
    results: [
      {
        trackName: "Art of War: The Classic Translation",
        artistName: "Niccolo Machiavelli",
        artworkUrl100: "https://example.invalid/aow100.jpg",
      },
    ],
  };
  const { restore } = stubFetchSequence([itunes]);
  try {
    const result = await fetchBookMetadata("Art of War", "Nicolo Machiavelli");
    // Subtitle variants of the SAME work pass the gate.
    assertEquals(result.metadata?.title, "Art of War: The Classic Translation");
  } finally {
    restore();
  }
});
