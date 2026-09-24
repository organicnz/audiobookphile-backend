import type { StorageDeleteResult } from "./storage-router.ts";

export interface DeleteRpcResponse {
  data?: unknown;
  error?: unknown;
}

export interface DeleteStorageBucket {
  remove(paths: string[]): Promise<{ error: unknown }>;
  list(
    path: string,
    options?: { limit?: number },
  ): Promise<{ data: Array<{ name?: string }> | null; error: unknown }>;
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
  ): Promise<boolean | StorageDeleteResult>;
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

interface ParsedDeleteRpcResult {
  found: boolean;
  itemId: string;
  auditId: number | null;
  b2Paths: string[];
  supabaseAudioPaths: string[];
  coverPaths: string[];
  coverPrefixes: string[];
  retainedFileCount: number;
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

function parseDeleteRpcResult(
  value: unknown,
  itemId: string,
): ParsedDeleteRpcResult {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || typeof raw !== "object") {
    throw new Error("Delete RPC returned an invalid response");
  }
  const result = raw as Record<string, unknown>;
  const manifest = result.manifest && typeof result.manifest === "object"
    ? result.manifest as Record<string, unknown>
    : {};
  const auditId = result.audit_id === null || result.audit_id === undefined
    ? null
    : Number(result.audit_id);
  if (auditId !== null && !Number.isSafeInteger(auditId)) {
    throw new Error("Delete RPC returned an invalid audit id");
  }
  return {
    found: result.found === true,
    itemId: String(result.item_id ?? itemId),
    auditId,
    b2Paths: stringArray(manifest.b2Paths),
    supabaseAudioPaths: stringArray(manifest.supabaseAudioPaths),
    coverPaths: stringArray(manifest.coverPaths),
    coverPrefixes: stringArray(manifest.coverPrefixes),
    retainedFileCount: Number.isSafeInteger(Number(manifest.retainedFileCount))
      ? Number(manifest.retainedFileCount)
      : 0,
  };
}

function normalizeStorageResult(value: unknown): StorageDeleteResult {
  if (value === true) return { status: "deleted" };
  if (value === false) return { status: "failed" };
  if (!value || typeof value !== "object") return { status: "failed" };
  const result = value as Record<string, unknown>;
  if (
    result.status === "deleted" || result.status === "absent" ||
    result.status === "failed" || result.status === "unsupported"
  ) {
    return {
      status: result.status,
      error: typeof result.error === "string" ? result.error : undefined,
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

async function removeSupabasePaths(
  db: DeleteItemDb,
  bucket: string,
  paths: string[],
): Promise<
  { removedFiles: number; filesRetained: number; warnings: string[] }
> {
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
  manifest: ParsedDeleteRpcResult,
  storageRouter?: DeleteItemStorageRouter,
): Promise<
  { removedFiles: number; filesRetained: number; warnings: string[] }
> {
  const warnings: string[] = [];
  let removedFiles = 0;
  let filesRetained = 0;

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

  const supabaseAudio = await removeSupabasePaths(
    db,
    "audio-files",
    manifest.supabaseAudioPaths,
  );
  removedFiles += supabaseAudio.removedFiles;
  filesRetained += supabaseAudio.filesRetained;
  warnings.push(...supabaseAudio.warnings);

  const coverKeys = new Set(manifest.coverPaths);
  for (const prefix of manifest.coverPrefixes) {
    try {
      const { data, error } = await db.storage.from("covers").list(prefix, {
        limit: 1000,
      });
      if (error) {
        filesRetained++;
        warnings.push("cover storage cleanup incomplete");
        continue;
      }
      for (const entry of data ?? []) {
        if (entry?.name && /^cover\./i.test(entry.name)) {
          coverKeys.add(`${prefix}/${entry.name}`);
        }
      }
    } catch {
      filesRetained++;
      warnings.push("cover storage cleanup incomplete");
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
    if (response?.error) {
      return fail(
        500,
        `Failed to delete item: ${errorMessage(response.error)}`,
      );
    }
    rpcResult = parseDeleteRpcResult(response?.data, itemId);
  } catch (error) {
    return fail(500, `Failed to delete item: ${errorMessage(error)}`);
  }

  if (!rpcResult.found) return fail(404, "Item not found");

  if (!opts.hardDelete) {
    return {
      deleted: true,
      status: 200,
      deletedId: itemId,
      removedFiles: 0,
      filesRetained: rpcResult.retainedFileCount,
      storageCleanup: "not_requested",
      warnings,
    };
  }

  const cleanup = await cleanupStorage(
    db,
    itemId,
    rpcResult,
    opts.storageRouter,
  );
  warnings.push(...cleanup.warnings);
  let cleanupStatus: "pending" | "complete" = cleanup.warnings.length > 0
    ? "pending"
    : "complete";
  let status: 200 | 202 = cleanup.warnings.length > 0 ? 202 : 200;
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
