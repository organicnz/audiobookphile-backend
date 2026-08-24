import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizeTitleForMatch,
  significantTokens,
  titlesLikelySameWork,
} from "../_shared/titleMatch.ts";

Deno.test("titleMatch: normalization strips noise, brackets, punctuation, diacritics", () => {
  assertEquals(
    normalizeTitleForMatch(
      "Sapiens: A Brief History of Humankind (Unabridged)",
    ),
    "sapiens a brief history of humankind",
  );
  assertEquals(
    normalizeTitleForMatch("L'Étranger [Audiobook]"),
    "l etranger",
  );
});

Deno.test("titleMatch: stopwords excluded from significant tokens", () => {
  assertEquals(significantTokens("The Art of War"), ["art", "war"]);
});

Deno.test("titleMatch: distinct books by the same author must NEVER match", () => {
  // The exact production failure: glm-4-flash merged these despite instructions.
  assertEquals(titlesLikelySameWork("Sapiens", "Homo Deus"), false);
  assertEquals(
    titlesLikelySameWork("Sapiens", "21 Lessons for the 21st Century"),
    false,
  );
  assertEquals(
    titlesLikelySameWork("The Hobbit", "The Fellowship of the Ring"),
    false,
  );
  assertEquals(
    titlesLikelySameWork("Meditations", "The Art of War"),
    false,
  );
});

Deno.test("titleMatch: subtitle and formatting variants MUST match", () => {
  assertEquals(
    titlesLikelySameWork("Sapiens", "Sapiens: A Brief History of Humankind"),
    true,
  );
  assertEquals(titlesLikelySameWork("The Art of War", "Art of War"), true);
  assertEquals(
    titlesLikelySameWork(
      "Atomic Habits (Unabridged)",
      "Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones",
    ),
    true,
  );
  assertEquals(
    titlesLikelySameWork("Dune", "DUNE"),
    true,
  );
});

Deno.test("titleMatch: partial overlap below threshold fails", () => {
  // Shares one generic token but is clearly a different work.
  assertEquals(
    titlesLikelySameWork("The War of Art", "War and Peace"),
    false,
  );
});
