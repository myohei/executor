// ---------------------------------------------------------------------------
// Handing a member's verified v1 session to Executor v2.
//
// v2 never signs anyone in with WorkOS. When the dashboard redirects a
// signed-in member of an organization that has moved, it sends them to v2's
// `/api/v1-handoff` with a token vouching for the WorkOS session it has just
// verified, and v2 starts its own session for the user its import mapped:
//
//   v1hnd.<payload>.<sig>
//
//   payload  base64url (no padding) of the UTF-8 JSON
//            {"v":1,"aud":"v2-session-handoff","user","organization","slug",
//             "iat","exp","jti"}
//   sig      base64url (no padding) of HMAC-SHA256 over "v1hnd." + payload,
//            keyed by the UTF-8 bytes of V2_SESSION_HANDOFF_SECRET
//
// `user` is the WorkOS user, `organization` the v1 organization, `slug` the
// v2 organization to open. A token lives a minute and v2 accepts each `jti`
// once. The secret is its own: it is never the MCP forward secret.
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "v1hnd";
const TOKEN_VERSION = 1;
export const SESSION_HANDOFF_AUDIENCE = "v2-session-handoff";
export const SESSION_HANDOFF_TTL_SECONDS = 60;

/** v2's route that turns a token into a v2 session. */
export const SESSION_HANDOFF_PATH = "/api/v1-handoff";

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export interface SessionHandoffClaims {
  /** The WorkOS user whose session v1 verified. */
  readonly user: string;
  /** The v1 organization that moved. */
  readonly organization: string;
  /** The v2 organization to open. */
  readonly slug: string;
}

export const mintSessionHandoffToken = async (
  secret: string,
  claims: SessionHandoffClaims,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> => {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        v: TOKEN_VERSION,
        aud: SESSION_HANDOFF_AUDIENCE,
        user: claims.user,
        organization: claims.organization,
        slug: claims.slug,
        iat: nowSeconds,
        exp: nowSeconds + SESSION_HANDOFF_TTL_SECONDS,
        jti: base64Url(crypto.getRandomValues(new Uint8Array(18))),
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${TOKEN_PREFIX}.${payload}`),
  );
  return `${TOKEN_PREFIX}.${payload}.${base64Url(new Uint8Array(signature))}`;
};

/** Where v1 sends the member: v2's handoff route on its app host. */
export const sessionHandoffUrl = (v2Origin: URL, token: string): string => {
  const url = new URL(SESSION_HANDOFF_PATH, v2Origin);
  url.searchParams.set("token", token);
  return url.href;
};
