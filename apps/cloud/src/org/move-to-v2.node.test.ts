// ---------------------------------------------------------------------------
// The move-to-v2 freeze against the real PGlite Postgres every cloud unit test
// runs on (scripts/test-globalsetup.ts), which has every migration applied.
//
// What this pins:
//   - the state read: no row and `rolled_back` are writable, `moving` and
//     `moved` are frozen, and a failed read is an error (fail closed)
//   - the executor's gate (`cloudWorkspaceWriteGate`) on its own connection,
//     and a write through cloud's executor stack on this single-session
//     database: the gate is read before the write's transaction opens
//   - the protected plane's refusal in the identity provider, and how cloud's
//     failure strategy renders it
//   - the dashboard redirect decision for a moved organization
//   - migration 0022: the slug column, the three states, and the
//     `v1_import_writer` grants (upsert every state; no DELETE, no
//     `updated_at`, nothing else)
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import {
  IdentityProvider,
  MemberDirectory,
  PluginsProvider,
  Unavailable,
  makeScopedExecutor,
} from "@executor-js/api/server";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import { cloudIdentityFailureStrategy, workosIdentityLayer } from "../auth/workos-auth-provider";
import { WorkOsMirror, type WorkOsMirrorShape } from "../auth/workos-mirror";
import { DbService, makeDbLayer } from "../db/db";
import { CloudDbProvider, CloudHostConfig } from "../engine/execution-stack";
import { organizations, orgMovedToV2 } from "../db/schema";
import {
  ORG_MOVED_CODE,
  ORG_MOVED_MESSAGE,
  ORG_MOVE_STATE_UNAVAILABLE_CODE,
  ORG_MOVE_STATE_UNAVAILABLE_MESSAGE,
  ORG_MOVING_CODE,
  ORG_MOVING_MESSAGE,
  assertOrgWritable,
  cloudWorkspaceWriteGate,
  frozenWriteResponse,
  movedDashboardLocation,
  readOrgMoveState,
} from "./move-to-v2";

const run = <A, E>(effect: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeDbLayer())));

const fresh = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

/** A new organization, optionally with a move row in `state`. */
const seedOrg = (
  state?: string,
  v2: { readonly id: string | null; readonly slug: string | null } = { id: null, slug: null },
) =>
  run(
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const suffix = fresh();
      const id = `org_${suffix}`;
      const slug = `moving-${suffix}`;
      yield* Effect.promise(() =>
        db
          .insert(organizations)
          .values({ id, name: "Synthetic Org", slug, backfilledAt: new Date() }),
      );
      if (state !== undefined) {
        yield* Effect.promise(() =>
          db.insert(orgMovedToV2).values({ orgId: id, state, v2OrgId: v2.id, v2OrgSlug: v2.slug }),
        );
      }
      return { id, slug };
    }),
  );

class SimulatedOutage extends Error {}

/** A database whose every query rejects, the way an unreachable one does. */
const brokenDb = Layer.succeed(DbService)({
  db: new Proxy({} as DbService["Service"]["db"], {
    get: () => () => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: drizzle's query builder throws synchronously when the connection is gone
      throw new SimulatedOutage("database unavailable");
    },
  }),
});

