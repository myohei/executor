// ---------------------------------------------------------------------------
// The account plane's freeze over HTTP: every non-GET `/account/*` route
// changes the organization the selector names, and the account middleware
// refuses those for an organization moving to (or moved to) Executor v2 before
// the WorkOS account service runs. The move state is read from the real PGlite
// test database; WorkOS, the user store and the membership mirror are stubs,
// and WorkOS dies on anything but session authentication and the one update
// the open organization's request is allowed to make.
// ---------------------------------------------------------------------------

import { verifiedSettingsCookie } from "../../test-stubs/verified-settings";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { MemberDirectory } from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import { ORG_SELECTOR_HEADER } from "../auth/organization";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "../auth/workos-mirror";
import { DbService, makeDbLayer } from "../db/db";
import { organizations, orgMovedToV2 } from "../db/schema";
import {
  ORG_MOVED_CODE,
  ORG_MOVED_MESSAGE,
  ORG_MOVING_CODE,
  ORG_MOVING_MESSAGE,
} from "../org/move-to-v2";
import { makeAccountApiLive } from "./account-api";

const CALLER = "user_synthetic_admin";
const createdAt = new Date("2026-01-01T00:00:00.000Z");

const organizationRow = (id: string) => ({
  id,
  name: `Org ${id}`,
  slug: id,
  backfilledAt: createdAt,
  deletedAt: null,
  workosUpdatedAt: null,
  createdAt,
});

const unreadStore = (why: string) => () => Effect.runPromise(Effect.die(why));
const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: unreadStore("accounts are not minted here"),
        getAccount: unreadStore("accounts are not read here"),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...organizationRow(org.id),
          name: org.name,
        }),
        getOrganization: async (id: string) => organizationRow(id),
        getOrganizationBySlug: unreadStore("selectors here are ids"),
        markOrganizationDeleted: unreadStore("nothing is deleted here"),
        deleteOrganizationCascade: unreadStore("nothing is deleted here"),
      }),
    ),
});

// The caller is an active admin of every organization a test names.
const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(
      accountId === CALLER
        ? {
            accountId,
            membershipId: `om_${organizationId}`,
            organizationId,
            email: null,
            name: null,
            avatarUrl: null,
            role: "admin",
            status: "active" as const,
            lastActiveAt: null,
          }
        : null,
    ),
  membershipById: () => Effect.die("not read here"),
  membershipsOf: () => Effect.die("not read here"),
  members: () => Effect.die("not read here"),
  membersById: () => Effect.die("not read here"),
  findByEmail: () => Effect.die("not read here"),
});

const stubMirror = Layer.succeed(
  WorkOsMirror,
  new Proxy({} as WorkOsMirrorShape, {
    get: (_target, prop) => () => Effect.die(`unexpected WorkOsMirror.${String(prop)} call`),
  }),
);

/** WorkOS as the account plane sees it; every other call it gets is recorded. */
const stubWorkOS = (calls: string[]) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        const method = String(prop);
        if (method === "authenticateSealedSession") {
          return () =>
            Effect.succeed({
              userId: CALLER,
              sessionId: "test-settings-session",
              email: "admin@placeholder.test",
              organizationId: null,
            });
        }
        if (method === "updateOrganization") {
          return (id: string, name: string) =>
            Effect.sync(() => {
              calls.push(method);
              return { id, name, updatedAt: createdAt.toISOString() };
            });
        }
        return () =>
          Effect.sync(() => {
            calls.push(method);
          }).pipe(Effect.andThen(Effect.die(`unexpected WorkOSClient.${method} call`)));
      },
    }),
  );

const apps: { dispose: () => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.dispose()));
});

const send = async (organizationId: string, method: string, path: string, body?: unknown) => {
  const calls: string[] = [];
  const rsLive = Layer.mergeAll(makeDbLayer(), stubUsers, stubDirectory, stubMirror);
  const app = HttpRouter.toWebHandler(
    makeAccountApiLive(rsLive).pipe(
      Layer.provide(stubWorkOS(calls)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  apps.push(app);
  const response = await app.handler(
    new Request(`https://executor.test${path}`, {
      method,
      headers: {
        cookie: `wos-session=sealed; ${await verifiedSettingsCookie(CALLER)}`,
        [ORG_SELECTOR_HEADER]: organizationId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    undefined as never,
  );
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: (await response.json()) as unknown,
    calls,
  };
};

const seedOrg = (state?: "moving" | "moved" | "rolled_back") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const id = `org_${crypto.randomUUID().replaceAll("-", "")}`;
      yield* Effect.promise(() =>
        db.insert(organizations).values({ id, name: "Synthetic Org", slug: id.slice(4, 20) }),
      );
      if (state) yield* Effect.promise(() => db.insert(orgMovedToV2).values({ orgId: id, state }));
      return id;
    }).pipe(Effect.provide(makeDbLayer())),
  );

describe("account plane freeze", () => {
  it("refuses member, key and settings changes while the organization moves", async () => {
    const org = await seedOrg("moving");
    for (const [method, path, body] of [
      ["POST", "/account/members/invite", { email: "new@placeholder.test" }],
      ["PATCH", "/account/members/om_1/role", { roleSlug: "member" }],
      ["DELETE", "/account/members/om_1", undefined],
      ["POST", "/account/api-keys", { name: "ci" }],
      ["DELETE", "/account/api-keys/key_1", undefined],
      ["POST", "/account/org-api-keys", { name: "ci" }],
      ["PATCH", "/account/name", { name: "Renamed" }],
    ] as const) {
      const response = await send(org, method, path, body);
      expect(response).toEqual({
        status: 423,
        retryAfter: "60",
        body: { error: ORG_MOVING_MESSAGE, code: ORG_MOVING_CODE },
        calls: [],
      });
    }
  });

  it("refuses them for good once the organization has moved", async () => {
    const org = await seedOrg("moved");
    const response = await send(org, "PATCH", "/account/name", { name: "Renamed" });
    expect(response).toEqual({
      status: 423,
      retryAfter: null,
      body: { error: ORG_MOVED_MESSAGE, code: ORG_MOVED_CODE },
      calls: [],
    });
  });

  it("serves the change when the organization is not moving, or was given back", async () => {
    for (const org of [await seedOrg(), await seedOrg("rolled_back")]) {
      const response = await send(org, "PATCH", "/account/name", { name: "Renamed" });
      expect(response).toEqual({
        status: 200,
        retryAfter: null,
        body: { name: "Renamed" },
        calls: ["updateOrganization"],
      });
    }
  });
});
