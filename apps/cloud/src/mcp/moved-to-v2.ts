// ---------------------------------------------------------------------------
// Whether an organization's MCP traffic has moved to Executor v2.
//
// Read from `org_moved_to_v2` (see `../org/move-to-v2`). Only a row in state
// `moved` that names the v2 organization forwards: no row, `rolled_back`,
// `moving`, or a `moved` row whose v2 organization does not exist yet all mean
// "serve from v1" (a `moving` org is served frozen: see `../org/move-to-v2`).
// A failed read is NOT "not moved": it fails, and the MCP auth path turns that
// into a retryable "unavailable" rather than serving a possibly moved org from
// v1.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { DbService } from "../db/db";
import { readOrgMoveState, type OrgMoveStateReadError } from "../org/move-to-v2";

/** The v2 organization an org's MCP traffic is forwarded to. */
export interface MovedToV2 {
  readonly v2OrganizationId: string;
}

export const readMovedToV2 = (
  organizationId: string,
): Effect.Effect<MovedToV2 | null, OrgMoveStateReadError, DbService> =>
  readOrgMoveState(organizationId).pipe(
    Effect.map((moveState) =>
      moveState?.state === "moved" && moveState.v2OrganizationId
        ? { v2OrganizationId: moveState.v2OrganizationId }
        : null,
    ),
    Effect.withSpan("mcp.auth.read_moved_to_v2"),
  );
