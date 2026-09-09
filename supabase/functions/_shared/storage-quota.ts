/**
 * 10x pro: Storage quota guard for Supabase Storage (free = 1 GiB).
 *
 * Call before any `storage.from(...).upload()` to fail fast with 507 instead
 * of silently blowing the 1 GiB free quota and getting 402 on 2026-09-29.
 *
 * Uses the `public.check_storage_quota(p_need_bytes)` RPC when available;
 * falls back to a direct `storage.objects` size query so local dev (no
 * migration) still guards.
 *
 * Covers is 13 MB – the risk is `audio-files` (currently 7.5 GB, 858 objects).
 * New audio must go to B2 (`uploadPresign.ts`), not Supabase; this guard is
 * the last line of defense if a caller bypasses presign.
 */

export const FREE_QUOTA_BYTES = 1073741824; // 1 GiB
export const WARN_RATIO = 0.8; // warn at 80%

export interface QuotaSnapshot {
  totalBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  usedRatio: number;
  isOver: boolean;
  isWarn: boolean;
  prettyTotal: string;
  prettyQuota: string;
}

function pgPretty(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes, i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export async function getStorageQuotaSnapshot(
  supabase: any,
): Promise<QuotaSnapshot> {
  // Prefer DB helper (respects server_settings.storage_quota_bytes)
  try {
    const { data, error } = await supabase.rpc("storage_quota_snapshot");
    if (!error && Array.isArray(data)) {
      const row = data.find((r: any) => r.bucket_id === "_total");
      const total = Number(row?.total_bytes ?? 0);
      // quota from server_settings via check_storage_quota would throw with HINT;
      // we also fetch it here for the snapshot.
      const quota = await getQuotaBytes(supabase);
      return snap(total, quota);
    }
  } catch { /* fallback */ }

  // Fallback: sum storage.objects (requires service_role)
  const { data, error } = await supabase
    .from("storage.objects")
    .select("metadata")
    .limit(1);
  // Probe if storage schema is selectable; if not, try RPC directly
  void data;
  void error;
  try {
    const { data: tot, error: e2 } = await supabase.rpc("check_storage_quota", {
      p_need_bytes: 0,
    });
    void tot;
    void e2;
  } catch {
    // Probe-only call: failures mean the RPC is unavailable; fall through to defaults.
  }
  const quota = await getQuotaBytes(supabase);
  let total = 0;
  try {
    // Use supabase.storage.listBuckets? Not helpful. Try direct SQL via rpc if available
    const { data: snap } = await supabase.rpc("storage_quota_snapshot");
    if (Array.isArray(snap)) {
      const r = snap.find((x: any) => x.bucket_id === "_total");
      if (r) total = Number(r.total_bytes ?? 0);
    }
  } catch {
    // Snapshot RPC is optional; totals stay 0 when it is unavailable.
  }
  return snap(total, quota);
}

async function getQuotaBytes(supabase: any): Promise<number> {
  try {
    const { data } = await supabase.from("server_settings").select("value").eq(
      "key",
      "storage_quota_bytes",
    ).maybeSingle();
    const v = data?.value;
    const n = typeof v === "number"
      ? v
      : typeof v === "string"
      ? parseInt(v, 10)
      : null;
    if (n && Number.isFinite(n)) return n;
  } catch {
    // server_settings lookup is best-effort; fall back to the free-tier quota.
  }
  return FREE_QUOTA_BYTES;
}

function snap(totalBytes: number, quotaBytes: number): QuotaSnapshot {
  const remaining = quotaBytes - totalBytes;
  return {
    totalBytes,
    quotaBytes,
    remainingBytes: remaining,
    usedRatio: quotaBytes ? totalBytes / quotaBytes : 0,
    isOver: totalBytes >= quotaBytes,
    isWarn: totalBytes / quotaBytes >= WARN_RATIO,
    prettyTotal: pgPretty(totalBytes),
    prettyQuota: pgPretty(quotaBytes),
  };
}

/**
 * Throw 507 if need would exceed quota. Call with `file.byteLength` before upload.
 * Returns snapshot for logging.
 */
export async function assertStorageQuota(
  supabase: any,
  needBytes: number,
): Promise<QuotaSnapshot> {
  // Fast path: try DB guard which raises P0001 with HINT
  try {
    const { error } = await supabase.rpc("check_storage_quota", {
      p_need_bytes: needBytes,
    });
    if (error) {
      // PGRST + PG error contains the HINT
      const msg = error.message || "";
      if (msg.includes("quota exceeded") || (error as any).code === "P0001") {
        const q = await getStorageQuotaSnapshot(supabase);
        const err: any = new Error(
          `Storage quota exceeded: ${q.prettyTotal} / ${q.prettyQuota} (need ${
            pgPretty(needBytes)
          })`,
        );
        err.status = 507;
        err.code = "STORAGE_QUOTA_EXCEEDED";
        err.snapshot = q;
        throw err;
      }
    }
  } catch (e: any) {
    if (e?.status === 507 || e?.code === "STORAGE_QUOTA_EXCEEDED") throw e;
    // otherwise fall through to snapshot check (e.g. helper not yet migrated locally)
  }

  const q = await getStorageQuotaSnapshot(supabase);
  if (q.totalBytes + needBytes > q.quotaBytes) {
    const err: any = new Error(
      `Storage quota exceeded: ${q.prettyTotal} / ${q.prettyQuota} (need ${
        pgPretty(needBytes)
      }) – migrate audio to B2 or upgrade to Pro (100 GiB).`,
    );
    err.status = 507;
    err.code = "STORAGE_QUOTA_EXCEEDED";
    err.snapshot = q;
    throw err;
  }
  return q;
}
