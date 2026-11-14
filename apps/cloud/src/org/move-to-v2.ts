// ---------------------------------------------------------------------------
// Where an organization stands in its move to Executor v2, and the freeze that
// follows from it.
//
// v2 writes `org_moved_to_v2`; v1 only reads it, once per request that needs
// it (never cached: v2 waits about a minute after writing `moving` before it
// starts copying, and every write v1 accepts after that is lost).
//
//   no row, rolled_back  v1 serves the organization as it always has
//   moving               frozen: writes, OAuth callbacks and OAuth refresh are
//                        refused; reads and tool calls that need neither work
//   moved                writes are refused for good (v2 is the copy that
//                        counts); MCP is forwarded and the dashboard redirects
//
// A state this build does not know is read as `moving`, and a failed read is
// an error, never "not moving": a write path that cannot read the state
// refuses with a retryable error rather than guess.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { Data, Effect, Predicate } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import { OrgWriteDeniedError } from "@executor-js/sdk";

import { isV2OrgSlug } from "../auth/v2-moved";
import { DbService, makeDbLayer } from "../db/db";
import { organizations, orgMovedToV2 } from "../db/schema";
import { mintSessionHandoffToken, sessionHandoffUrl } from "./v2-session-handoff";

/** Shown wherever a write is refused while the organization is moving. */
export const ORG_MOVING_MESSAGE =
  "This workspace is moving to Executor v2. Changes are paused until the move finishes.";

/** Shown wherever a write is refused after the organization has moved. */
export const ORG_MOVED_MESSAGE =
  "This workspace has moved to Executor v2. Make changes in Executor v2 instead.";

/** Shown when the move state could not be read on a write path. */
export const ORG_MOVE_STATE_UNAVAILABLE_MESSAGE =
  "Executor could not confirm this workspace accepts changes right now - please retry";

/** How long a client should wait before retrying a write refused while moving. */
export const ORG_MOVING_RETRY_AFTER_SECONDS = 60;
/** How long a client should wait before retrying after a failed state read. */
export const ORG_MOVE_STATE_RETRY_AFTER_SECONDS = 2;

export type OrgMoveState =
  | { readonly state: "moving" }
  | {
      readonly state: "moved";
      readonly v2OrganizationId: string | null;
      readonly v2OrganizationSlug: string | null;
    };

export class OrgMoveStateReadError extends Data.TaggedError("OrgMoveStateReadError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return ORG_MOVE_STATE_UNAVAILABLE_MESSAGE;
  }
}

/** A write refused because the organization is moving to, or has moved to, v2. */
export class OrgFrozenError extends Data.TaggedError("OrgFrozenError")<{
  readonly state: OrgMoveState["state"];
}> {
  override get message(): string {
    return this.state === "moving" ? ORG_MOVING_MESSAGE : ORG_MOVED_MESSAGE;
  }
}

export interface OrgMoveRow {
  readonly state: string;
  readonly v2OrgId: string | null;
  readonly v2OrgSlug: string | null;
}

/** The move state a stored row means; `null` when v1 serves the org as usual. */
export const orgMoveStateFromRow = (row: OrgMoveRow | undefined): OrgMoveState | null => {
  if (row === undefined || row.state === "rolled_back") return null;
  if (row.state === "moved") {
    return {
      state: "moved",
      v2OrganizationId: row.v2OrgId,
      v2OrganizationSlug: row.v2OrgSlug,
    };
  }
  return { state: "moving" };
};

export const readOrgMoveState = (
  organizationId: string,
): Effect.Effect<OrgMoveState | null, OrgMoveStateReadError, DbService> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            state: orgMovedToV2.state,
            v2OrgId: orgMovedToV2.v2OrgId,
            v2OrgSlug: orgMovedToV2.v2OrgSlug,
          })
          .from(orgMovedToV2)
          .where(eq(orgMovedToV2.orgId, organizationId)),
      catch: (cause) => new OrgMoveStateReadError({ cause }),
    });
    return orgMoveStateFromRow(rows[0]);
  }).pipe(Effect.withSpan("org.read_move_state"));

/**
 * The move state of the organization a dashboard URL names, by its v1 slug,
 * with the organization's id: one read joining the slug to the move row.
 * `null` when no organization has the slug or v1 serves it as usual.
 */
export const readOrgMoveStateBySlug = (
  slug: string,
): Effect.Effect<
  { readonly organizationId: string; readonly moveState: OrgMoveState } | null,
  OrgMoveStateReadError,
  DbService
