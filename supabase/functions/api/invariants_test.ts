import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { DurationBearing } from "../_shared/invariants.ts";
import {
  analyzeItemWarnings,
  classifyStowaways,
  parseTrackDuration,
  sanitizeProgressInput,
} from "../_shared/invariants.ts";

Deno.test("invariants: parseTrackDuration reads metadata then top-level, rejects junk", () => {
  assertEquals(parseTrackDuration({ metadata: { duration: 3600 } }), 3600);
  assertEquals(parseTrackDuration({ duration: 125.5 }), 125.5);
  assertEquals(parseTrackDuration({ metadata: { duration: "90" } }), 90);
  assertEquals(parseTrackDuration({ duration: 0 }), null);
  assertEquals(parseTrackDuration({ duration: NaN }), null);
  assertEquals(parseTrackDuration({}), null);
});

Deno.test("invariants: stowaway classification matches the Sapiens incident shape", () => {
  const healthy = Array.from({ length: 26 }, (_, i) => ({
    metadata: { filename: `00${i + 1} chapter.mp3`, duration: 1800 },
  }));
  const stowaways = [
    { metadata: { filename: "Homo Deus (Unabridged).m4b" } }, // no duration
    { metadata: { filename: "full book dup.m4a" } },
  ];
  const analysis = classifyStowaways(
    [...healthy, ...stowaways] as DurationBearing[],
  );
  assertEquals(analysis.applicable, true);
  assertEquals(analysis.stowaways.length, 2);
  assertEquals(analysis.healthy.length, 26);
});

Deno.test("invariants: items whose durations are mostly unknown are NOT applicable", () => {
  // Royal-Irish-Academy shape: nearly all files lack durations — a different
  // metadata-shape problem, not stowaways.
  const mostlyUnknown = Array.from({ length: 22 }, () => ({}));
  mostlyUnknown.push({ duration: 600 }, { duration: 700 });
  assertEquals(classifyStowaways(mostlyUnknown).applicable, false);
});

Deno.test("invariants: progress clamp — position beyond duration is capped", () => {
  const out = sanitizeProgressInput({ currentTime: 60765, duration: 55090 });
  assertEquals(out.currentTime, 55090);
  assertEquals(out.progress, 1);
  assertEquals(out.corrections.length > 0, true);
});

Deno.test("invariants: progress sanitize drops non-finite and negative values", () => {
  const nanOut = sanitizeProgressInput({
    currentTime: NaN,
    duration: Infinity,
  });
  assertEquals(nanOut.currentTime, 0);
  assertEquals(nanOut.duration, 0);
  const negOut = sanitizeProgressInput({ currentTime: -5, duration: 100 });
  assertEquals(negOut.currentTime, 0);
  assertEquals(negOut.progress, 0);
});

Deno.test("invariants: sane input passes through untouched", () => {
  const out = sanitizeProgressInput({ currentTime: 1800, duration: 55090 });
  assertEquals(out.currentTime, 1800);
  assertEquals(out.duration, 55090);
  assertEquals(out.corrections.length, 0);
});

Deno.test("invariants: item warnings fire for giant tracks and totals", () => {
  const giant = { metadata: { duration: 25 * 3600 } };
  const normal = Array.from({ length: 10 }, () => ({
    metadata: { duration: 1800 },
  }));
  const warnings = analyzeItemWarnings([
    giant,
    ...normal,
  ] as DurationBearing[]);
  assertEquals(warnings.some((w) => w.code === "GIANT_TRACK"), true);

  const huge = Array.from({ length: 12 }, () => ({
    metadata: { duration: 20 * 3600 },
  }));
  const warnings2 = analyzeItemWarnings(huge as DurationBearing[]);
  assertEquals(
    warnings2.some((w) => w.code === "TOTAL_DURATION_EXCEEDS_CAP"),
    true,
  );
});
