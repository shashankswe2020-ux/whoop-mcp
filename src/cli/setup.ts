/**
 * Interactive `whoop-ai-mcp setup` wizard.
 *
 * Walks a user through:
 *   1. WHOOP OAuth credential entry (prompted, secrets masked)
 *   2. (optional) `--verify` runs the full OAuth flow + a profile fetch
 *      to prove credentials and refresh tokens both work
 *   3. Generates client configuration:
 *        - claude-desktop: merges a `whoop` entry into the existing config
 *          file (creates `.bak` first; restores on failure)
 *        - claude-code:    prints the `claude mcp add ...` command to run
 *
 * No new runtime dependencies — uses only Node's built-in modules.
 * All output goes to stdout; errors throw and surface via the dispatcher.
 */

import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface, type Interface } from "node:readline";

import { authenticate } from "../auth/oauth.js";
import type { OAuthConfig } from "../auth/oauth.js";
import { loadTokens, saveTokens } from "../auth/token-store.js";
import { refreshAccessToken, toOAuthTokens } from "../auth/oauth.js";
import { createWhoopClient } from "../api/client.js";
import { getProfile } from "../tools/get-profile.js";

import {
  claudeDesktopConfigPath,
  generateClaudeCodeCommand,
  generateClaudeDesktopEntry,
  mergeClaudeDesktopConfig,
  type ClaudeDesktopConfig,
  type ClientTarget,
} from "./config-generators.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly client?: ClientTarget;
  readonly verify?: boolean;
  /** Optional override for the Claude Desktop config path (used by tests). */
  readonly configPath?: string;
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

/**
 * Parse `setup`-subcommand arguments.
 *
 * Supported flags:
 *   --client-id=<value> | --client-id <value>
 *   --client-secret=<value> | --client-secret <value>
 *   --client=<claude-desktop|claude-code>
 *   --verify
 *   --config-path=<value>   (test hook)
 */
