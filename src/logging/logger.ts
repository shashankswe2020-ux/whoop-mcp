/**
 * Structured logger for the WHOOP MCP server.
 *
 * Outputs JSON lines to stderr (stdout reserved for MCP stdio transport).
 * Supports log level filtering, pretty format for local dev, and
 * request-scoped loggers with correlation IDs.
 *
 * Zero runtime dependencies — just JSON.stringify + process.stderr.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  requestId?: string;
  tool?: string;
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
}

export interface LogOptions {
  level: LogLevel;
  format: "json" | "pretty";
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Level hierarchy
// ---------------------------------------------------------------------------

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// Sensitive field redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = new Set([
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "secret",
  "clientSecret",
  "client_secret",
  "password",
  "authorization",
]);

function redactSensitive(extra: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatJson(entry: LogEntry): string {
  return JSON.stringify(entry) + "\n";
}

function formatPretty(entry: LogEntry): string {
  const { ts, level, msg, ...rest } = entry;
  const levelStr = level.toUpperCase().padEnd(5);
  let line = `[${ts}] ${levelStr} ${msg}`;

  const extraKeys = Object.keys(rest);
  if (extraKeys.length > 0) {
    const pairs = extraKeys.map((k) => `${k}=${String(rest[k])}`).join(", ");
    line += ` {${pairs}}`;
  }

  return line + "\n";
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel): boolean {
  const messagePriority = LEVEL_PRIORITY[messageLevel] ?? LEVEL_PRIORITY.info;
  const configuredPriority = LEVEL_PRIORITY[configuredLevel] ?? LEVEL_PRIORITY.info;
  return messagePriority >= configuredPriority;
}

function buildLogger(options: LogOptions, baseExtra?: Record<string, unknown>): Logger {
  const { level: configuredLevel, format } = options;
  const formatter = format === "pretty" ? formatPretty : formatJson;

  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (!shouldLog(level, configuredLevel)) return;

    const merged = { ...baseExtra, ...extra };
    const redacted = redactSensitive(merged);

    // Build entry with only defined fields
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
    };

    for (const [key, value] of Object.entries(redacted)) {
      if (value !== undefined) {
        entry[key] = value;
      }
    }

    process.stderr.write(formatter(entry));
  }

  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  };
}

/**
 * Create a logger with the given options.
 *
 * @param options - Log level and format configuration
 */
export function createLogger(options: LogOptions): Logger {
  return buildLogger(options);
}

/**
 * Create a request-scoped logger that automatically includes the requestId
 * in every log entry.
 *
 * @param requestId - Correlation ID for the request
 * @param options - Log level and format configuration
 */
export function createRequestLogger(requestId: string, options: LogOptions): Logger {
  return buildLogger(options, { requestId });
}
