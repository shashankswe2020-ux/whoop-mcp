/**
 * File-based OAuth token storage.
 *
 * Stores tokens at ~/.whoop-mcp/tokens.json with secure file permissions.
 * Pure I/O module — no dependencies on API client or OAuth flow.
 */

import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stored OAuth token set with absolute expiry time */
export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  /** Unix epoch milliseconds — computed at save time: Date.now() + expires_in * 1000 */
  expires_at: number;
  /** Typically "Bearer" */
  token_type: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default token storage directory */
const DEFAULT_TOKEN_DIR = join(homedir(), ".whoop-mcp");

/** Token filename */
const TOKEN_FILENAME = "tokens.json";

/** Buffer in milliseconds before actual expiry to consider token expired */
const EXPIRY_BUFFER_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace the home directory prefix with ~ for safe logging (avoids disclosing usernames). */
function redactHomePath(filePath: string): string {
  const home = homedir();
  if (filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Check whether the given tokens are expired (or within the 60s safety buffer).
 *
 * Returns `true` if `expires_at <= Date.now() + EXPIRY_BUFFER_MS`.
 */
export function isTokenExpired(tokens: OAuthTokens): boolean {
  return tokens.expires_at <= Date.now() + EXPIRY_BUFFER_MS;
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/** Resolve the full path to the tokens file */
function tokenFilePath(tokenDir?: string): string {
  return join(tokenDir ?? DEFAULT_TOKEN_DIR, TOKEN_FILENAME);
}

/**
 * Save tokens to disk.
 *
 * Creates the token directory (0700) if it doesn't exist, then writes
 * the token file with 0600 (user-only read/write) permissions.
 */
export async function saveTokens(
  tokens: OAuthTokens,
  tokenDir?: string,
): Promise<void> {
  const dir = tokenDir ?? DEFAULT_TOKEN_DIR;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(tokenFilePath(tokenDir), JSON.stringify(tokens, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Validate that parsed JSON has the required OAuthTokens shape.
 * Prevents confusing runtime errors from corrupted/tampered tokens.json.
 */
function isValidTokenShape(data: unknown): data is OAuthTokens {
  if (typeof data !== "object" || data === null) return false;

  const record = data as Record<string, unknown>;
  return (
    typeof record.access_token === "string" &&
    record.access_token.length > 0 &&
    typeof record.refresh_token === "string" &&
    record.refresh_token.length > 0 &&
    typeof record.expires_at === "number"
  );
}

/**
 * Load tokens from disk.
 *
 * Returns the parsed `OAuthTokens` if the file exists and contains valid JSON
 * with the correct shape. Returns `null` if the file is missing, contains
 * malformed JSON, or has an invalid shape. Logs the reason to stderr for
 * diagnostics.
 */
export async function loadTokens(
  tokenDir?: string,
): Promise<OAuthTokens | null> {
  const filePath = tokenFilePath(tokenDir);
  const safePath = redactHomePath(filePath);
  try {
    const raw = await readFile(filePath, { encoding: "utf-8" });
    const parsed: unknown = JSON.parse(raw);
    if (!isValidTokenShape(parsed)) {
      console.error(
        `Token file ${safePath} exists but has invalid shape — ignoring.`,
      );
      return null;
    }
    return parsed;
  } catch (error: unknown) {
    // Differentiate "file not found" (expected on first run) from real errors
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      console.error(`No token file found at ${safePath}.`);
    } else {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`Failed to read token file at ${safePath}: ${message}`);
    }
    return null;
  }
}

/**
 * Delete the token file from disk.
 *
 * No-op if the file does not exist.
 */
export async function deleteTokens(tokenDir?: string): Promise<void> {
  try {
    await unlink(tokenFilePath(tokenDir));
  } catch (error: unknown) {
    // Ignore "file not found" — it's the expected no-op case
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}
