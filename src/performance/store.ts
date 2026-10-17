import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveTokenDirectory } from "../auth/token-store.js";
import { emptyPerformanceState, performanceStateSchema, type PerformanceState } from "./schemas.js";

export const PERFORMANCE_FILENAME = "performance.json";

export class PerformanceStoreError extends Error {
  constructor(
    readonly code: "corrupt" | "invalid_schema" | "io",
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

export async function ensurePerformanceDirectory(directory?: string): Promise<string> {
  const resolved = resolveTokenDirectory(directory);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  return resolved;
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
  const resolved = await ensurePerformanceDirectory(directory);
  const target = join(resolved, PERFORMANCE_FILENAME);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(result.data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true });
    throw new PerformanceStoreError("io", `Could not write ${PERFORMANCE_FILENAME}.`);
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Serialises read-modify-write cycles per directory so concurrent writers never lose updates. */
export async function updatePerformanceState<Result>(
  mutate: (state: PerformanceState) => { state: PerformanceState; result: Result },
  directory?: string
): Promise<Result> {
  const key = resolveTokenDirectory(directory);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const { state, result } = mutate(await loadPerformanceState(directory));
      await savePerformanceState(state, directory);
      return result;
    });
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
