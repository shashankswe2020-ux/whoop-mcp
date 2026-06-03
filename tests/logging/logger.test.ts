/**
 * Tests for structured logging (Task 13b).
 *
 * Covers: log levels, JSON format, pretty format, request-scoped loggers,
 * redaction, and LogEntry structure.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createLogger,
  createRequestLogger,
  type LogLevel,
  type LogEntry,
} from "../../src/logging/logger.js";

// Capture stderr output
let stderrOutput: string[];
const originalStderrWrite = process.stderr.write;

function captureStderr(): void {
  stderrOutput = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
}

function restoreStderr(): void {
  process.stderr.write = originalStderrWrite;
}

function getLastEntry(): LogEntry {
  const last = stderrOutput[stderrOutput.length - 1];
  if (!last) throw new Error("No stderr output captured");
  return JSON.parse(last) as LogEntry;
}

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

describe("Logger", () => {
  beforeEach(() => {
    captureStderr();
  });

  afterEach(() => {
    restoreStderr();
  });

  describe("log levels", () => {
    it("logs at info level by default", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("hello");
      expect(stderrOutput).toHaveLength(1);
      const entry = getLastEntry();
      expect(entry.level).toBe("info");
      expect(entry.msg).toBe("hello");
    });

    it("filters messages below configured level", () => {
      const logger = createLogger({ level: "warn", format: "json" });
      logger.debug("debug msg");
      logger.info("info msg");
      logger.warn("warn msg");
      expect(stderrOutput).toHaveLength(1);
      expect(getLastEntry().msg).toBe("warn msg");
    });

    it("supports debug level", () => {
      const logger = createLogger({ level: "debug", format: "json" });
      logger.debug("debug msg");
      expect(stderrOutput).toHaveLength(1);
      expect(getLastEntry().level).toBe("debug");
    });

    it("supports error level", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.error("error msg");
      expect(stderrOutput).toHaveLength(1);
      expect(getLastEntry().level).toBe("error");
    });

    it("supports warn level", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.warn("warning");
      expect(stderrOutput).toHaveLength(1);
      expect(getLastEntry().level).toBe("warn");
    });

    it("respects level hierarchy: debug < info < warn < error", () => {
      const logger = createLogger({ level: "error", format: "json" });
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      expect(stderrOutput).toHaveLength(1);
      expect(getLastEntry().level).toBe("error");
    });
  });

  // ---------------------------------------------------------------------------
  // LogEntry structure
  // ---------------------------------------------------------------------------

  describe("LogEntry structure", () => {
    it("includes ts as ISO 8601 timestamp", () => {
      const logger = createLogger({ level: "info", format: "json" });
      const before = new Date().toISOString();
      logger.info("test");
      const after = new Date().toISOString();
      const entry = getLastEntry();
      expect(entry.ts).toBeDefined();
      expect(new Date(entry.ts).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(new Date(entry.ts).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
    });

    it("includes optional fields when provided", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("tool call", { tool: "get_profile", durationMs: 150 });
      const entry = getLastEntry();
      expect(entry.tool).toBe("get_profile");
      expect(entry.durationMs).toBe(150);
    });

    it("includes error field when provided", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.error("failed", { error: "Connection timeout" });
      const entry = getLastEntry();
      expect(entry.error).toBe("Connection timeout");
    });

    it("does not include undefined optional fields", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("simple");
      const raw = stderrOutput[0]!;
      expect(raw).not.toContain("requestId");
      expect(raw).not.toContain("tool");
      expect(raw).not.toContain("durationMs");
      expect(raw).not.toContain("error");
    });
  });

  // ---------------------------------------------------------------------------
  // JSON format
  // ---------------------------------------------------------------------------

  describe("JSON format", () => {
    it("outputs valid JSON lines to stderr", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("line 1");
      logger.info("line 2");
      expect(stderrOutput).toHaveLength(2);
      // Each line should be parseable JSON
      for (const line of stderrOutput) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it("each line ends with newline", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("msg");
      expect(stderrOutput[0]).toMatch(/\n$/);
    });
  });

  // ---------------------------------------------------------------------------
  // Pretty format
  // ---------------------------------------------------------------------------

  describe("pretty format", () => {
    it("outputs human-readable format", () => {
      const logger = createLogger({ level: "info", format: "pretty" });
      logger.info("server started");
      const output = stderrOutput[0]!;
      // Should contain timestamp, level, and message
      expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
      expect(output).toContain("INFO");
      expect(output).toContain("server started");
    });

    it("includes extra fields in pretty format", () => {
      const logger = createLogger({ level: "info", format: "pretty" });
      logger.info("tool call", { tool: "get_recovery", durationMs: 42 });
      const output = stderrOutput[0]!;
      expect(output).toContain("get_recovery");
      expect(output).toContain("42");
    });

    it("includes requestId in pretty format", () => {
      const logger = createRequestLogger("req-abc", { level: "info", format: "pretty" });
      logger.info("handling request");
      const output = stderrOutput[0]!;
      expect(output).toContain("req-abc");
    });
  });

  // ---------------------------------------------------------------------------
  // createRequestLogger
  // ---------------------------------------------------------------------------

  describe("createRequestLogger", () => {
    it("includes requestId in every log entry", () => {
      const logger = createRequestLogger("req-123", { level: "info", format: "json" });
      logger.info("handling request");
      const entry = getLastEntry();
      expect(entry.requestId).toBe("req-123");
    });

    it("merges requestId with other extra fields", () => {
      const logger = createRequestLogger("req-456", { level: "info", format: "json" });
      logger.info("tool call", { tool: "get_sleep", durationMs: 200 });
      const entry = getLastEntry();
      expect(entry.requestId).toBe("req-456");
      expect(entry.tool).toBe("get_sleep");
      expect(entry.durationMs).toBe(200);
    });

    it("respects log level from options", () => {
      const logger = createRequestLogger("req-789", { level: "warn", format: "json" });
      logger.info("should not appear");
      logger.warn("should appear");
      expect(stderrOutput).toHaveLength(1);
      expect(getLastEntry().msg).toBe("should appear");
    });
  });

  // ---------------------------------------------------------------------------
  // Redaction
  // ---------------------------------------------------------------------------

  describe("redaction", () => {
    it("does not log token values in extra fields", () => {
      const logger = createLogger({ level: "info", format: "json" });
      // The logger should strip known sensitive field names
      logger.info("auth", {
        token: "secret-value-123",
        accessToken: "at-secret",
        refreshToken: "rt-secret",
      } as Record<string, string>);
      const raw = stderrOutput[0]!;
      expect(raw).not.toContain("secret-value-123");
      expect(raw).not.toContain("at-secret");
      expect(raw).not.toContain("rt-secret");
      expect(raw).toContain("[REDACTED]");
    });
  });

  // ---------------------------------------------------------------------------
  // parseLogLevel
  // ---------------------------------------------------------------------------

  describe("level parsing", () => {
    it("defaults to info for unknown level strings", () => {
      const logger = createLogger({ level: "bogus" as LogLevel, format: "json" });
      logger.info("test");
      expect(stderrOutput).toHaveLength(1);
    });
  });
});
