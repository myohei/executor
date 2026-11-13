// ---------------------------------------------------------------------------
// The move-to-v2 state, the freeze's request classification and its HTTP
// refusals: the pure parts of `./move-to-v2`. The database-backed parts are in
// `./move-to-v2.node.test.ts`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

import { CLOUD_MOUNT_PREFIX } from "../engine/execution-stack";
import {
  ORG_MOVED_CODE,
  ORG_MOVED_MESSAGE,
  ORG_MOVE_STATE_UNAVAILABLE_CODE,
  ORG_MOVE_STATE_UNAVAILABLE_MESSAGE,
  ORG_MOVING_CODE,
  ORG_MOVING_MESSAGE,
  OrgFrozenError,
  OrgMoveStateReadError,
  isFrozenWriteRequest,
  movedDashboardUrl,
  orgFreezeRefusal,
  orgFreezeRefusalForCode,
  orgFreezeServerResponse,
  orgMoveStateFromRow,
} from "./move-to-v2";

const row = (state: string, v2OrgId: string | null = null, v2OrgSlug: string | null = null) => ({
  state,
  v2OrgId,
  v2OrgSlug,
});

describe("move state", () => {
  it("serves an organization as usual with no row or a rolled-back move", () => {
    expect(orgMoveStateFromRow(undefined)).toBeNull();
    expect(orgMoveStateFromRow(row("rolled_back", "v2-org", "acme"))).toBeNull();
  });

  it("reads moving and moved, with the v2 organization once it exists", () => {
    expect(orgMoveStateFromRow(row("moving"))).toEqual({ state: "moving" });
    expect(orgMoveStateFromRow(row("moved"))).toEqual({
      state: "moved",
      v2OrganizationId: null,
      v2OrganizationSlug: null,
    });
    expect(orgMoveStateFromRow(row("moved", "v2-org", "acme"))).toEqual({
      state: "moved",
      v2OrganizationId: "v2-org",
      v2OrganizationSlug: "acme",
    });
  });

  it("reads a state this build does not know as moving", () => {
    expect(orgMoveStateFromRow(row("failed"))).toEqual({ state: "moving" });
  });
});

describe("frozen write requests", () => {
  const api = (path: string) => `${CLOUD_MOUNT_PREFIX}${path}`;

  it("lets reads through", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isFrozenWriteRequest(method, api("/connections"))).toBe(false);
    }
  });

  it("refuses every other method on the organization's routes", () => {
    for (const [method, path] of [
      ["POST", "/connections"],
      ["PATCH", "/connections/user/github/main"],
      ["DELETE", "/integrations/github"],
      ["PUT", "/artifacts/art_1/preview"],
      ["POST", "/oauth/complete"],
      ["POST", "/oauth/start"],
      ["POST", "/connections/org/github/main/refresh"],
      ["POST", "/policies"],
      ["POST", "/toolkits"],
    ] as const) {
      expect(isFrozenWriteRequest(method, api(path))).toBe(true);
    }
  });

  it("keeps executions running", () => {
    expect(isFrozenWriteRequest("POST", api("/executions"))).toBe(false);
    expect(isFrozenWriteRequest("POST", api("/executions/exec_1/resume"))).toBe(false);
    expect(isFrozenWriteRequest("POST", "/executions")).toBe(false);
    expect(isFrozenWriteRequest("DELETE", api("/executions"))).toBe(true);
    expect(isFrozenWriteRequest("POST", api("/executions/exec_1/other"))).toBe(true);
  });

  it("leaves the OAuth callback to the executor's gate, which the popup can render", () => {
    expect(isFrozenWriteRequest("GET", api("/oauth/callback"))).toBe(false);
  });
});

describe("refusals", () => {
  it("locks a moving organization, temporarily", () => {
    const refusal = orgFreezeRefusal(new OrgFrozenError({ state: "moving" }));
    expect(refusal).toEqual({
      status: 423,
      code: ORG_MOVING_CODE,
      message: ORG_MOVING_MESSAGE,
      retryAfterSeconds: 60,
    });
    expect(ORG_MOVING_MESSAGE).toBe(
      "This workspace is moving to Executor v2. Changes are paused until the move finishes.",
    );
  });

  it("locks a moved organization for good", () => {
    expect(orgFreezeRefusal(new OrgFrozenError({ state: "moved" }))).toEqual({
      status: 423,
      code: ORG_MOVED_CODE,
      message: ORG_MOVED_MESSAGE,
    });
  });

  it("answers a failed state read with a retryable 503", () => {
    expect(orgFreezeRefusal(new OrgMoveStateReadError({ cause: "down" }))).toEqual({
      status: 503,
      code: ORG_MOVE_STATE_UNAVAILABLE_CODE,
      message: ORG_MOVE_STATE_UNAVAILABLE_MESSAGE,
      retryAfterSeconds: 2,
    });
  });

  it("finds a refusal by its code, and nothing else", () => {
    expect(orgFreezeRefusalForCode(ORG_MOVING_CODE)?.status).toBe(423);
    expect(orgFreezeRefusalForCode(ORG_MOVE_STATE_UNAVAILABLE_CODE)?.status).toBe(503);
    expect(orgFreezeRefusalForCode("api_key_validation_unavailable")).toBeNull();
    expect(orgFreezeRefusalForCode("toString")).toBeNull();
  });

  it("renders cloud's { error, code } body with Retry-After", async () => {
    const response = orgFreezeServerResponse(new OrgFrozenError({ state: "moving" }));
    expect(response.status).toBe(423);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.headers["cache-control"]).toBe("no-store");
    const moved = orgFreezeServerResponse(new OrgFrozenError({ state: "moved" }));
    expect(moved.headers["retry-after"]).toBeUndefined();
  });
});

describe("moved dashboard URL", () => {
  const origin = new URL("https://app.example.test");
  const moved = (slug: string | null) =>
    ({ state: "moved", v2OrganizationId: "v2-org", v2OrganizationSlug: slug }) as const;

  it("opens the organization's page on v2", () => {
    expect(movedDashboardUrl(moved("acme-team"), origin)).toBe(
      "https://app.example.test/org/acme-team",
    );
  });

  it("opens v2's root without a well-formed v2 slug", () => {
    expect(movedDashboardUrl(moved(null), origin)).toBe("https://app.example.test/");
    expect(movedDashboardUrl(moved("../admin"), origin)).toBe("https://app.example.test/");
    expect(movedDashboardUrl(moved("Acme"), origin)).toBe("https://app.example.test/");
  });
});
