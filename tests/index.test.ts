/**
 * Tests for the entry point (src/index.ts).
 *
 * All dependencies are mocked — no real OAuth, no real fetch, no real filesystem.
 * Verifies env var validation, authentication wiring, client creation with
 * token refresh, MCP server creation, and stdio transport connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockAuthenticate = vi.fn<() => Promise<string>>();
const mockRefreshAccessToken = vi.fn();
const mockToOAuthTokens = vi.fn();

vi.mock("../src/auth/oauth.js", () => ({
  authenticate: (...args: unknown[]) => mockAuthenticate(...(args as Parameters<typeof mockAuthenticate>)),
  refreshAccessToken: (...args: unknown[]) =>
    mockRefreshAccessToken(...args),
  toOAuthTokens: (...args: unknown[]) => mockToOAuthTokens(...args),
}));

const mockLoadTokens = vi.fn();
const mockSaveTokens = vi.fn();

vi.mock("../src/auth/token-store.js", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  saveTokens: (...args: unknown[]) => mockSaveTokens(...args),
}));

const mockCreateWhoopClient = vi.fn();

vi.mock("../src/api/client.js", () => ({
  createWhoopClient: (...args: unknown[]) =>
    mockCreateWhoopClient(...args),
}));

const mockConnect = vi.fn<() => Promise<void>>();
const mockCreateWhoopServer = vi.fn();

vi.mock("../src/server.js", () => ({
  createWhoopServer: (...args: unknown[]) =>
    mockCreateWhoopServer(...args),
}));

const mockStdioTransportInstance = { _mock: true };
const MockStdioServerTransport = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: MockStdioServerTransport,
}));

// ---------------------------------------------------------------------------
// Import the module under test — must be after mocks
// ---------------------------------------------------------------------------

// We dynamically import so vi.mock() hoists above the import.
// Note: ESM import() caches — every call returns the same module.
// This works because main() reads process.env at call time, not import time.
async function importMain(): Promise<{ main: () => Promise<void> }> {
  const mod = await import("../src/index.js");
  return mod;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up mocks for the happy path */
function setupHappyPath(): void {
  mockAuthenticate.mockResolvedValue("test-access-token");
  const mockClient = { get: vi.fn() };
  mockCreateWhoopClient.mockReturnValue(mockClient);
  const mockServer = { connect: mockConnect };
  mockCreateWhoopServer.mockReturnValue(mockServer);
  mockConnect.mockResolvedValue(undefined);
  MockStdioServerTransport.mockReturnValue(mockStdioTransportInstance);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("main() entry point", () => {
  const originalEnv = { ...process.env };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Suppress console.error output during tests
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Set required env vars by default
    process.env.WHOOP_CLIENT_ID = "test-client-id";
    process.env.WHOOP_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    consoleErrorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Env var validation
  // -------------------------------------------------------------------------

  describe("environment variable validation", () => {
    it("throws when WHOOP_CLIENT_ID is missing", async () => {
      delete process.env.WHOOP_CLIENT_ID;
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_ID");
    });

    it("throws when WHOOP_CLIENT_ID is empty string", async () => {
      process.env.WHOOP_CLIENT_ID = "";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_ID");
    });

    it("throws when WHOOP_CLIENT_SECRET is missing", async () => {
      delete process.env.WHOOP_CLIENT_SECRET;
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_SECRET");
    });

    it("throws when WHOOP_CLIENT_SECRET is empty string", async () => {
      process.env.WHOOP_CLIENT_SECRET = "";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_SECRET");
    });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("calls authenticate with client ID and secret from env", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockAuthenticate).toHaveBeenCalledOnce();
      expect(mockAuthenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        }),
      );
    });

    it("propagates authentication errors", async () => {
      setupHappyPath();
      mockAuthenticate.mockRejectedValue(
        new Error("OAuth flow failed"),
      );

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("OAuth flow failed");
    });
  });

  // -------------------------------------------------------------------------
  // Client creation
  // -------------------------------------------------------------------------

  describe("WHOOP client creation", () => {
    it("creates a WHOOP client with the access token from authenticate", async () => {
      setupHappyPath();
      mockAuthenticate.mockResolvedValue("my-access-token-123");

      const { main } = await importMain();
      await main();

      expect(mockCreateWhoopClient).toHaveBeenCalledOnce();
      expect(mockCreateWhoopClient).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "my-access-token-123",
        }),
      );
    });

    it("provides an onTokenRefresh callback to the client", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh?: () => Promise<string>;
      };
      expect(clientOptions.onTokenRefresh).toBeTypeOf("function");
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh callback
  // -------------------------------------------------------------------------

  describe("onTokenRefresh callback", () => {
    it("loads tokens, refreshes, saves, and returns new access token", async () => {
      setupHappyPath();

      const storedTokens = {
        access_token: "old-access",
        refresh_token: "stored-refresh-token",
        expires_at: Date.now() - 1000,
        token_type: "Bearer",
      };
      mockLoadTokens.mockResolvedValue(storedTokens);

      const refreshResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read:recovery",
      };
      mockRefreshAccessToken.mockResolvedValue(refreshResponse);

      const newTokens = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      };
      mockToOAuthTokens.mockReturnValue(newTokens);
      mockSaveTokens.mockResolvedValue(undefined);

      const { main } = await importMain();
      await main();

      // Extract the onTokenRefresh callback
      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };
      const newAccessToken = await clientOptions.onTokenRefresh();

      expect(mockLoadTokens).toHaveBeenCalled();
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(
        "stored-refresh-token",
        expect.objectContaining({
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        }),
      );
      expect(mockToOAuthTokens).toHaveBeenCalledWith(refreshResponse);
      expect(mockSaveTokens).toHaveBeenCalledWith(newTokens);
      expect(newAccessToken).toBe("new-access-token");
    });

    it("throws when no stored tokens are found", async () => {
      setupHappyPath();
      mockLoadTokens.mockResolvedValue(null);

      const { main } = await importMain();
      await main();

      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };
      await expect(clientOptions.onTokenRefresh()).rejects.toThrow(
        /no stored tokens/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // MCP server creation and transport
  // -------------------------------------------------------------------------

  describe("MCP server and stdio transport", () => {
    it("creates the MCP server with the WHOOP client", async () => {
      setupHappyPath();
      const mockClient = { get: vi.fn() };
      mockCreateWhoopClient.mockReturnValue(mockClient);

      const { main } = await importMain();
      await main();

      expect(mockCreateWhoopServer).toHaveBeenCalledOnce();
      expect(mockCreateWhoopServer).toHaveBeenCalledWith(mockClient);
    });

    it("creates a StdioServerTransport", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
    });

    it("connects the server to the stdio transport", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockConnect).toHaveBeenCalledOnce();
      expect(mockConnect).toHaveBeenCalledWith(mockStdioTransportInstance);
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  describe("stderr logging", () => {
    it("logs startup message to stderr", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      // At least one call to console.error with startup info
      const allMessages = consoleErrorSpy.mock.calls
        .map((c) => String(c[0]))
        .join(" ");
      expect(allMessages).toMatch(/whoop.*mcp.*start/i);
    });
  });
});