> =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            organizationId: orgMovedToV2.orgId,
            state: orgMovedToV2.state,
            v2OrgId: orgMovedToV2.v2OrgId,
            v2OrgSlug: orgMovedToV2.v2OrgSlug,
          })
          .from(orgMovedToV2)
          .innerJoin(organizations, eq(organizations.id, orgMovedToV2.orgId))
          .where(eq(organizations.slug, slug)),
      catch: (cause) => new OrgMoveStateReadError({ cause }),
    });
    const row = rows[0];
    const moveState = orgMoveStateFromRow(row);
    return row && moveState ? { organizationId: row.organizationId, moveState } : null;
  }).pipe(Effect.withSpan("org.read_move_state_by_slug"));

/**
 * Where v1's dashboard sends a moved organization: its page on v2's app host.
 * Without a well-formed v2 slug (v2 writes one with `moved`, so this is only a
 * guard) it is v2's app root, which opens the member's own v2 organizations.
 */
export const movedDashboardUrl = (
  moved: Extract<OrgMoveState, { state: "moved" }>,
  v2Origin: URL,
): string =>
  isV2OrgSlug(moved.v2OrganizationSlug)
    ? new URL(`/org/${moved.v2OrganizationSlug}`, v2Origin).href
    : new URL("/", v2Origin).href;

/**
 * Where v1's dashboard sends a page load for the organization `target` names
 * (by URL slug or id), or `null` to serve it in v1: only an organization that
 * has `moved`, and only for a member of it, so the redirect says nothing about
 * an organization the caller cannot open. The move row is read first: the
 * membership read only runs for a moved organization.
 *
 * With `handoff` (the signed-in WorkOS user and the shared secret), the member
 * goes to v2's session handoff with a token vouching for that user, so v2 opens
 * the organization without a second sign-in (`v2-session-handoff.ts`). Without
 * it, or without a v2 slug to open, the redirect is the plain one.
 */
export const movedDashboardLocation = <E, R>(input: {
  readonly target: { readonly slug: string } | { readonly organizationId: string };
  readonly v2Origin: URL;
  readonly isMember: (organizationId: string) => Effect.Effect<boolean, E, R>;
  readonly handoff?: { readonly secret: string; readonly user: string } | undefined;
}): Effect.Effect<string | null, OrgMoveStateReadError | E, DbService | R> =>
  Effect.gen(function* () {
    const { target, handoff } = input;
    const found =
      "slug" in target
        ? yield* readOrgMoveStateBySlug(target.slug)
        : yield* readOrgMoveState(target.organizationId).pipe(
            Effect.map((moveState) =>
              moveState === null ? null : { organizationId: target.organizationId, moveState },
            ),
          );
    if (found === null || found.moveState.state !== "moved") return null;
    if (!(yield* input.isMember(found.organizationId))) return null;
    const slug = found.moveState.v2OrganizationSlug;
    if (handoff === undefined || !isV2OrgSlug(slug))
      return movedDashboardUrl(found.moveState, input.v2Origin);
    const token = yield* Effect.promise(() =>
      mintSessionHandoffToken(handoff.secret, {
        user: handoff.user,
        organization: found.organizationId,
        slug,
      }),
    );
    return sessionHandoffUrl(input.v2Origin, token);
  });

/** Succeeds only when the organization accepts writes in v1. */
export const assertOrgWritable = (
  organizationId: string,
): Effect.Effect<void, OrgFrozenError | OrgMoveStateReadError, DbService> =>
  readOrgMoveState(organizationId).pipe(
    Effect.flatMap((moveState) =>
      moveState === null
        ? Effect.void
        : Effect.fail(new OrgFrozenError({ state: moveState.state })),
    ),
  );

/**
 * Cloud's `workspaceWriteGate` for the executor (see `ExecutorConfig`): the
 * freeze as both request planes see it from inside the SDK — connection and
 * OAuth writes, OAuth completion and OAuth token refresh, whether a dashboard
 * request, an API key, the CLI or an MCP tool call asked for them. It runs on
 * its own short-lived database connection, so the MCP session Durable Object,
 * whose executor outlives any one request, still reads the state fresh on each
 * guarded operation. That second connection is safe because the executor never
 * asks the gate while one of its storage transactions is open: a write
 * transaction asks it just before it opens. (On the single-session PGlite the
 * dev stack and tests run, a connection waiting on an open transaction is
 * never served, so asking from inside one would hang until connect timeout.)
 */
export const cloudWorkspaceWriteGate = (tenant: string): Effect.Effect<void, OrgWriteDeniedError> =>
  assertOrgWritable(tenant).pipe(
    Effect.provide(makeDbLayer()),
    Effect.mapError(
      (error) => new OrgWriteDeniedError({ reason: orgFreezeRefusal(error).message }),
    ),
    Effect.withSpan("org.workspace_write_gate"),
  );

