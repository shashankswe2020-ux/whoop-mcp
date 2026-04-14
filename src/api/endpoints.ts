/**
 * WHOOP API endpoint constants.
 *
 * Base URL, OAuth URLs, required scopes, and all endpoint paths
 * used by the 6 MCP tools.
 */

/** WHOOP API v2 base URL */
export const WHOOP_API_BASE_URL = "https://api.prod.whoop.com/developer";

/** OAuth authorization endpoint — browser redirect target */
export const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";

/** OAuth token exchange endpoint */
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

/** All OAuth scopes required by the 6 MCP tools */
export const WHOOP_REQUIRED_SCOPES =
  "offline read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement";

/** Default OAuth redirect URI for the local callback server */
export const WHOOP_REDIRECT_URI = "http://localhost:3000/callback";

// ---------------------------------------------------------------------------
// Endpoint paths (relative to WHOOP_API_BASE_URL)
// ---------------------------------------------------------------------------

/** GET — basic user profile (name, email) */
export const ENDPOINT_USER_PROFILE = "/v2/user/profile/basic";

/** GET — body measurements (height, weight, max HR) */
export const ENDPOINT_BODY_MEASUREMENT = "/v2/user/measurement/body";

/** GET — paginated recovery collection */
export const ENDPOINT_RECOVERY = "/v2/recovery";

/** GET — paginated sleep collection */
export const ENDPOINT_SLEEP = "/v2/activity/sleep";

/** GET — paginated workout collection */
export const ENDPOINT_WORKOUT = "/v2/activity/workout";

/** GET — paginated cycle collection */
export const ENDPOINT_CYCLE = "/v2/cycle";
