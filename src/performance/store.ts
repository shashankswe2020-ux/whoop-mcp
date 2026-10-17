import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveTokenDirectory } from "../auth/token-store.js";
import { emptyPerformanceState, performanceStateSchema, type PerformanceState } from "./schemas.js";

export const PERFORMANCE_FILENAME = "performance.json";
export const LOCK_FILENAME = "performance.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** Writes finish in milliseconds; a lock this old was left by a crashed process. */
const STALE_LOCK_MS = 30_000;

export class PerformanceStoreError extends Error {
  constructor(
    readonly code: "corrupt" | "invalid_schema" | "io" | "busy" | "partial_write",
    message: string
  ) {
    super(message);
    this.name = "PerformanceStoreError";
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

const PRIVATE_BITS = 0o077;

/** Undefined on Windows, where POSIX ownership and modes do not apply. */
function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Creates the data directory (0700) or validates an existing one: it must be a directory owned
 * by the current user, and group/other permission bits are removed.
 */
export async function ensurePerformanceDirectory(directory?: string): Promise<string> {
  const resolved = resolveTokenDirectory(directory);
  try {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const info = await stat(resolved);
    if (!info.isDirectory())
      throw new PerformanceStoreError("io", "The whoop-mcp data path is not a directory.");
    const uid = currentUid();
    if (uid === undefined) return resolved;
    if (info.uid !== uid)
      throw new PerformanceStoreError(
        "io",
        "The whoop-mcp data directory is owned by another user; refusing to use it."
      );
    if ((info.mode & PRIVATE_BITS) !== 0) await chmod(resolved, 0o700);
  } catch (error: unknown) {
    if (error instanceof PerformanceStoreError) throw error;
    throw new PerformanceStoreError("io", "Could not prepare the whoop-mcp data directory.");
  }
  return resolved;
}

/**
 * Opens a store file without following symlinks, then checks the handle: it must be a regular
 * file owned by the current user, and group/other permission bits are removed. Open errors other
 * than a symlink (e.g. ENOENT) are rethrown unchanged for the caller to classify.
 */
export async function openPrivateFile(
  path: string,
  mode: "append" | "read",
  name: string
): Promise<FileHandle> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const symlinkError = new PerformanceStoreError(
    "io",
    `${name} is a symbolic link; refusing to follow it.`
  );
  if (noFollow === 0) {
    const existing = await lstat(path).catch(() => null);
    if (existing?.isSymbolicLink()) throw symlinkError;
  }
  const flags =
    mode === "append"
      ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow
      : constants.O_RDONLY | noFollow;
  let handle: FileHandle;
  try {
    handle = await open(path, flags, 0o600);
  } catch (error: unknown) {
    if (errorCode(error) === "ELOOP") throw symlinkError;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new PerformanceStoreError("io", `${name} is not a regular file; refusing to use it.`);
    const uid = currentUid();
    if (uid !== undefined) {
      if (info.uid !== uid)
        throw new PerformanceStoreError(
          "io",
          `${name} is owned by another user; refusing to use it.`
        );
      if ((info.mode & PRIVATE_BITS) !== 0) await handle.chmod(0o600);
    }
    return handle;
  } catch (error: unknown) {
    await handle.close();
    if (error instanceof PerformanceStoreError) throw error;
    throw new PerformanceStoreError("io", `Could not open ${name}.`);
  }
}

export async function loadPerformanceState(directory?: string): Promise<PerformanceState> {
  let raw: string;
  try {
    raw = await readFile(join(resolveTokenDirectory(directory), PERFORMANCE_FILENAME), "utf-8");
  } catch (error: unknown) {
    if (isMissing(error)) return emptyPerformanceState();
    throw new PerformanceStoreError("io", `Could not read ${PERFORMANCE_FILENAME}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PerformanceStoreError(
      "corrupt",
      `${PERFORMANCE_FILENAME} is not valid JSON. It was left untouched; fix or move it to continue.`
    );
  }
  const result = performanceStateSchema.safeParse(parsed);
  if (!result.success)
    throw new PerformanceStoreError(
      "invalid_schema",
      `${PERFORMANCE_FILENAME} does not match schema version 1. It was left untouched.`
    );
  return result.data;
}

/** Validates, then writes atomically (temp file + rename) with 0600 permissions. */
export async function savePerformanceState(
  state: PerformanceState,
  directory?: string
): Promise<void> {
  const result = performanceStateSchema.safeParse(state);
  if (!result.success)
    throw new PerformanceStoreError(
      "invalid_schema",
      "Refusing to save an invalid performance state."
    );
  await writeStateFile(
    await ensurePerformanceDirectory(directory),
    JSON.stringify(result.data, null, 2)
  );
}

async function writeStateFile(resolved: string, content: string): Promise<void> {
  const target = join(resolved, PERFORMANCE_FILENAME);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf-8", mode: 0o600 });
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new PerformanceStoreError("io", `Could not write ${PERFORMANCE_FILENAME}.`);
  }
}

async function readStateBytes(resolved: string): Promise<string | null> {
  try {
    return await readFile(join(resolved, PERFORMANCE_FILENAME), "utf-8");
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw new PerformanceStoreError("io", `Could not read ${PERFORMANCE_FILENAME}.`);
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Interprocess lock: an O_EXCL lockfile holding a random owner token. */
async function acquireLock(resolved: string, timeoutMs: number): Promise<() => Promise<void>> {
  const path = join(resolved, LOCK_FILENAME);
  const owner = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const deadline = performance.now() + timeoutMs;
  let delay = 5;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(owner, "utf-8");
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readFile(path, "utf-8").catch(() => null);
        if (current === owner) await rm(path, { force: true }).catch(() => undefined);
      };
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST")
        throw new PerformanceStoreError("io", `Could not create ${LOCK_FILENAME}.`);
    }
    const age = await stat(path).then(
      (info) => Date.now() - info.mtimeMs,
      () => null
    );
    if (age === null) continue;
    if (age > STALE_LOCK_MS) {
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    if (performance.now() >= deadline)
      throw new PerformanceStoreError(
        "busy",
        "Another whoop-mcp process is updating local performance data. Try again shortly."
      );
    await sleep(delay);
    delay = Math.min(delay * 2, 100);
  }
}

const queues = new Map<string, Promise<unknown>>();

export interface PerformanceUpdateOptions {
  lockTimeoutMs?: number;
}

type Mutator<Result> = (
  state: PerformanceState
) =>
  | { state: PerformanceState; result: Result }
  | Promise<{ state: PerformanceState; result: Result }>;

/**
 * Runs load → mutate → save → commit as one transaction. Writers are serialised in-process by a
 * queue and across processes by a lockfile. If `commit` (e.g. the audit append) fails, the
 * previous file contents are restored so callers can truthfully say nothing changed; if the
 * restore also fails, a `partial_write` error says so.
 */
export async function commitPerformanceChange<Result, Committed>(
  mutate: Mutator<Result>,
  commit: (result: Result, state: PerformanceState) => Promise<Committed>,
  directory?: string,
  options: PerformanceUpdateOptions = {}
): Promise<Committed> {
  const key = resolveTokenDirectory(directory);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const resolved = await ensurePerformanceDirectory(directory);
      const release = await acquireLock(resolved, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
      try {
        const original = await readStateBytes(resolved);
        const { state, result } = await mutate(await loadPerformanceState(directory));
        await savePerformanceState(state, directory);
        try {
          return await commit(result, state);
        } catch (error: unknown) {
          try {
            if (original === null) await rm(join(resolved, PERFORMANCE_FILENAME));
            else await writeStateFile(resolved, original);
          } catch {
            throw new PerformanceStoreError(
              "partial_write",
              `The change was saved to ${PERFORMANCE_FILENAME} but its audit entry could not be written, and the change could not be rolled back. Review ${PERFORMANCE_FILENAME} before retrying.`
            );
          }
          throw error;
        }
      } finally {
        await release();
      }
    });
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}

export async function updatePerformanceState<Result>(
  mutate: Mutator<Result>,
  directory?: string,
  options: PerformanceUpdateOptions = {}
): Promise<Result> {
  return commitPerformanceChange(mutate, async (result) => result, directory, options);
}
