import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enrichMetadataWithZAI,
  matchExistingBookWithZAI,
} from "../_shared/zai.ts";

const FAKE_KEY = "fake-key";

/** Stub the GLM chat-completions endpoint with a canned completion. */
function stubZai(content: string): void {
  (globalThis as Record<string, unknown>).fetch = (
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content } }],
          }),
          { status: 200 },
        ),
      )
  ) as typeof fetch;
}

function resetFetch(): void {
  delete (globalThis as Record<string, unknown>).fetch;
}

Deno.test("zai gate: rejects LLM match of distinct book by same author", async () => {
  // The production incident: model matched Sapiens onto Homo Deus despite
  // explicit instructions. The gate must reject it.
  stubZai(`{"matchedId": "homo-deus-id"}`);
  try {
    const matched = await matchExistingBookWithZAI(
      "Sapiens",
      "Yuval Noah Harari",
      [
        {
          id: "homo-deus-id",
          title: "Homo Deus: A Brief History of Tomorrow",
          author_names_first_last: "Yuval Noah Harari",
        },
      ],
      FAKE_KEY,
    );
    assertEquals(matched, null);
  } finally {
    resetFetch();
  }
});

Deno.test("zai gate: accepts legitimate subtitle-variant match", async () => {
  stubZai(`{"matchedId": "sapiens-id"}`);
  try {
    const matched = await matchExistingBookWithZAI(
      "Sapiens",
      "Yuval Noah Harari",
      [
        {
          id: "sapiens-id",
          title: "Sapiens: A Brief History of Humankind",
          author_names_first_last: "Yuval Noah Harari",
        },
      ],
      FAKE_KEY,
    );
    assertEquals(matched, "sapiens-id");
  } finally {
    resetFetch();
  }
});

Deno.test("zai gate: enrichment returning a different work cannot rename the book", async () => {
  stubZai(
    `{"title": "Homo Deus", "author": "Yuval Noah Harari", "description": "wrong book", "genres": ["History"]}`,
  );
  try {
    const enriched = await enrichMetadataWithZAI(
      "Sapiens Unique Gate Check",
      "Yuval Noah Harari",
      FAKE_KEY,
    );
    assertEquals(enriched?.title, undefined);
    assertEquals(enriched?.author, undefined);
    assertEquals(enriched?.description, "wrong book"); // descriptive fields pass through
  } finally {
    resetFetch();
  }
});
