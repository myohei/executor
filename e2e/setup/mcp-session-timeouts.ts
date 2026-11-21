// Expiry coverage waits on this, so it stays far below production's five
// minutes. Its floor is the cap-eviction scenario: it opens sessions one at a
// time and needs cap + 1 of them resident at once, so that many opens must
// finish inside this window (see resident-runtime-cap.ts).
const DEFAULT_E2E_MCP_SESSION_TIMEOUT_MS = 8_000;
// Keep expiry coverage fast while leaving enough room for a cold browser route
// to compile under CI contention. Production allows nine minutes.
const DEFAULT_E2E_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS = 30_000;
const PRODUCTION_MCP_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const PRODUCTION_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS = 9 * 60 * 1000;

export const MCP_SESSION_TIMEOUT_ENV = "MCP_SESSION_TIMEOUT_MS";
export const MCP_PAUSED_SESSION_IDLE_TIMEOUT_ENV = "MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS";

const positiveMilliseconds = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

export const ensureE2eMcpSessionTimeoutEnv = (): {
  readonly sessionTimeoutMs: number;
  readonly pausedSessionIdleTimeoutMs: number;
} => {
  const sessionTimeoutMs =
    positiveMilliseconds(process.env[MCP_SESSION_TIMEOUT_ENV]) ??
    DEFAULT_E2E_MCP_SESSION_TIMEOUT_MS;
  const pausedSessionIdleTimeoutMs =
    positiveMilliseconds(process.env[MCP_PAUSED_SESSION_IDLE_TIMEOUT_ENV]) ??
    DEFAULT_E2E_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS;

  process.env[MCP_SESSION_TIMEOUT_ENV] = String(sessionTimeoutMs);
  process.env[MCP_PAUSED_SESSION_IDLE_TIMEOUT_ENV] = String(pausedSessionIdleTimeoutMs);

  return { sessionTimeoutMs, pausedSessionIdleTimeoutMs };
};

export const configuredMcpPausedSessionIdleTimeoutMs = (): number =>
  positiveMilliseconds(process.env[MCP_PAUSED_SESSION_IDLE_TIMEOUT_ENV]) ??
  PRODUCTION_MCP_PAUSED_SESSION_IDLE_TIMEOUT_MS;

export const configuredMcpSessionTimeoutMs = (): number =>
  positiveMilliseconds(process.env[MCP_SESSION_TIMEOUT_ENV]) ?? PRODUCTION_MCP_SESSION_TIMEOUT_MS;
