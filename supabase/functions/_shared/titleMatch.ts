/**
 * Deterministic title-similarity validation for LLM outputs.
 *
 * glm-4-flash occasionally violates its own matching instructions (e.g.
 * matching "Sapiens" to "Homo Deus" because both are by Yuval Noah Harari),
 * which has merged distinct books in production. LLM guardrails are not
 * enforcement: every LLM-proposed book identity must pass this code-level
 * gate before it is trusted.
 */

const NOISE_WORDS =
  /\b(audiobook|audio|book|books|unabridged|abridged|edition|anniversary|updated|revised|complete|collection|narrated|narration|reading|recorded|version|mp3|m4b|cd|disc|disk|part|pt|vol|volume|chapters?)\b/gi;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "for",
  "to",
  "in",
  "on",
  "by",
  "is",
  "it",
  "its",
  "de",
  "la",
  "le",
  "les",
  "du",
  "der",
  "die",
  "das",
]);

/** Aggressive normalization: lowercase, strip diacritics, brackets, punctuation, noise/edition markers. */
export function normalizeTitleForMatch(title: string): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(NOISE_WORDS, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant tokens with stopwords removed. */
export function significantTokens(title: string): string[] {
  return normalizeTitleForMatch(title)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Whether two titles plausibly refer to the same work. Deliberately strict:
 * distinct works by the same author ("Sapiens" vs "Homo Deus") share zero
 * significant tokens and must fail, while subtitle variants
 * ("Sapiens" vs "Sapiens: A Brief History of Humankind") must pass via containment.
 */
export function titlesLikelySameWork(
  a: string,
  b: string,
): boolean {
  const tokensA = significantTokens(a);
  const tokensB = significantTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  // Exact normalized equality or full containment (title vs title+subtitle).
  const aInB = [...setA].every((t) => setB.has(t));
  const bInA = [...setB].every((t) => setA.has(t));
  if (aInB || bInA) return true;

  // Otherwise require meaningful token overlap (Jaccard).
  return jaccard(setA, setB) >= 0.5;
}
