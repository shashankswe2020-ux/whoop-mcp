import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveTokenDirectory } from "../auth/token-store.js";
import { auditEntrySchema, type AuditEntry } from "./schemas.js";
import { ensurePerformanceDirectory, PerformanceStoreError } from "./store.js";

export const AUDIT_FILENAME = "performance-audit.jsonl";
export const DEFAULT_AUDIT_LIMIT = 50;

/** Appends one entry. Existing lines are never rewritten. */
export async function appendAuditEntry(
  entry: Omit<AuditEntry, "id" | "at">,
  directory?: string,
  now: Date = new Date()
): Promise<AuditEntry> {
  const complete = auditEntrySchema.parse({ ...entry, id: randomUUID(), at: now.toISOString() });
  const resolved = await ensurePerformanceDirectory(directory);
  try {
    await appendFile(join(resolved, AUDIT_FILENAME), `${JSON.stringify(complete)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    throw new PerformanceStoreError("io", `Could not append to ${AUDIT_FILENAME}.`);
  }
  return complete;
}

export async function readAuditLog(
  directory?: string,
  options: { limit?: number } = {}
): Promise<{ entries: AuditEntry[]; invalid_lines: number; truncated: boolean }> {
  let raw: string;
  try {
    raw = await readFile(join(resolveTokenDirectory(directory), AUDIT_FILENAME), "utf-8");
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")
      return { entries: [], invalid_lines: 0, truncated: false };
    throw new PerformanceStoreError("io", `Could not read ${AUDIT_FILENAME}.`);
  }
  const entries: AuditEntry[] = [];
  let invalid = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = auditEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  entries.reverse();
  const limit = options.limit ?? DEFAULT_AUDIT_LIMIT;
  return {
    entries: entries.slice(0, limit),
    invalid_lines: invalid,
    truncated: entries.length > limit,
  };
}
