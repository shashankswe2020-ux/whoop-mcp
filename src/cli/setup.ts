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
 *        - codex:          prints the `codex mcp add ...` command to run
 *        - copilot:        prints the `code --add-mcp ...` command to run
 *        - other local clients: prints configuration / registration instructions
 *        - remote clients: prints deployment guidance without collecting secrets
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
  CLIENT_TARGETS,
  generateClaudeCodeCommand,
  generateClaudeDesktopEntry,
  generateCodexCommand,
  generateCopilotCommand,
  generateLocalSetupInstructions,
  remoteSetupInstructions,
  mergeClaudeDesktopConfig,
  type ClaudeDesktopConfig,
  type ClientTarget,
  type ServerEnv,
} from "./config-generators.js";

const SPONSOR_URL = "https://buymeacoffee.com/shashanksw9";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  readonly telemetry?: "on" | "off";
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
 *   --client=<target>       (see CLIENT_TARGETS)
 *   --verify
 *   --config-path=<value>   (test hook)
 */
export function parseSetupArgs(argv: readonly string[]): SetupOptions {
  const out: {
    telemetry?: "on" | "off";
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
      case "--telemetry": {
        const value = valueAt();
        if (value !== "on" && value !== "off") throw new Error("--telemetry must be on or off");
        out.telemetry = value;
        break;
      }
      case "--client-id":
        out.clientId = valueAt();
        break;
      case "--client-secret":
        out.clientSecret = valueAt();
        break;
      case "--client": {
        const v = valueAt();
        if (!isClientTarget(v)) {
          throw new Error(
            `Invalid --client value: "${v}". Must be one of: ${CLIENT_TARGETS.join(", ")}.`
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

function isClientTarget(value: string): value is ClientTarget {
  return (CLIENT_TARGETS as readonly string[]).includes(value);
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
  readonly confirmTelemetry?: (io: PromptIO) => Promise<boolean>;
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
  confirmTelemetry: async (io) => {
    const readline = createInterface({ input: io.input, output: io.output });
    try {
      return await new Promise<boolean>((resolve) => {
        readline.once("close", () => resolve(false));
        readline.question("Share this usage metadata? [y/N]: ", (answer) =>
          resolve(/^(y|yes)$/i.test(answer.trim()))
        );
      });
    } finally {
      readline.close();
    }
  },
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
export async function runSetup(
  options: SetupOptions = {},
  deps: RunSetupDeps = {}
): Promise<Partial<ServerEnv>> {
  const merged: Required<Omit<RunSetupDeps, "io">> & { io: PromptIO } = {
    ...DEFAULT_DEPS,
    ...deps,
    fs: { ...DEFAULT_DEPS.fs, ...(deps.fs ?? {}) },
    io: deps.io ?? DEFAULT_DEPS.io,
  };
  const out = merged.io.output;

  out.write("WHOOP MCP — Setup Wizard\n");
  out.write("------------------------\n\n");

  // --- Resolve target client first so we can peek at any existing config. ---
  const requestedTarget =
    options.client ??
    ((await promptText(
      merged.io,
      `Target client (${CLIENT_TARGETS.join(" / ")}) [claude-desktop]: `
    )) ||
      "claude-desktop");
  if (!isClientTarget(requestedTarget)) {
    throw new Error(`Invalid client target: "${requestedTarget}"`);
  }
  const target = requestedTarget === "claude" ? "claude-desktop" : requestedTarget;
  const remoteInstructions = remoteSetupInstructions(target);
  if (remoteInstructions !== undefined) {
    if (
      options.verify ||
      options.clientId !== undefined ||
      options.clientSecret !== undefined ||
      options.configPath !== undefined ||
      options.telemetry !== undefined
    ) {
      throw new Error(
        "Credential, --verify, --config-path and --telemetry options only apply to local client setup."
      );
    }
    out.write(remoteInstructions);
    writeSponsorRequest(out);
    return { WHOOP_MCP_TELEMETRY: "0" };
  }

  // --- Existing claude-desktop config short-circuit. ---
  // If the user already ran setup, the target config will contain a `whoop`
  // entry with valid env. In that case skip prompting + rewriting; just use
  // those creds and (if --verify) confirm they still work. Explicit
  // --client-id / --client-secret flags force a rewrite.
  const explicitFlags = options.clientId !== undefined || options.clientSecret !== undefined;
  let existingCreds: { clientId: string; clientSecret: string } | null = null;
  let existingConfigPath: string | null = null;
  if (target === "claude-desktop" && !explicitFlags) {
    existingConfigPath = options.configPath ?? claudeDesktopConfigPath();
    existingCreds = await readExistingWhoopCreds(existingConfigPath, merged.fs);
  }

  if (existingCreds && existingConfigPath) {
    out.write(`Existing whoop entry found in ${existingConfigPath}.\n`);
    process.env.WHOOP_CLIENT_ID = existingCreds.clientId;
    process.env.WHOOP_CLIENT_SECRET = existingCreds.clientSecret;
    if (options.verify) {
      await verifyCredentials(existingCreds, merged, out);
      out.write("Existing config verified.\n");
    } else {
      out.write("Re-run with --verify to confirm credentials work.\n");
    }
    const existing = JSON.parse(
      await merged.fs.readFile(existingConfigPath, "utf8")
    ) as ClaudeDesktopConfig;
    const savedEnv = existing.mcpServers?.whoop?.env;
    const consent = await chooseTelemetry(options, merged, savedEnv);
    if (
      options.telemetry !== undefined ||
      (savedEnv?.WHOOP_MCP_TELEMETRY === "1" && consent.WHOOP_MCP_TELEMETRY === "0") ||
      (savedEnv?.WHOOP_MCP_TELEMETRY === undefined && (merged.io.input as NodeJS.ReadStream).isTTY)
    ) {
      await writeClaudeDesktopConfig(
        existingConfigPath,
        {
          WHOOP_CLIENT_ID: existingCreds.clientId,
          WHOOP_CLIENT_SECRET: existingCreds.clientSecret,
          ...consent,
        },
        merged.fs,
        out,
        true
      );
    }
    writeSponsorRequest(out);
    return consent;
  }

  // --- Step 1: credentials ---
  // Precedence: explicit flags > WHOOP_CLIENT_ID/SECRET env vars > interactive prompt.
  const envId = process.env.WHOOP_CLIENT_ID?.trim() ?? "";
  const envSecret = process.env.WHOOP_CLIENT_SECRET?.trim() ?? "";
  const usingEnvCreds =
    options.clientId === undefined &&
    options.clientSecret === undefined &&
    envId.length > 0 &&
    envSecret.length > 0;

  if (usingEnvCreds) {
    out.write("Using credentials from environment (WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET).\n\n");
  }

  const clientId =
    options.clientId !== undefined
      ? options.clientId.trim()
      : usingEnvCreds
        ? envId
        : (
            await promptText(merged.io, "WHOOP Client ID (from https://developer.whoop.com): ")
          ).trim();
  if (!clientId) throw new Error("WHOOP_CLIENT_ID is required");

  const clientSecret =
    options.clientSecret !== undefined
      ? options.clientSecret.trim()
      : usingEnvCreds
        ? envSecret
        : (await promptSecret(merged.io, "WHOOP Client Secret (input hidden): ")).trim();
  if (!clientSecret) throw new Error("WHOOP_CLIENT_SECRET is required");

  // Expose to downstream calls (authenticate / fetchProfile pull from env)
  process.env.WHOOP_CLIENT_ID = clientId;
  process.env.WHOOP_CLIENT_SECRET = clientSecret;

  // --- Step 2: optional --verify (OAuth + profile fetch) ---
  if (options.verify) {
    await verifyCredentials({ clientId, clientSecret }, merged, out);
  }

  // --- Step 3: emit config ---
  const savedEnv =
    target === "claude-desktop"
      ? await readExistingWhoopEnv(options.configPath ?? claudeDesktopConfigPath(), merged.fs)
      : undefined;
  const consent = await chooseTelemetry(options, merged, savedEnv);
  const env = { WHOOP_CLIENT_ID: clientId, WHOOP_CLIENT_SECRET: clientSecret, ...consent };

  if (target === "claude-code") {
    out.write("\nRun this command in your shell to register the server:\n\n");
    out.write(`  ${generateClaudeCodeCommand(env)}\n\n`);
    writeSponsorRequest(out);
    return consent;
  }

  if (target === "codex") {
    out.write("\nRun this command in your shell to register the server with Codex:\n\n");
    out.write(`  ${generateCodexCommand(env)}\n\n`);
    writeSponsorRequest(out);
    return consent;
  }

  if (target === "copilot" || target === "vscode") {
    out.write("\nRun this command to register the server with GitHub Copilot in VS Code:\n\n");
    out.write(`  ${generateCopilotCommand(env)}\n\n`);
    writeSponsorRequest(out);
    return consent;
  }

  const localInstructions = generateLocalSetupInstructions(target, env);
  if (localInstructions !== undefined) {
    out.write(`\n${localInstructions}\n`);
    writeSponsorRequest(out);
    return consent;
  }

  // claude-desktop — read existing, backup, merge, write atomically
  const path = options.configPath ?? claudeDesktopConfigPath();
  await writeClaudeDesktopConfig(path, env, merged.fs, out);
  writeSponsorRequest(out);
  return consent;
}

function writeSponsorRequest(out: NodeJS.WritableStream): void {
  out.write(`If WHOOP MCP helps you, please consider sponsoring the project:\n${SPONSOR_URL}\n`);
}

async function readExistingWhoopCreds(
  path: string,
  filesystem: Required<RunSetupDeps>["fs"]
): Promise<{ clientId: string; clientSecret: string } | null> {
  const env = await readExistingWhoopEnv(path, filesystem);
  const clientId = env?.WHOOP_CLIENT_ID?.trim();
  const clientSecret = env?.WHOOP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function readExistingWhoopEnv(
  path: string,
  filesystem: Required<RunSetupDeps>["fs"]
): Promise<ServerEnv | undefined> {
  let raw: string;
  try {
    raw = await filesystem.readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: ClaudeDesktopConfig;
  try {
    parsed = JSON.parse(raw) as ClaudeDesktopConfig;
  } catch {
    return undefined;
  }
  return parsed.mcpServers?.whoop?.env;
}

async function verifyCredentials(
  creds: { clientId: string; clientSecret: string },
  deps: Required<Omit<RunSetupDeps, "io">> & { io: PromptIO },
  out: NodeJS.WritableStream
): Promise<void> {
  out.write("\nVerifying credentials with WHOOP...\n");
  let accessToken: string;
  try {
    accessToken = await deps.authenticate(creds);
  } catch (err) {
    throw new Error(
      `Verification failed during OAuth: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  out.write("OAuth flow complete. Fetching profile...\n");
  try {
    const profile = await deps.fetchProfile(accessToken);
    out.write(`Profile OK: ${JSON.stringify(profile)}\n\n`);
  } catch (err) {
    throw new Error(
      `Verification failed fetching profile: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function writeClaudeDesktopConfig(
  path: string,
  env: ServerEnv,
  filesystem: Required<RunSetupDeps>["fs"],
  out: NodeJS.WritableStream,
  preserveEntry = false
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

  const original = existing?.mcpServers?.whoop;
  const entry =
    preserveEntry && original
      ? { ...original, env: { ...original.env, ...env } }
      : { ...generateClaudeDesktopEntry(env), env: { ...original?.env, ...env } };
  const merged = mergeClaudeDesktopConfig(existing, entry);
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

async function chooseTelemetry(
  options: SetupOptions,
  deps: Required<Omit<RunSetupDeps, "io">> & { io: PromptIO },
  existing?: ServerEnv
): Promise<Partial<ServerEnv>> {
  const endpoint =
    existing?.WHOOP_MCP_TELEMETRY_ENDPOINT ??
    process.env.WHOOP_MCP_TELEMETRY_ENDPOINT ??
    "https://whoop-mcp-telemetry.whoop-ai-mcp.workers.dev/events";
  const suppressed =
    process.env.DO_NOT_TRACK === "1" ||
    existing?.DO_NOT_TRACK === "1" ||
    (process.env.WHOOP_MCP_PRIVACY_MODE ?? "standard") !== "standard" ||
    (existing?.WHOOP_MCP_PRIVACY_MODE ?? "standard") !== "standard" ||
    (process.env.WHOOP_MCP_TELEMETRY !== undefined && process.env.WHOOP_MCP_TELEMETRY !== "1");
  if (suppressed || options.telemetry === "off") return { WHOOP_MCP_TELEMETRY: "0" };
  if (existing?.WHOOP_MCP_TELEMETRY !== undefined && options.telemetry === undefined)
    return {
      WHOOP_MCP_TELEMETRY: existing.WHOOP_MCP_TELEMETRY,
      ...(existing.WHOOP_MCP_TELEMETRY_ENDPOINT
        ? { WHOOP_MCP_TELEMETRY_ENDPOINT: existing.WHOOP_MCP_TELEMETRY_ENDPOINT }
        : {}),
    };
  let enabled = options.telemetry === "on" || process.env.WHOOP_MCP_TELEMETRY === "1";
  if (!enabled && !(deps.io.input as NodeJS.ReadStream).isTTY) return { WHOOP_MCP_TELEMETRY: "0" };
  let url: URL;
  try {
    url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      endpoint.includes("?") ||
      endpoint.includes("#")
    ) {
      throw new Error("Invalid endpoint");
    }
  } catch {
    deps.io.output.write(
      "Telemetry remains off: endpoint must be HTTPS without credentials, query, or fragment.\n"
    );
    return { WHOOP_MCP_TELEMETRY: "0" };
  }
  deps.io.output.write(
    `\nOptional usage telemetry to ${url.href}: command/tool/prompt names, outcomes and package version only. No health data, chat text, arguments or identifiers. Cloudflare receives network metadata. Disable with WHOOP_MCP_TELEMETRY=0 or DO_NOT_TRACK=1.\n`
  );
  if (!enabled && (deps.io.input as NodeJS.ReadStream).isTTY)
    enabled = await deps.confirmTelemetry(deps.io);
  return enabled
    ? { WHOOP_MCP_TELEMETRY: "1", WHOOP_MCP_TELEMETRY_ENDPOINT: url.href }
    : { WHOOP_MCP_TELEMETRY: "0" };
}