describe("move state on write paths", () => {
  it("accepts writes with no row or a rolled-back move", async () => {
    const none = await seedOrg();
    const rolledBack = await seedOrg("rolled_back", { id: "v2-org", slug: "acme" });
    await run(assertOrgWritable(none.id));
    await run(assertOrgWritable(rolledBack.id));
    expect(await run(readOrgMoveState(rolledBack.id))).toBeNull();
  });

  it("refuses writes while moving and after moving", async () => {
    const moving = await seedOrg("moving");
    const moved = await seedOrg("moved", { id: "v2-org-moved", slug: "acme" });
    const movingError = await run(Effect.flip(assertOrgWritable(moving.id)));
    const movedError = await run(Effect.flip(assertOrgWritable(moved.id)));
    expect(movingError).toMatchObject({ _tag: "OrgFrozenError", state: "moving" });
    expect(movingError.message).toBe(ORG_MOVING_MESSAGE);
    expect(movedError).toMatchObject({ _tag: "OrgFrozenError", state: "moved" });
    expect(movedError.message).toBe(ORG_MOVED_MESSAGE);
    expect(await run(readOrgMoveState(moved.id))).toEqual({
      state: "moved",
      v2OrganizationId: "v2-org-moved",
      v2OrganizationSlug: "acme",
    });
  });

  it("fails closed when the state cannot be read", async () => {
    const error = await Effect.runPromise(
      Effect.flip(assertOrgWritable("org_unreadable")).pipe(Effect.provide(brokenDb)),
    );
    expect(error).toMatchObject({ _tag: "OrgMoveStateReadError" });
  });

  it("renders the refusal the account, domain and billing planes send", async () => {
    const moving = await seedOrg("moving");
    const open = await seedOrg();
    const refused = await run(frozenWriteResponse(moving.id));
    expect(refused?.status).toBe(423);
    expect(refused?.headers["retry-after"]).toBe("60");
    expect(await run(frozenWriteResponse(open.id))).toBeNull();
    const unreadable = await Effect.runPromise(
      frozenWriteResponse("org_unreadable").pipe(Effect.provide(brokenDb)),
    );
    expect(unreadable?.status).toBe(503);
  });
});

describe("the executor's workspace gate", () => {
  it("refuses a frozen organization with the message the tool call shows", async () => {
    const moving = await seedOrg("moving");
    const error = await Effect.runPromise(Effect.flip(cloudWorkspaceWriteGate(moving.id)));
    expect(error).toMatchObject({ _tag: "OrgWriteDeniedError", reason: ORG_MOVING_MESSAGE });
  });

  it("lets an organization that is not moving write", async () => {
    const open = await seedOrg();
    const rolledBack = await seedOrg("rolled_back");
    await Effect.runPromise(cloudWorkspaceWriteGate(open.id));
    await Effect.runPromise(cloudWorkspaceWriteGate(rolledBack.id));
  });

  it("follows the state as v2 changes it, with no cache", async () => {
    const org = await seedOrg("moving");
    await Effect.runPromise(Effect.flip(cloudWorkspaceWriteGate(org.id)));
    await run(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          db
            .update(orgMovedToV2)
            .set({ state: "rolled_back" })
            .where(eq(orgMovedToV2.orgId, org.id)),
        );
      }),
    );
    await Effect.runPromise(cloudWorkspaceWriteGate(org.id));
  });
});

// ---------------------------------------------------------------------------
// The gate inside cloud's own executor stack. The test database is the
// single-session PGlite the dev stack runs: a second connection is served only
// once the first one's open transaction commits, so a gate asked from inside a
// write transaction would wait on that transaction until its connect timeout
// and then refuse a writable organization.
// ---------------------------------------------------------------------------

const noPlugins = Layer.succeed(PluginsProvider)({ plugins: () => [] });

const createOrgPolicy = (organizationId: string) =>
  makeScopedExecutor("user_writer", organizationId, "Synthetic Org").pipe(
    Effect.flatMap((executor) =>
      executor.policies.create({ owner: "org", pattern: "*", action: "require_approval" }),
    ),
    Effect.provide(
      Layer.mergeAll(CloudDbProvider, noPlugins, CloudHostConfig).pipe(
        Layer.provide(makeDbLayer()),
      ),
    ),
    Effect.scoped,
  );