// ---------------------------------------------------------------------------
// HTTP rendering, shared by every plane that refuses a write.
//
//   moving  423 Locked + Retry-After. The org is locked, not the server
//           failing: a 4xx keeps the freeze out of 5xx error rates and stops
//           generic clients from retrying a write in a loop for the minutes a
//           move takes; Retry-After and the message say it is temporary.
//   moved   423 Locked, no Retry-After: v1's copy stays locked for good.
//   read    503 + Retry-After: a genuine transient failure on our side.
// ---------------------------------------------------------------------------

export const ORG_MOVING_CODE = "organization_moving";
export const ORG_MOVED_CODE = "organization_moved";
export const ORG_MOVE_STATE_UNAVAILABLE_CODE = "organization_state_unavailable";

export interface OrgFreezeRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

const MOVING_REFUSAL: OrgFreezeRefusal = {
  status: 423,
  code: ORG_MOVING_CODE,
  message: ORG_MOVING_MESSAGE,
  retryAfterSeconds: ORG_MOVING_RETRY_AFTER_SECONDS,
};
const MOVED_REFUSAL: OrgFreezeRefusal = {
  status: 423,
  code: ORG_MOVED_CODE,
  message: ORG_MOVED_MESSAGE,
};
const STATE_UNAVAILABLE_REFUSAL: OrgFreezeRefusal = {
  status: 503,
  code: ORG_MOVE_STATE_UNAVAILABLE_CODE,
  message: ORG_MOVE_STATE_UNAVAILABLE_MESSAGE,
  retryAfterSeconds: ORG_MOVE_STATE_RETRY_AFTER_SECONDS,
};
const REFUSALS: ReadonlyMap<string, OrgFreezeRefusal> = new Map(
  [MOVING_REFUSAL, MOVED_REFUSAL, STATE_UNAVAILABLE_REFUSAL].map((refusal) => [
    refusal.code,
    refusal,
  ]),
);

/** The refusal a freeze code stands for, or `null` for any other code. */
export const orgFreezeRefusalForCode = (code: string): OrgFreezeRefusal | null =>
  REFUSALS.get(code) ?? null;

export const orgFreezeRefusal = (error: OrgFrozenError | OrgMoveStateReadError): OrgFreezeRefusal =>
  Predicate.isTagged(error, "OrgFrozenError")
    ? error.state === "moving"
      ? MOVING_REFUSAL
      : MOVED_REFUSAL
    : STATE_UNAVAILABLE_REFUSAL;

/** A refusal as cloud's `{ error, code }` JSON API failure. */
export const orgFreezeServerResponse = (
  error: OrgFrozenError | OrgMoveStateReadError,
): HttpServerResponse.HttpServerResponse => {
  const refusal = orgFreezeRefusal(error);
  return HttpServerResponse.jsonUnsafe(
    { error: refusal.message, code: refusal.code },
    {
      status: refusal.status,
      headers: {
        "cache-control": "no-store",
        ...(refusal.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(refusal.retryAfterSeconds) }),
      },
    },
  );
};

/**
 * The refusal to send instead of serving a write to `organizationId`, or
 * `null` when v1 accepts writes for it. For the planes that answer with a
 * plain response (account, domains, billing).
 */
export const frozenWriteResponse = (
  organizationId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse | null, never, DbService> =>
  assertOrgWritable(organizationId).pipe(
    Effect.as(null),
    Effect.catch((error) => Effect.succeed(orgFreezeServerResponse(error))),
  );

// ---------------------------------------------------------------------------
// Which requests the freeze refuses.
// ---------------------------------------------------------------------------

/** Running code is not a change to the organization: the executor's own gate
 *  refuses the writes and refreshes inside an execution (see
 *  `cloudWorkspaceWriteGate`), and everything else it does keeps working, as
 *  MCP tool calls do. The paths are the protected API's, with or without
 *  cloud's `/api` mount. */
const EXECUTION_PATH = /^(?:\/api)?\/executions(?:\/[^/]+\/resume)?$/;

/**
 * Whether a protected-API request would change the organization: any method
 * but GET/HEAD/OPTIONS. Running and resuming executions is exempt.
 *
 * The OAuth callback is a GET that completes a connection, and is let through
 * on purpose: it is a page in the user's popup, so it is refused by the
 * executor's gate at the top of `oauth.complete` (before the authorization
 * code is exchanged), which the popup renders with the freeze message.
 */
export const isFrozenWriteRequest = (method: string, pathname: string): boolean => {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !(method === "POST" && EXECUTION_PATH.test(pathname));
};
