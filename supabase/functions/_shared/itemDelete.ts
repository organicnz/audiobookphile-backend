import type { StorageDeleteResult } from "./storage-router.ts";

export interface DeleteRpcResponse {
  data?: unknown;
  error?: unknown;
}

export interface DeleteStorageBucket {
  remove(paths: string[]): Promise<{ error: unknown }>;
  list(
    path: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{
    data: Array<{ name?: string; id?: string | null }> | null;
    error: unknown;
  }>;
}

export interface DeleteItemDb {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<DeleteRpcResponse>;
  storage: {
    from(bucket: string): DeleteStorageBucket;
  };
}

export interface DeleteItemStorageRouter {
  deletePathDetailed(
    path: string,
    itemId?: string,
  ): Promise<StorageDeleteResult>;
}

export interface DeleteItemOptions {
  isAdmin: boolean;
  hardDelete: boolean;
  actorId: string;
  storageRouter?: DeleteItemStorageRouter;
}

export interface DeleteItemResult {
  deleted: boolean;
  status: 200 | 202 | 400 | 403 | 404 | 500;
  error?: string;
  deletedId?: string;
  removedFiles: number;
  filesRetained: number;
  storageCleanup: "not_requested" | "pending" | "complete";
  warnings: string[];
}

interface DeleteManifest {
  version: number;
  b2Paths: string[];
  supabaseAudioPaths: string[];
  audioPrefixes: string[];
  coverPaths: string[];
  coverPrefixes: string[];
  unresolvedStorageCount: number;
  retainedFileCount: number;
  complete: boolean;
}

interface ParsedDeleteRpcResult {
  found: boolean;
  retry: boolean;
  itemId: string;
  auditId: number | null;
  manifest: DeleteManifest;
  storageCleanupStatus: "pending" | "complete" | null;
  removedFiles: number;
  filesRetained: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string =>
    typeof entry === "string" && entry.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}

function parseManifest(value: unknown): DeleteManifest {
  const manifest = isRecord(value) ? value : {};
  const version = safeNumber(manifest.manifestVersion) ?? 0;
  const b2Paths = stringArray(manifest.b2Paths);
  const supabaseAudioPaths = stringArray(manifest.supabaseAudioPaths);
  const audioPrefixes = stringArray(manifest.audioPrefixes);
  const coverPaths = stringArray(manifest.coverPaths);
  const coverPrefixes = stringArray(manifest.coverPrefixes);
  const retainedFileCount = safeNumber(manifest.retainedFileCount);
  const declaredUnresolved = safeNumber(manifest.unresolvedStorageCount);
  const knownStorageObjects = new Set([
    ...b2Paths,
    ...supabaseAudioPaths,
    ...coverPaths,
  ]).size;
  const unresolvedStorageCount = declaredUnresolved ??
    (version === 0 && retainedFileCount !== null
      ? Math.max(0, retainedFileCount - knownStorageObjects)
      : null);
  const legacyShape = version === 0 &&
    (manifest.b2Paths === undefined || isStringArray(manifest.b2Paths)) &&
    (manifest.supabaseAudioPaths === undefined ||
      isStringArray(manifest.supabaseAudioPaths)) &&
    (manifest.coverPaths === undefined || isStringArray(manifest.coverPaths)) &&
    (manifest.coverPrefixes === undefined ||
      isStringArray(manifest.coverPrefixes)) &&
    (manifest.audioPrefixes === undefined ||
      isStringArray(manifest.audioPrefixes));
  const currentShape = version === 1 &&
    isStringArray(manifest.b2Paths) &&
    isStringArray(manifest.supabaseAudioPaths) &&
    isStringArray(manifest.audioPrefixes) &&
    isStringArray(manifest.coverPaths) &&
    isStringArray(manifest.coverPrefixes);
  const complete = (legacyShape || currentShape) &&
    retainedFileCount !== null &&
    unresolvedStorageCount !== null;
  return {
    version,
    b2Paths,
    supabaseAudioPaths,
    audioPrefixes,
    coverPaths,
    coverPrefixes,
    unresolvedStorageCount: unresolvedStorageCount ?? 0,
    retainedFileCount: retainedFileCount ?? 0,
    complete,
  };
}

function parseDeleteRpcResult(
  value: unknown,
  itemId: string,
): ParsedDeleteRpcResult {
  const raw = Array.isArray(value) ? value[0] : value;
  if (Array.isArray(value) && value.length !== 1) {
    throw new Error("Delete RPC returned an invalid response array");
  }
  if (!isRecord(raw)) {
    throw new Error("Delete RPC returned an invalid response");
  }
  if (typeof raw.found !== "boolean" || typeof raw.retry !== "boolean") {
    throw new Error("Delete RPC returned invalid state flags");
  }
  if (
    typeof raw.item_id !== "string" ||
    raw.item_id.toLowerCase() !== itemId.toLowerCase()
  ) {
    throw new Error("Delete RPC returned an unexpected item id");
  }
  const auditId = raw.audit_id === null || raw.audit_id === undefined
    ? null
    : safeNumber(raw.audit_id);
  if (raw.found && (auditId === null || auditId <= 0)) {
    throw new Error("Delete RPC returned an invalid audit id");
  }
  if (raw.audit_id !== null && raw.audit_id !== undefined && auditId === null) {
    throw new Error("Delete RPC returned an invalid audit id");
  }
  if (raw.found && !Object.prototype.hasOwnProperty.call(raw, "manifest")) {
    throw new Error("Delete RPC response omitted the storage manifest");
  }
  const statusValue = raw.storage_cleanup_status;
  if (
    statusValue !== undefined && statusValue !== null &&
    statusValue !== "pending" && statusValue !== "complete" &&
    statusValue !== "not_requested"
  ) {
    throw new Error("Delete RPC returned an invalid cleanup status");
  }
  const storageCleanupStatus = statusValue === "pending" || raw.retry
    ? "pending"
    : statusValue === "complete"
    ? "complete"
    : null;
  const removedFiles = raw.storage_removed_files === undefined
    ? 0
    : safeNumber(raw.storage_removed_files);
  const filesRetained = raw.storage_files_retained === undefined
    ? 0
    : safeNumber(raw.storage_files_retained);
  if (removedFiles === null || filesRetained === null) {
    throw new Error("Delete RPC returned invalid cleanup counters");
  }
  return {
    found: raw.found,
    retry: raw.retry,
    itemId,
    auditId,
    manifest: parseManifest(raw.manifest),
    storageCleanupStatus,
    removedFiles,
    filesRetained,
  };
}

function normalizeStorageResult(value: unknown): StorageDeleteResult {
  if (value === true) return { status: "deleted" };
  if (value === false) return { status: "failed" };
  if (!isRecord(value)) return { status: "failed" };
  if (
    value.status === "deleted" || value.status === "absent" ||
    value.status === "failed" || value.status === "unsupported"
  ) {
    return {
      status: value.status,
      error: typeof value.error === "string" ? value.error : undefined,
    };
  }
  return { status: "failed" };
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function storageKey(path: string): string {
  return path
    .replace(/^(?:b2(?:[-_][a-z]+)?|s3):\/\//i, "")
    .replace(/^supabase:\/\//i, "")
    .replace(/^\/+/, "");
}

function isOwnedStoragePath(path: string, itemId: string): boolean {
  const key = storageKey(path);
  return key === itemId ||
    key.startsWith(`${itemId}/`) ||
    key.startsWith(`audiobooks/${itemId}/`);
}

function secureManifest(
  manifest: DeleteManifest,
  itemId: string,
): { manifest: DeleteManifest; rejected: number } {
  const filterPaths = (paths: string[]) =>
    paths.filter((path) => {
      return isOwnedStoragePath(path, itemId) &&
        !storageKey(path).split("/").includes("..");
    });
  const b2Paths = filterPaths(manifest.b2Paths);
  const supabaseAudioPaths = filterPaths(manifest.supabaseAudioPaths);
  const coverPaths = filterPaths(manifest.coverPaths);
  const audioPrefixes = manifest.audioPrefixes.filter((prefix) =>
    prefix === itemId
  );
  const coverPrefixes = manifest.coverPrefixes.filter((prefix) =>
    prefix === itemId
  );
  const rejected = manifest.b2Paths.length - b2Paths.length +
    manifest.supabaseAudioPaths.length - supabaseAudioPaths.length +
    manifest.coverPaths.length - coverPaths.length +
    manifest.audioPrefixes.length - audioPrefixes.length +
    manifest.coverPrefixes.length - coverPrefixes.length;
  return {
    manifest: {
      ...manifest,
      b2Paths,
      supabaseAudioPaths,
      coverPaths,
      audioPrefixes,
      coverPrefixes,
      unresolvedStorageCount: manifest.unresolvedStorageCount + rejected,
      complete: manifest.complete && rejected === 0,
    },
    rejected,
  };
}

async function listPrefixFiles(
  db: DeleteItemDb,
  bucket: string,
  prefix: string,
): Promise<{ files: string[]; failed: boolean }> {
  const files: string[] = [];
  const pending = [prefix];
  const visited = new Set<string>();
  let listCalls = 0;
  while (pending.length > 0 && listCalls < 1000) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      listCalls++;
      try {
        const { data, error } = await db.storage.from(bucket).list(current, {
          limit: 1000,
          offset,
        });
        if (error) return { files, failed: true };
        for (const entry of data ?? []) {
          if (!entry.name) continue;
          const child = `${current}/${entry.name}`;
          if (entry.id === null) pending.push(child);
          else files.push(child);
        }
        if (!data || data.length < 1000) break;
        offset += data.length;
      } catch {
        return { files, failed: true };
      }
    }
    if (listCalls >= 1000 && pending.length > 0) {
      return { files, failed: true };
    }
  }
  return { files, failed: pending.length > 0 };
}

async function removeSupabasePaths(
  db: DeleteItemDb,
  bucket: string,
  paths: string[],
): Promise<{
  removedFiles: number;
  filesRetained: number;
  warnings: string[];
}> {
  const results = await mapConcurrent(paths, 4, async (path) => {
    try {
      const { error } = await db.storage.from(bucket).remove([path]);
      return error ? { ok: false as const } : { ok: true as const };
    } catch {
      return { ok: false as const };
    }
  });
  const failed = results.filter((result) => !result.ok).length;
  return {
    removedFiles: results.length - failed,
    filesRetained: failed,
    warnings: failed > 0 ? [`${bucket} storage cleanup incomplete`] : [],
  };
}

async function cleanupStorage(
  db: DeleteItemDb,
  itemId: string,
  manifest: DeleteManifest,
  storageRouter?: DeleteItemStorageRouter,
): Promise<{
  removedFiles: number;
  filesRetained: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let removedFiles = 0;
  let filesRetained = manifest.unresolvedStorageCount;

  if (manifest.b2Paths.length > 0) {
    if (!storageRouter) {
      filesRetained += manifest.b2Paths.length;
      warnings.push("audio storage cleanup unavailable");
    } else {
      const results = await mapConcurrent(manifest.b2Paths, 4, async (path) => {
        try {
          return normalizeStorageResult(
            await storageRouter.deletePathDetailed(path, itemId),
          );
        } catch {
          return { status: "failed" as const };
        }
      });
      for (const result of results) {
        if (result.status === "deleted") removedFiles++;
        else if (result.status !== "absent") filesRetained++;
      }
      if (filesRetained > 0) warnings.push("audio storage cleanup incomplete");
    }
  }

  const supabaseAudioPaths = new Set(manifest.supabaseAudioPaths);
  for (const prefix of manifest.audioPrefixes) {
    const listed = await listPrefixFiles(db, "audio-files", prefix);
    for (const file of listed.files) supabaseAudioPaths.add(file);
    if (listed.failed) {
      filesRetained++;
      warnings.push("audio storage cleanup incomplete");
    }
  }
  const supabaseAudio = await removeSupabasePaths(
    db,
    "audio-files",
    [...supabaseAudioPaths],
  );
  removedFiles += supabaseAudio.removedFiles;
  filesRetained += supabaseAudio.filesRetained;
  warnings.push(...supabaseAudio.warnings);

  const coverKeys = new Set(manifest.coverPaths);
  for (const prefix of manifest.coverPrefixes) {
    const listed = await listPrefixFiles(db, "covers", prefix);
    if (listed.failed) {
      filesRetained++;
      warnings.push("cover storage cleanup incomplete");
    }
    for (const file of listed.files) {
      if (/\/cover\./i.test(file)) coverKeys.add(file);
    }
  }

  const covers = await removeSupabasePaths(db, "covers", [...coverKeys]);
  removedFiles += covers.removedFiles;
  filesRetained += covers.filesRetained;
  warnings.push(...covers.warnings);

  return { removedFiles, filesRetained, warnings };
}

async function recordCleanupStatus(
  db: DeleteItemDb,
  auditId: number | null,
  status: "pending" | "complete",
  error: string,
  removedFiles: number,
  filesRetained: number,
): Promise<string | null> {
  if (auditId === null) return "deletion audit id unavailable";
  try {
    const { error: rpcError } = await db.rpc(
      "record_library_item_storage_cleanup",
      {
        p_audit_id: auditId,
        p_status: status,
        p_error: error,
        p_removed_files: removedFiles,
        p_files_retained: filesRetained,
      },
    );
    return rpcError ? errorMessage(rpcError) : null;
  } catch (error) {
    return errorMessage(error);
  }
}

async function loadPendingCleanup(
  db: DeleteItemDb,
  itemId: string,
  actorId: string,
): Promise<ParsedDeleteRpcResult | null> {
  try {
    const response = await db.rpc("get_library_item_delete_cleanup", {
      p_item_id: itemId,
      p_actor_id: actorId,
    });
    if (response.error) return null;
    const result = parseDeleteRpcResult(response.data, itemId);
    return result.found ? result : null;
  } catch {
    return null;
  }
}

function pendingResult(
  itemId: string,
  filesRetained: number,
  warnings: string[],
): DeleteItemResult {
  return {
    deleted: true,
    status: 202,
    deletedId: itemId,
    removedFiles: 0,
    filesRetained: Math.max(1, filesRetained),
    storageCleanup: "pending",
    warnings,
  };
}

export async function deleteLibraryItem(
  db: DeleteItemDb,
  itemId: string,
  opts: DeleteItemOptions,
): Promise<DeleteItemResult> {
  const warnings: string[] = [];
  const fail = (
    status: 400 | 403 | 404 | 500,
    error: string,
  ): DeleteItemResult => ({
    deleted: false,
    status,
    error,
    removedFiles: 0,
    filesRetained: 0,
    storageCleanup: "not_requested",
    warnings,
  });

  if (!opts.isAdmin || !String(opts.actorId ?? "").trim()) {
    return fail(403, "Forbidden: Admin access required");
  }
  if (!UUID_RE.test(String(itemId ?? ""))) {
    return fail(400, "Invalid item id");
  }

  let rpcResult: ParsedDeleteRpcResult;
  try {
    const response = await db.rpc("delete_library_item_atomic", {
      p_item_id: itemId,
      p_hard_delete: opts.hardDelete,
      p_actor_id: opts.actorId,
    });
    if (response.error) {
      const pending = opts.hardDelete
        ? await loadPendingCleanup(db, itemId, opts.actorId)
        : null;
      if (!pending) {
        console.error("Delete RPC failed", response.error);
        return fail(500, "Delete failed");
      }
      rpcResult = pending;
    } else {
      try {
        rpcResult = parseDeleteRpcResult(response.data, itemId);
      } catch (error) {
        console.error("Delete RPC response was invalid", error);
        const recovered = opts.hardDelete
          ? await loadPendingCleanup(db, itemId, opts.actorId)
          : null;
        if (!recovered) throw error;
        rpcResult = recovered;
      }
    }
  } catch (error) {
    console.error("Delete RPC failed", error);
    const pending = opts.hardDelete
      ? await loadPendingCleanup(db, itemId, opts.actorId)
      : null;
    if (!pending) return fail(500, "Delete failed");
    rpcResult = pending;
  }

  if (!rpcResult.found) return fail(404, "Item not found");

  const secured = secureManifest(rpcResult.manifest, itemId);
  const manifest = secured.manifest;
  if (secured.rejected > 0) {
    warnings.push("storage manifest contains paths outside the item prefix");
  }

  if (!opts.hardDelete) {
    return {
      deleted: true,
      status: 200,
      deletedId: itemId,
      removedFiles: 0,
      filesRetained: manifest.retainedFileCount,
      storageCleanup: "not_requested",
      warnings,
    };
  }

  if (rpcResult.storageCleanupStatus === "complete") {
    return {
      deleted: true,
      status: 200,
      deletedId: itemId,
      removedFiles: rpcResult.removedFiles,
      filesRetained: rpcResult.filesRetained,
      storageCleanup: "complete",
      warnings,
    };
  }

  if (!manifest.complete) {
    warnings.push("storage cleanup manifest is incomplete");
    const statusError = await recordCleanupStatus(
      db,
      rpcResult.auditId,
      "pending",
      warnings.join("; "),
      0,
      Math.max(1, manifest.unresolvedStorageCount),
    );
    if (statusError) {
      warnings.push("storage cleanup status could not be recorded");
    }
    return pendingResult(
      itemId,
      manifest.unresolvedStorageCount,
      warnings,
    );
  }

  let cleanup: {
    removedFiles: number;
    filesRetained: number;
    warnings: string[];
  };
  try {
    cleanup = await cleanupStorage(
      db,
      itemId,
      manifest,
      opts.storageRouter,
    );
  } catch (error) {
    console.error("Storage cleanup failed after database commit", error);
    cleanup = {
      removedFiles: 0,
      filesRetained: Math.max(1, manifest.unresolvedStorageCount),
      warnings: ["storage cleanup incomplete"],
    };
  }
  warnings.push(...cleanup.warnings);
  let cleanupStatus: "pending" | "complete" = cleanup.filesRetained === 0 &&
      cleanup.warnings.length === 0
    ? "complete"
    : "pending";
  let status: 200 | 202 = cleanupStatus === "complete" ? 200 : 202;
  const statusError = await recordCleanupStatus(
    db,
    rpcResult.auditId,
    cleanupStatus,
    warnings.join("; "),
    cleanup.removedFiles,
    cleanup.filesRetained,
  );
  if (statusError) {
    warnings.push("storage cleanup status could not be recorded");
    cleanupStatus = "pending";
    status = 202;
  }

  return {
    deleted: true,
    status,
    deletedId: itemId,
    removedFiles: cleanup.removedFiles,
    filesRetained: cleanup.filesRetained,
    storageCleanup: cleanupStatus,
    warnings,
  };
}
