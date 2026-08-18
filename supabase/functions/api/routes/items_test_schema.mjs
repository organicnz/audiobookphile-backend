// Test Zod schemas with real data (same as what would be sent to the Supabase function)
import { z } from "./test-zod.js";

const checkExistingSchema = z.object({
  title: z.string().max(256),
  author: z.string().max(256).optional(),
  libraryId: z.string().min(1),
  mediaType: z.enum(["book", "podcast"]).default("book"),
});

const FuzzySearchSchema = z.object({
  title: z.string().max(256),
  author: z.string().max(256).optional(),
  mediaType: z.enum(["book", "podcast"]).default("book"),
  libraryId: z.string().min(1),
});

console.log("\n=== Schema Validation Tests ===\n");

// Test 1: Normal data (should pass)
const normalData = {
  title: "The Great Gatsby",
  author: "F. Scott Fitzgerald",
  libraryId: "lib-001",
};
const result1 = checkExistingSchema.safeParse(normalData);
console.log(
  "✓ Test 1 - Normal book:",
  result1.success
    ? "PASS ✓"
    : `FAIL (errors: ${JSON.stringify(result1.error.flatten().fieldErrors)})`,
);

// Test 2: Author with exactly 256 chars (should pass)
const exact256Author = {
  title: "A",
  author: "x".repeat(256),
  libraryId: "lib-002",
};
const result2 = checkExistingSchema.safeParse(exact256Author);
console.log(
  "✓ Test 2 - Author at exactly 256 chars:",
  result2.success ? "PASS ✓" : `FAIL`,
);

// Test 3: Author with 257 chars (should fail)
const tooLongAuthor = {
  title: "A",
  author: "x".repeat(257),
  libraryId: "lib-003",
};
const result3 = checkExistingSchema.safeParse(tooLongAuthor);
console.log(
  "✓ Test 3 - Author with 257 chars:",
  !result3.success ? "PASS ✓ (rejected)" : `FAIL`,
);

// Test 4: Title with exactly 256 chars (should pass)
const exact256Title = {
  title: "x".repeat(256),
  author: "Test",
  libraryId: "lib-004",
};
const result4 = checkExistingSchema.safeParse(exact256Title);
console.log(
  "✓ Test 4 - Title at exactly 256 chars:",
  result4.success ? "PASS ✓" : `FAIL`,
);

// Test 5: Title with 257 chars (should fail)
const tooLongTitle = {
  title: "x".repeat(257),
  author: "Test",
  libraryId: "lib-005",
};
const result5 = checkExistingSchema.safeParse(tooLongTitle);
console.log(
  "✓ Test 5 - Title with 257 chars:",
  !result5.success ? "PASS ✓ (rejected)" : `FAIL`,
);

// Test 6: Missing author (should pass, optional)
const noAuthor = { title: "Book", libraryId: "lib-006" };
const result6 = checkExistingSchema.safeParse(noAuthor);
console.log(
  "✓ Test 6 - Missing optional author:",
  result6.success ? "PASS ✓" : `FAIL`,
);

// Test FuzzySearchSchema separately
console.log("\n--- FuzzySearch Schema Tests ---\n");
const fuzzyValid = { title: "Book", libraryId: "lib-fz-1" };
const result7 = FuzzySearchSchema.safeParse(fuzzyValid);
console.log("✓ FuzzySearch - Valid data:", result7.success ? "PASS ✓" : `FAIL`);

const fuzzyTooLongAuthor = {
  title: "A",
  author: "x".repeat(257),
  libraryId: "lib-fz-2",
};
const result8 = FuzzySearchSchema.safeParse(fuzzyTooLongAuthor);
console.log(
  "✓ FuzzySearch - Long author (257 chars):",
  !result8.success ? "PASS ✓ (rejected)" : `FAIL`,
);

// Test error structure returned to client (matches what items.ts returns)
if (!result3.success) {
  const fieldErrors = result3.error.flatten().fieldErrors;
  console.log("\nError response format that would be sent to client:");
  console.log(JSON.stringify({ error: fieldErrors }, null, 2));
}

console.log("\n=== All schema validation tests completed ===\n");
