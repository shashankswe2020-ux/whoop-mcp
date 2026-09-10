import { describe, it, expect, vi, afterEach } from "vitest";
import { runDoctor, type DoctorDependencies } from "../../src/cli/doctor.js";

function dependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    env: { WHOOP_CLIENT_ID: "private-id", WHOOP_CLIENT_SECRET: "private-secret" },
    nodeVersion: "22.0.0",
    platform: "darwin",
    inspectToken: vi
      .fn()
      .mockResolvedValue({ exists: true, regular: true, mode: 0o600, directoryMode: 0o700 }),
    write: vi.fn(),
    ...overrides,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("doctor", () => {
  it("reports local readiness without network requests or secrets", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Unexpected network");
    });
    vi.stubGlobal("fetch", fetch);
    const deps = dependencies();
    expect(await runDoctor(["--json"], deps)).toBe(0);
    const text = vi.mocked(deps.write).mock.calls[0]![0];
    expect(JSON.parse(text)).toMatchObject({
      ready: true,
      scope_status: "unknown",
      token_validity: "unknown",
    });
    expect(text).not.toContain("private-id");
    expect(text).not.toContain("private-secret");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { nodeVersion: "18.0.0" },
    { env: {} },
    { env: { WHOOP_CLIENT_ID: "x", WHOOP_CLIENT_SECRET: "y", MCP_TRANSPORT: "http" } },
    {
      inspectToken: vi
        .fn()
        .mockResolvedValue({ exists: false, regular: false, mode: 0, directoryMode: 0 }),
    },
    {
      inspectToken: vi
        .fn()
        .mockResolvedValue({ exists: true, regular: true, mode: 0o644, directoryMode: 0o700 }),
    },
    {
      inspectToken: vi
        .fn()
        .mockResolvedValue({ exists: true, regular: false, mode: 0o600, directoryMode: 0o700 }),
    },
    { platform: "win32" as const },
  ])("returns remediation status for unsafe local state %j", async (overrides) => {
    expect(await runDoctor([], dependencies(overrides))).toBe(1);
  });
  it("rejects unknown arguments without inspecting tokens", async () => {
    const deps = dependencies();
    expect(await runDoctor(["--verify"], deps)).toBe(2);
    expect(deps.inspectToken).not.toHaveBeenCalled();
  });
  it("sanitizes filesystem failures", async () => {
    const deps = dependencies({
      inspectToken: vi.fn().mockRejectedValue(new Error("/private/token/path")),
    });
    expect(await runDoctor(["--json"], deps)).toBe(1);
    expect(vi.mocked(deps.write).mock.calls[0]![0]).not.toContain("/private");
  });
});
