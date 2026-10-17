import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveTokenDirectory } from "../auth/token-store.js";
import { auditEntrySchema, type AuditEntry } from "./schemas.js";
import { ensurePerformanceDirectory, openPrivateFile, PerformanceStoreError } from "./store.js";

export const AUDIT_FILENAME = "performance-audit.jsonl";
export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LINE_BYTES = 256 * 1024;
export const MAX_AUDIT_SCAN_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIT_SCAN_LINES = 10_000;
const READ_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/** Appends one entry. Existing lines are never rewritten. */
export async function appendAuditEntry(
  entry: Omit<AuditEntry, "id" | "at">,
  directory?: string,
  now: Date = new Date()
): Promise<AuditEntry> {
  const complete = auditEntrySchema.parse({ ...entry, id: randomUUID(), at: now.toISOString() });
  const line = `${JSON.stringify(complete)}\n`;
  if (Buffer.byteLength(line) > MAX_AUDIT_LINE_BYTES)
    throw new PerformanceStoreError("io", `Audit entry is too large for ${AUDIT_FILENAME}.`);
  const resolved = await ensurePerformanceDirectory(directory);
  try {
    const handle = await openPrivateFile(join(resolved, AUDIT_FILENAME), "append", AUDIT_FILENAME);
    try {
      await handle.appendFile(line, "utf-8");
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (error instanceof PerformanceStoreError) throw error;
    throw new PerformanceStoreError("io", `Could not append to ${AUDIT_FILENAME}.`);
  }
  return complete;
}

export interface AuditLogPage {
  entries: AuditEntry[];
  /** Unreadable lines met while collecting the newest entries (older lines are not scanned). */
  invalid_lines: number;
  truncated: boolean;
}

function parseLine(line: Buffer): AuditEntry | null {
  const text = line.toString("utf-8").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    const parsed = auditEntrySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const isBlank = (line: Buffer): boolean =>
  line.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d);

/**
 * Returns the newest `limit` entries, newest first. The file is read backwards in chunks and
 * scanning stops once one entry beyond the limit is found or the byte/line budget is spent, so a
 * large or hostile log cannot make reads unbounded. Lines over MAX_AUDIT_LINE_BYTES count as
 * invalid without being buffered.
 */
export async function readAuditLog(
  directory?: string,
  options: { limit?: number } = {}
): Promise<AuditLogPage> {
  const limit = options.limit ?? DEFAULT_AUDIT_LIMIT;
  let handle;
  try {
    handle = await openPrivateFile(
      join(resolveTokenDirectory(directory), AUDIT_FILENAME),
      "read",
      AUDIT_FILENAME
    );
  } catch (error: unknown) {
    if (error instanceof PerformanceStoreError) throw error;
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")
      return { entries: [], invalid_lines: 0, truncated: false };
    throw new PerformanceStoreError("io", `Could not read ${AUDIT_FILENAME}.`);
  }
  const entries: AuditEntry[] = [];
  let invalid = 0;
  let lines = 0;
  let oversized = false;
  const done = (): boolean => entries.length > limit || lines >= MAX_AUDIT_SCAN_LINES;
  const take = (line: Buffer): void => {
    if (oversized) {
      oversized = false;
      lines += 1;
      invalid += 1;
      return;
    }
    if (isBlank(line)) return;
    lines += 1;
    const parsed = parseLine(line);
    if (parsed) entries.push(parsed);
    else invalid += 1;
  };
  let position = 0;
  let carry = Buffer.alloc(0);
  try {
    position = (await handle.stat()).size;
    let scanned = 0;
    while (position > 0 && !done() && scanned < MAX_AUDIT_SCAN_BYTES) {
      const size = Math.min(READ_CHUNK_BYTES, position, MAX_AUDIT_SCAN_BYTES - scanned);
      position -= size;
      scanned += size;
      const chunk = Buffer.alloc(size);
      await handle.read(chunk, 0, size, position);
      const buffer = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let end = buffer.length;
      let index = buffer.lastIndexOf(NEWLINE, end - 1);
      while (index !== -1 && !done()) {
        take(buffer.subarray(index + 1, end));
        end = index;
        index = end > 0 ? buffer.lastIndexOf(NEWLINE, end - 1) : -1;
      }
      // Bytes before the first newline belong to a line that continues in earlier chunks.
      carry = Buffer.from(buffer.subarray(0, end));
      if (carry.length > MAX_AUDIT_LINE_BYTES) {
        oversized = true;
        carry = Buffer.alloc(0);
      } else if (oversized) carry = Buffer.alloc(0);
    }
    if (position === 0 && !done() && (carry.length > 0 || oversized)) {
      take(carry);
      carry = Buffer.alloc(0);
    }
  } catch {
    throw new PerformanceStoreError("io", `Could not read ${AUDIT_FILENAME}.`);
  } finally {
    await handle.close();
  }
  const unread = position > 0 || carry.length > 0 || oversized;
  return {
    entries: entries.slice(0, limit),
    invalid_lines: invalid,
    truncated: entries.length > limit || unread,
  };
}
