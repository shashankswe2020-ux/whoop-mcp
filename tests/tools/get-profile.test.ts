import { describe, it, expect, vi } from "vitest";
import { getProfile } from "../../src/tools/get-profile.js";
import type { UserProfile } from "../../src/api/types.js";
import { ENDPOINT_USER_PROFILE } from "../../src/api/endpoints.js";
import { createMockClient } from "../helpers/mock-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE_FIXTURE: UserProfile = {
  user_id: 12345,
  email: "jane@example.com",
  first_name: "Jane",
  last_name: "Doe",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getProfile", () => {
  it("calls the correct endpoint", async () => {
    const client = createMockClient(PROFILE_FIXTURE);

    await getProfile(client);

    expect(client.get).toHaveBeenCalledWith(ENDPOINT_USER_PROFILE);
  });

  it("calls the endpoint exactly once", async () => {
    const client = createMockClient(PROFILE_FIXTURE);

    await getProfile(client);

    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("returns the user profile from the API", async () => {
    const client = createMockClient(PROFILE_FIXTURE);

    const result = await getProfile(client);

    expect(result).toEqual(PROFILE_FIXTURE);
  });

  it("propagates API errors", async () => {
    const client = createMockClient(undefined);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WHOOP API error: 401 Unauthorized")
    );

    await expect(getProfile(client)).rejects.toThrow("WHOOP API error: 401 Unauthorized");
  });
});