export function parseSetupArgs(argv: readonly string[]): SetupOptions {
  const out: {
    clientId?: string;
    clientSecret?: string;
    client?: ClientTarget;
    verify?: boolean;
    configPath?: string;
  } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const [key, inlineValue] = arg.startsWith("--") ? splitFlag(arg) : ["", undefined];

    const valueAt = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for flag ${key}`);
      }
      i++;
      return next;
    };

    switch (key) {
      case "--client-id":
        out.clientId = valueAt();
        break;
      case "--client-secret":
        out.clientSecret = valueAt();
        break;
      case "--client": {
        const v = valueAt();
        if (v !== "claude-desktop" && v !== "claude-code") {
          throw new Error(
            `Invalid --client value: "${v}". Must be "claude-desktop" or "claude-code".`
          );
        }
        out.client = v;
        break;
      }
      case "--verify":
        out.verify = true;
        break;
      case "--config-path":
        out.configPath = valueAt();
        break;
      case "":
        // Ignore positional args (none expected after `setup`)
        break;
      default:
        throw new Error(`Unknown flag: ${key}`);
    }
  }

  return out;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq === -1) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

interface PromptIO {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

async function promptText(io: PromptIO, question: string): Promise<string> {
  const rl: Interface = createInterface({ input: io.input, output: io.output });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a secret with no echo. Reads characters from stdin in raw mode
 * and writes asterisks to the output. Falls back to plain readline (with a
 * warning) if raw mode is unavailable (e.g. piped stdin in CI).
 */
async function promptSecret(io: PromptIO, question: string): Promise<string> {
  const stdin = io.input as NodeJS.ReadStream;
  const stdout = io.output;

  if (typeof stdin.setRawMode !== "function" || !stdin.isTTY) {
    stdout.write(`${question}(input will be visible) `);
    const value = await promptText({ input: io.input, output: io.output }, "");
    return value;
  }

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (code === 3) {
          // Ctrl-C
          cleanup();
          stdout.write("\n");
          reject(new Error("Interrupted"));
          return;
        }
        if (code === 127 || code === 8) {
          // Backspace / DEL
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (code < 32) continue; // ignore other control chars
        buffer += ch;
        stdout.write("*");
      }
    };
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface RunSetupDeps {
  readonly io?: PromptIO;
  readonly authenticate?: (config: OAuthConfig) => Promise<string>;
  /** Fetch the profile after authenticate() to prove the access token works. */
  readonly fetchProfile?: (accessToken: string) => Promise<unknown>;
  readonly fs?: {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
    writeFile: (path: string, data: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    mkdir: (path: string, opts: { recursive: true }) => Promise<void>;
  };
}

const DEFAULT_DEPS: Required<Omit<RunSetupDeps, "io">> & { io: PromptIO } = {
  io: { input: process.stdin, output: process.stdout },
  authenticate,
  fetchProfile: defaultFetchProfile,
  fs: {
    readFile: (p, enc) => fs.readFile(p, enc),
    writeFile: (p, d) => fs.writeFile(p, d, { mode: 0o600 }),
    rename: (a, b) => fs.rename(a, b),
    mkdir: async (p, o) => {
      await mkdir(p, o);
    },
  },
};

async function defaultFetchProfile(accessToken: string): Promise<unknown> {
  // Build a real client that supports refresh, in case the cached token
  // expired between authenticate() and now. This mirrors src/index.ts.
  const onTokenRefresh = async (): Promise<string> => {
    const tokens = await loadTokens();
    if (!tokens) throw new Error("No stored tokens to refresh");
    const refreshed = await refreshAccessToken(tokens.refresh_token, {
      clientId: process.env.WHOOP_CLIENT_ID ?? "",
      clientSecret: process.env.WHOOP_CLIENT_SECRET ?? "",
    });
    const fresh = toOAuthTokens(refreshed, tokens.refresh_token);
    await saveTokens(fresh);
    return fresh.access_token;
  };
  const client = createWhoopClient({ accessToken, onTokenRefresh });
  return getProfile(client);
}

/**
 * Run the setup wizard. Resolves after writing config / printing instructions,
 * or rejects with a human-readable Error if anything goes wrong.
 */
export async function runSetup(options: SetupOptions = {}, deps: RunSetupDeps = {}): Promise<void> {
  const merged: Required<Omit<RunSetupDeps, "io">> & { io: PromptIO } = {
    ...DEFAULT_DEPS,
    ...deps,
    fs: { ...DEFAULT_DEPS.fs, ...(deps.fs ?? {}) },
    io: deps.io ?? DEFAULT_DEPS.io,
  };
  const out = merged.io.output;

  out.write("WHOOP MCP — Setup Wizard\n");
  out.write("------------------------\n\n");

  // --- Step 1: credentials ---
  const clientId =
    options.clientId !== undefined
      ? options.clientId.trim()
      : (
          await promptText(merged.io, "WHOOP Client ID (from https://developer.whoop.com): ")
        ).trim();
  if (!clientId) throw new Error("WHOOP_CLIENT_ID is required");

  const clientSecret =
    options.clientSecret !== undefined
      ? options.clientSecret.trim()
      : (await promptSecret(merged.io, "WHOOP Client Secret (input hidden): ")).trim();
  if (!clientSecret) throw new Error("WHOOP_CLIENT_SECRET is required");

  // Expose to downstream calls (authenticate / fetchProfile pull from env)
  process.env.WHOOP_CLIENT_ID = clientId;
  process.env.WHOOP_CLIENT_SECRET = clientSecret;

  // --- Step 2: optional --verify (OAuth + profile fetch) ---
  if (options.verify) {
    out.write("\nVerifying credentials with WHOOP...\n");
    let accessToken: string;
    try {
      accessToken = await merged.authenticate({ clientId, clientSecret });
    } catch (err) {
      throw new Error(
        `Verification failed during OAuth: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    out.write("OAuth flow complete. Fetching profile...\n");
    try {
      const profile = await merged.fetchProfile(accessToken);
      out.write(`Profile OK: ${JSON.stringify(profile)}\n\n`);
    } catch (err) {
      throw new Error(
        `Verification failed fetching profile: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // --- Step 3: target client ---
  const target: ClientTarget =
    options.client ??
    (((await promptText(
      merged.io,
      "Target client (claude-desktop / claude-code) [claude-desktop]: "
    )) || "claude-desktop") as ClientTarget);

  if (target !== "claude-desktop" && target !== "claude-code") {
    throw new Error(`Invalid client target: "${target}"`);
  }

  // --- Step 4: emit config ---
  const env = { WHOOP_CLIENT_ID: clientId, WHOOP_CLIENT_SECRET: clientSecret };

  if (target === "claude-code") {
    out.write("\nRun this command in your shell to register the server:\n\n");
    out.write(`  ${generateClaudeCodeCommand(env)}\n\n`);
    return;
  }

  // claude-desktop — read existing, backup, merge, write atomically
  const path = options.configPath ?? claudeDesktopConfigPath();
  await writeClaudeDesktopConfig(path, env, merged.fs, out);
}

async function writeClaudeDesktopConfig(
  path: string,
  env: { WHOOP_CLIENT_ID: string; WHOOP_CLIENT_SECRET: string },
  filesystem: Required<RunSetupDeps>["fs"],
  out: NodeJS.WritableStream
): Promise<void> {
  await filesystem.mkdir(dirname(path), { recursive: true });

  let existing: ClaudeDesktopConfig | null = null;
  let existingRaw: string | null = null;
  try {
    existingRaw = await filesystem.readFile(path, "utf8");
    existing = JSON.parse(existingRaw) as ClaudeDesktopConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Existing file is unreadable or invalid JSON — refuse to clobber it.
      throw new Error(
        `Could not parse existing Claude Desktop config at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }. Refusing to overwrite — fix or move the file and re-run setup.`
      );
    }
  }

  const merged = mergeClaudeDesktopConfig(existing, generateClaudeDesktopEntry(env));
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  // Backup existing file before overwriting (so a write failure is recoverable)
  const backupPath = `${path}.bak`;
  let backedUp = false;
  if (existingRaw !== null) {
    await filesystem.writeFile(backupPath, existingRaw);
    backedUp = true;
  }

  // Atomic write: tmp file + rename. If anything fails after the backup,
  // restore the original from .bak so the user is never left with a
  // half-written config.
  const tmpPath = `${path}.tmp`;
  try {
    await filesystem.writeFile(tmpPath, serialized);
    await filesystem.rename(tmpPath, path);
  } catch (err) {
    if (backedUp) {
      try {
        await filesystem.rename(backupPath, path);
      } catch {
        // best-effort restore; the .bak still exists for manual recovery
      }
    }
    throw new Error(
      `Failed to write Claude Desktop config: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  out.write(`\nClaude Desktop config written: ${path}\n`);
  if (backedUp) out.write(`Previous config backed up to: ${backupPath}\n`);
  out.write("Restart Claude Desktop to load the new server.\n\n");
}