describe("a write through cloud's executor", () => {
  it("commits for an organization that is not moving", async () => {
    const open = await seedOrg();
    const policy = await Effect.runPromise(createOrgPolicy(open.id));
    expect(policy).toMatchObject({ pattern: "*", action: "require_approval" });
  });

  it("is refused for a moving organization with the move's message", async () => {
    const moving = await seedOrg("moving");
    const error = await Effect.runPromise(Effect.flip(createOrgPolicy(moving.id)));
    expect(error).toMatchObject({ _tag: "OrgWriteDeniedError", reason: ORG_MOVING_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// The protected plane: the identity provider every `/api/*` executor route
// authenticates through.
// ---------------------------------------------------------------------------

const MEMBER = "user_synthetic";

const stubApiKeys = (organizationId: string) =>
  Layer.succeed(ApiKeyService)({
    validate: (value: string) =>
      Effect.succeed(
        value === "user_key"
          ? { scope: "user" as const, accountId: MEMBER, organizationId, keyId: "key_1" }
          : value === "org_key"
            ? { scope: "org" as const, accountId: null, organizationId, keyId: "key_2" }
            : null,
      ),
    listUserKeys: () => Effect.die("not listed here"),
    createUserKey: () => Effect.die("not created here"),
    revokeUserKey: () => Effect.die("not revoked here"),
    listOrgKeys: () => Effect.die("not listed here"),
    createOrgKey: () => Effect.die("not created here"),
    revokeOrgKey: () => Effect.die("not revoked here"),
  });

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`),
  }),
);

const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(
      accountId === MEMBER
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

const authenticate = (organizationId: string, request: Request) => {
  const dbLive = makeDbLayer();
  const identity = workosIdentityLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        stubApiKeys(organizationId),
        stubWorkOS,
        stubDirectory,
        stubMirror,
        UserStoreService.Live.pipe(Layer.provide(dbLive)),
        dbLive,
      ),
    ),
  );
  return Effect.runPromise(
    IdentityProvider.asEffect().pipe(
      Effect.flatMap((provider) => provider.authenticate(request)),
      Effect.provide(identity),
      Effect.flip,
      Effect.option,
    ),
  );
};

const apiRequest = (method: string, path: string, key = "user_key") =>
  new Request(`https://executor.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${key}` },
  });

describe("the protected plane's freeze", () => {
  it("refuses a member's write to a moving organization", async () => {
    const moving = await seedOrg("moving");
    for (const [method, path] of [
      ["POST", "/connections"],
      ["PATCH", "/integrations/github"],
      ["DELETE", "/artifacts/art_1"],
      ["POST", "/oauth/start"],
    ] as const) {
      const refused = await authenticate(moving.id, apiRequest(method, path));
      expect(Option.isSome(refused)).toBe(true);
      expect(refused).toMatchObject({
        value: { _tag: "Unavailable", code: ORG_MOVING_CODE, message: ORG_MOVING_MESSAGE },
      });
    }
  });

  it("refuses a write to a moved organization as moved", async () => {
    const moved = await seedOrg("moved", { id: "v2-org", slug: "acme" });
    expect(await authenticate(moved.id, apiRequest("POST", "/policies"))).toMatchObject({
      value: { code: ORG_MOVED_CODE, message: ORG_MOVED_MESSAGE },
    });
  });

  it("serves reads, executions and the OAuth callback page while moving", async () => {
    const moving = await seedOrg("moving");
    for (const [method, path] of [
      ["GET", "/connections"],
      ["POST", "/executions"],
      ["POST", "/executions/exec_1/resume"],
      ["GET", "/oauth/callback"],
    ] as const) {
      expect(Option.isNone(await authenticate(moving.id, apiRequest(method, path)))).toBe(true);
    }
  });

  it("serves writes to an organization that is not moving, or was given back", async () => {
    const open = await seedOrg();
    const rolledBack = await seedOrg("rolled_back");
    for (const org of [open, rolledBack]) {
      expect(Option.isNone(await authenticate(org.id, apiRequest("POST", "/connections")))).toBe(
        true,
      );
    }
  });

  it("leaves an org API key's write to the read-only refusal", async () => {
    const moving = await seedOrg("moving");
    expect(
      Option.isNone(await authenticate(moving.id, apiRequest("POST", "/connections", "org_key"))),
    ).toBe(true);
  });

  it("renders the refusal with the freeze status, and other outages as before", async () => {
    const asResponse = async (failure: Unavailable) => {
      const result = await Effect.runPromise(
        cloudIdentityFailureStrategy
          .renderFailure(Effect.fail(failure))
          .pipe(
            Effect.map((value) => (HttpServerResponse.isHttpServerResponse(value) ? value : null)),
          ),
      );
      if (result === null) return null;
      return {
        status: result.status,
        retryAfter: result.headers["retry-after"],
        body: await HttpServerResponse.toWeb(result).json(),
      };
    };
    expect(await asResponse(new Unavailable({}))).toMatchObject({
      status: 503,
      retryAfter: undefined,
      body: { code: "service_unavailable" },
    });
    expect(
      await asResponse(new Unavailable({ code: ORG_MOVING_CODE, message: ORG_MOVING_MESSAGE })),
    ).toEqual({
      status: 423,
      retryAfter: "60",
      body: { error: ORG_MOVING_MESSAGE, code: ORG_MOVING_CODE },
    });
    expect(
      await asResponse(
        new Unavailable({
          code: ORG_MOVE_STATE_UNAVAILABLE_CODE,
          message: ORG_MOVE_STATE_UNAVAILABLE_MESSAGE,
        }),
      ),
    ).toMatchObject({ status: 503, retryAfter: "2" });
    expect(
      await asResponse(
        new Unavailable({ code: "api_key_validation_unavailable", message: "unavailable" }),
      ),
    ).toEqual({
      status: 503,
      retryAfter: undefined,
      body: { error: "unavailable", code: "api_key_validation_unavailable" },
    });
  });
});

// ---------------------------------------------------------------------------
// The dashboard redirect decision (`auth/doc-gate.ts` runs it per page load).
// ---------------------------------------------------------------------------

describe("moved dashboard location", () => {
  const v2Origin = new URL("https://app.example.test");
  const member = () => Effect.succeed(true);
  const stranger = () => Effect.succeed(false);
  const locate = (
    target: { readonly slug: string } | { readonly organizationId: string },
    isMember: (organizationId: string) => Effect.Effect<boolean> = member,
  ) => run(movedDashboardLocation({ target, v2Origin, isMember }));

  it("sends a member of a moved organization to its v2 page, by URL slug or session org", async () => {
    const moved = await seedOrg("moved", { id: "v2-org", slug: "acme-team" });
    expect(await locate({ slug: moved.slug })).toBe("https://app.example.test/org/acme-team");
    expect(await locate({ organizationId: moved.id })).toBe(
      "https://app.example.test/org/acme-team",
    );
  });

  it("sends a moved organization without a v2 slug to v2's root", async () => {
    const moved = await seedOrg("moved", { id: "v2-org", slug: null });
    expect(await locate({ slug: moved.slug })).toBe("https://app.example.test/");
  });

  it("serves the v1 dashboard to everyone else", async () => {
    const moved = await seedOrg("moved", { id: "v2-org", slug: "acme-team" });
    const moving = await seedOrg("moving");
    const rolledBack = await seedOrg("rolled_back", { id: "v2-org", slug: "acme-team" });
    const open = await seedOrg();
    expect(await locate({ slug: moved.slug }, stranger)).toBeNull();
    expect(await locate({ slug: moving.slug })).toBeNull();
    expect(await locate({ slug: rolledBack.slug })).toBeNull();
    expect(await locate({ slug: open.slug })).toBeNull();
    expect(await locate({ slug: "no-such-org" })).toBeNull();
    expect(await locate({ organizationId: open.id })).toBeNull();
  });

  it("checks membership only for a moved organization", async () => {
    const moving = await seedOrg("moving");
    let checked = 0;
    const counting = () =>
      Effect.sync(() => {
        checked += 1;
        return true;
      });
    await locate({ slug: moving.slug }, counting);
    expect(checked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The session handoff the redirect carries when V2_SESSION_HANDOFF_SECRET is set.
// ---------------------------------------------------------------------------

const decodeClaims = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

describe("moved dashboard session handoff", () => {
  const v2Origin = new URL("https://app.example.test");
  const secret = "synthetic-handoff-secret-0123456789abcdef";
  const handoff = { secret, user: "user_synthetic_member" };
  const member = () => Effect.succeed(true);
  const stranger = () => Effect.succeed(false);
  const locate = (
    target: { readonly slug: string } | { readonly organizationId: string },
    options: {
      readonly isMember?: (organizationId: string) => Effect.Effect<boolean>;
      readonly handoff?: typeof handoff;
    } = { handoff },
  ) =>
    run(
      movedDashboardLocation({
        target,
        v2Origin,
        isMember: options.isMember ?? member,
        handoff: options.handoff,
      }),
    );

  /** The claims of a handoff URL's token, once its signature checks out with `secret`. */
  const verifiedClaims = (location: string | null) => {
    expect(location).not.toBeNull();
    const url = new URL(location ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://app.example.test/api/v1-handoff");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
    const [prefix, payload, signature, ...rest] = (url.searchParams.get("token") ?? "").split(".");
    expect(prefix).toBe("v1hnd");
    expect(rest).toEqual([]);
    const expected = createHmac("sha256", secret).update(`v1hnd.${payload}`).digest("base64url");
    expect(signature).toBe(expected);
    return decodeClaims(Buffer.from(payload ?? "", "base64url").toString("utf8"));
  };

  it("sends a member of a moved organization to v2's handoff with a signed, minute-long token", async () => {
    const moved = await seedOrg("moved", { id: "v2-org", slug: "acme-team" });
    const before = Math.floor(Date.now() / 1000);
    const bySlug = verifiedClaims(await locate({ slug: moved.slug }));
    const bySession = verifiedClaims(await locate({ organizationId: moved.id }));
    expect(bySlug).toMatchObject({
      v: 1,
      aud: "v2-session-handoff",
      user: "user_synthetic_member",
      organization: moved.id,
      slug: "acme-team",
    });
    expect(Object.keys(bySlug).sort()).toEqual(
      ["aud", "exp", "iat", "jti", "organization", "slug", "user", "v"].sort(),
    );
    expect(bySlug.iat).toBeGreaterThanOrEqual(before);
    expect(bySlug.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(Number(bySlug.exp) - Number(bySlug.iat)).toBe(60);
    expect(typeof bySlug.jti === "string" && bySlug.jti.length >= 16).toBe(true);
    // Every redirect carries its own token.
    expect(bySession).toMatchObject({ organization: moved.id, slug: "acme-team" });
    expect(bySession.jti).not.toBe(bySlug.jti);
  });

  it("gives no token to anyone who is not a member, or for an organization that has not moved", async () => {
    const moved = await seedOrg("moved", { id: "v2-org", slug: "acme-team" });
    const moving = await seedOrg("moving");
    expect(await locate({ slug: moved.slug }, { isMember: stranger, handoff })).toBeNull();
    expect(await locate({ organizationId: moved.id }, { isMember: stranger, handoff })).toBeNull();
    expect(await locate({ slug: moving.slug })).toBeNull();
  });

  it("keeps the plain redirect without the secret, or without a v2 slug to open", async () => {
    const moved = await seedOrg("moved", { id: "v2-org", slug: "acme-team" });
    const slugless = await seedOrg("moved", { id: "v2-org", slug: null });
    expect(await locate({ slug: moved.slug }, {})).toBe("https://app.example.test/org/acme-team");
    expect(await locate({ slug: slugless.slug })).toBe("https://app.example.test/");
  });
});

// ---------------------------------------------------------------------------
// Migration 0022 and the role v2 writes the table with.
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync(
  new URL("../../drizzle/0022_org_moved_to_v2_slug.sql", import.meta.url),
  "utf8",
);
const GRANT_BLOCK = MIGRATION.slice(MIGRATION.indexOf("DO $$"), MIGRATION.indexOf("END $$;") + 7);

/** Run `statement` as `v1_import_writer`, in a transaction of its own. */
const asWriter = (statement: string) =>
  run(
    Effect.gen(function* () {
      const { sql } = yield* DbService;
      if (sql === undefined) return yield* Effect.die("the test database exposes no sql handle");
      return yield* Effect.tryPromise({
        try: () =>
          sql.begin(async (tx) => {
            await tx.unsafe("set local role v1_import_writer");
            return [...(await tx.unsafe(statement))];
          }),
        catch: (cause) => cause,
      });
    }),
  );

const upsert = (organizationId: string, state: string, v2OrgId: string, v2OrgSlug: string) =>
  `insert into org_moved_to_v2 (org_id, state, v2_org_id, v2_org_slug)
   values ('${organizationId}', '${state}', '${v2OrgId}', '${v2OrgSlug}')
   on conflict (org_id) do update set state = excluded.state,
     v2_org_id = excluded.v2_org_id, v2_org_slug = excluded.v2_org_slug`;

describe("migration 0022", () => {
  it("accepts exactly the three states", async () => {
    for (const state of ["moving", "moved", "rolled_back"]) {
      await seedOrg(state, { id: "v2-org", slug: "acme" });
    }
    await expect(seedOrg("failed")).rejects.toThrow();
    await expect(seedOrg("paused")).rejects.toThrow();
  });

  it("documents the grants it runs, for a role created after it", () => {
    expect(MIGRATION).toContain(
      "--   GRANT INSERT, UPDATE ON org_moved_to_v2 TO v1_import_writer;",
    );
    expect(MIGRATION).toContain(
      "--   GRANT SELECT (org_id, state, v2_org_id, v2_org_slug) ON org_moved_to_v2 TO v1_import_writer;",
    );
    expect(GRANT_BLOCK).toContain("GRANT INSERT, UPDATE ON org_moved_to_v2 TO v1_import_writer;");
    expect(GRANT_BLOCK).toContain(
      "GRANT SELECT (org_id, state, v2_org_id, v2_org_slug) ON org_moved_to_v2 TO v1_import_writer;",
    );
  });

  it("lets v1_import_writer upsert every state, and nothing more", async () => {
    // The test database ran the migration before the role existed, as a
    // deployment that creates the role later would; the migration's own
    // grant block, run once the role exists, grants it.
    await run(
      Effect.gen(function* () {
        const { sql } = yield* DbService;
        if (sql === undefined) return yield* Effect.die("the test database exposes no sql handle");
        yield* Effect.promise(() =>
          sql.unsafe(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v1_import_writer') THEN
              CREATE ROLE v1_import_writer;
            END IF;
          END $$`),
        );
        yield* Effect.promise(() => sql.unsafe(GRANT_BLOCK));
      }),
    );

    const org = await seedOrg();
    await asWriter(upsert(org.id, "moving", "v2-org", "acme"));
    expect(await run(readOrgMoveState(org.id))).toEqual({ state: "moving" });
    await asWriter(upsert(org.id, "moved", "v2-org", "acme"));
    expect(await run(readOrgMoveState(org.id))).toEqual({
      state: "moved",
      v2OrganizationId: "v2-org",
      v2OrganizationSlug: "acme",
    });
    await asWriter(upsert(org.id, "rolled_back", "v2-org", "acme"));
    expect(await run(readOrgMoveState(org.id))).toBeNull();

    await expect(asWriter(upsert(org.id, "paused", "v2-org", "acme"))).rejects.toMatchObject({
      message: expect.stringContaining("check constraint"),
    });
    for (const refused of [
      "select updated_at from org_moved_to_v2",
      "select * from org_moved_to_v2",
      `delete from org_moved_to_v2 where org_id = '${org.id}'`,
      "select id from organizations",
      "insert into organizations (id, name, slug) values ('org_x', 'x', 'x')",
    ]) {
      await expect(asWriter(refused)).rejects.toMatchObject({
        message: expect.stringContaining("permission denied"),
      });
    }
    expect(
      await asWriter("select org_id, state, v2_org_id, v2_org_slug from org_moved_to_v2"),
    ).not.toHaveLength(0);
  });
});
