/**
 * Data-integrity invariants for audiobook items and playback progress.
 *
 * Born from the Sapiens/Homo Deus incident: a foreign .m4b with unreadable
 * metadata was uploaded inside a book's batch, later played (syncing a bogus
 * 19.8h "duration" over the real 15.3h book), pushing saved positions past
 * the end of the real content. These helpers give every write path a shared,
 * testable definition of sane data.
 */

/** Hard cap for a single audio track — audiobooks never exceed this. */
export const MAX_SINGLE_TRACK_DURATION_S = 24 * 3600;
/** Hard cap for one item's total duration across all tracks. */
export const MAX_ITEM_DURATION_S = 40 * 3600;

export interface DurationBearing {
  duration?: unknown;
  metadata?: { duration?: unknown } | null;
}

/** First positive, finite duration found on a file entry (metadata wins). */
export function parseTrackDuration(file: DurationBearing): number | null {
  const candidates = [
    file.metadata?.duration,
    file.duration,
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : c;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export interface StowawayAnalysis {
  healthy: DurationBearing[];
  stowaways: DurationBearing[];
  /** True when the item is worth guarding (enough healthy siblings). */
  applicable: boolean;
}

/**
 * Classifies zero/unparsable-duration entries among >=5 healthy siblings —
 * the signature of whole-other-books uploaded inside a batch.
 */
export function classifyStowaways(files: DurationBearing[]): StowawayAnalysis {
  const healthy = files.filter((f) => parseTrackDuration(f) !== null);
  const stowaways = files.filter((f) => parseTrackDuration(f) === null);
  const applicable = healthy.length >= 5 &&
    stowaways.length > 0 &&
    stowaways.length <= Math.ceil(files.length * 0.2);
  return { healthy, stowaways, applicable };
}

export interface ProgressInput {
  currentTime?: number;
  duration?: number;
  progress?: number;
}

export interface SanitizedProgress {
  currentTime: number;
  duration: number;
  progress: number;
  /** Adjustments applied while sanitizing — log/report these. */
  corrections: string[];
}

/**
 * Clamps client-supplied progress into physically-possible ranges before it
 * touches media_progress. A hostile/broken client must not be able to poison
 * cross-device resume state.
 */
export function sanitizeProgressInput(
  input: ProgressInput,
): SanitizedProgress {
  const corrections: string[] = [];
  const finite = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);

  let duration = finite(input.duration) && input.duration > 0
    ? input.duration
    : 0;
  let currentTime = finite(input.currentTime) && input.currentTime > 0
    ? input.currentTime
    : 0;

  if (input.duration !== undefined && !finite(input.duration)) {
    corrections.push("duration non-finite -> 0");
  }
  if (input.currentTime !== undefined && !finite(input.currentTime)) {
    corrections.push("currentTime non-finite -> 0");
  }
  if (duration > MAX_ITEM_DURATION_S) {
    corrections.push(
      `duration ${duration}s exceeds cap -> ${MAX_ITEM_DURATION_S}s`,
    );
    duration = MAX_ITEM_DURATION_S;
  }
  if (duration > 0 && currentTime > duration) {
    corrections.push(
      `currentTime ${currentTime}s clamped to duration ${duration}s`,
    );
    currentTime = duration;
  }

  let finalProgress = finite(input.progress) ? input.progress : -1;
  if (finalProgress < 0 || finalProgress > 1) {
    finalProgress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    if (finite(input.progress)) {
      corrections.push("progress out of range -> recomputed");
    }
  }

  return {
    currentTime,
    duration,
    progress: Math.min(1, Math.max(0, finalProgress)),
    corrections,
  };
}

export interface ItemWarning {
  code: string;
  detail: string;
}

/** Post-sync warnings for an item's audio_files (telemetry + API surface). */
export function analyzeItemWarnings(
  files: DurationBearing[],
): ItemWarning[] {
  const warnings: ItemWarning[] = [];

  // Stowaways are one signal; duration caps are checked independently —
  // an item with zero stowaways can still hold a single 25h "track".
  const analysis = classifyStowaways(files);
  if (analysis.applicable) {
    warnings.push({
      code: "STOWAWAY_FILES",
      detail:
        `${analysis.stowaways.length} file(s) lack parsable durations among ${files.length}`,
    });
  }

  const total = files.reduce((sum, f) => sum + (parseTrackDuration(f) ?? 0), 0);
  if (total > MAX_ITEM_DURATION_S) {
    warnings.push({
      code: "TOTAL_DURATION_EXCEEDS_CAP",
      detail: `total ${(total / 3600).toFixed(2)}h exceeds ${
        MAX_ITEM_DURATION_S / 3600
      }h`,
    });
  }

  const giant = files.filter((f) =>
    (parseTrackDuration(f) ?? 0) > MAX_SINGLE_TRACK_DURATION_S
  );
  if (giant.length > 0) {
    warnings.push({
      code: "GIANT_TRACK",
      detail: `${giant.length} track(s) exceed ${
        MAX_SINGLE_TRACK_DURATION_S / 3600
      }h`,
    });
  }

  return warnings;
}
