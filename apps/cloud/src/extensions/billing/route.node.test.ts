import { afterAll, describe, expect, it } from "@effect/vitest";
import { routeConfigs } from "autumn-js/backend";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { MemberDirectory, requestScopedMiddleware } from "@executor-js/api/server";

import { UserStoreService } from "../../auth/context";
import { WorkOSClient, type WorkOSClientService } from "../../auth/workos";
import { WorkOsMirror, type WorkOsMirrorShape } from "../../auth/workos-mirror";
import { DbService, makeDbLayer } from "../../db/db";
import { organizations, orgMovedToV2 } from "../../db/schema";
import { ORG_MOVING_CODE, ORG_MOVING_MESSAGE } from "../../org/move-to-v2";
import {
  AutumnRoutesLive,
  BILLING_READ_PATHS,
  CHECKOUT_TAX_ID_PARAMS,
  resolveBillingOrganization,
  withCheckoutTaxIdCollection,
} from "./route";

const createdAt = new Date("2026-01-01T00:00:00.000Z");

// The mirror's account row as `ensureAccount` mints it: id only, profile
// columns unfilled until a WorkOS user payload arrives.
const bareAccount = (id: string) => ({
  id,
  email: null,
  firstName: null,
  lastName: null,
  avatarUrl: null,
  workosUpdatedAt: null,
  lastSignInAt: null,
  createdAt,
});

const MEMBER = "user_session";
const SESSION_ORG = "org_session";
const URL_ORG = "org_url";
const URL_SLUG = "acme";

const stubWorkOS = Layer.succeed(
  WorkOSClient,
  new Proxy({} as WorkOSClientService, {
    get: (_target, prop) => {
      // Membership is read from the mirror, never from WorkOS.
      return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
    },
  }),
);

// MEMBER is active in both orgs, as the mirror reports it.
const stubDirectory = Layer.succeed(MemberDirectory)({
  membership: (accountId, organizationId) =>
    Effect.succeed(
      accountId === MEMBER && (organizationId === SESSION_ORG || organizationId === URL_ORG)
        ? {
            accountId,
            membershipId: `om_${accountId}_${organizationId}`,
            organizationId,
            email: null,
            name: null,
            avatarUrl: null,
            role: "member",
            status: "active" as const,
            lastActiveAt: null,
          }
        : null,
    ),
  membershipById: () => Effect.die("billing auth does not look up by membership id"),
  membershipsOf: () => Effect.die("billing auth reads one membership, not the list"),
  members: () => Effect.die("billing auth does not list members"),
  membersById: () => Effect.die("billing auth does not batch members"),
  findByEmail: () => Effect.die("billing auth does not resolve emails"),
});

const stubUsers = Layer.succeed(UserStoreService)({
  use: (_op, fn) =>
    Effect.promise(() =>
      fn({
        ensureAccount: async (id: string) => bareAccount(id),
        getAccount: async (id: string) => bareAccount(id),
        upsertOrganization: async (org: { id: string; name: string }) => ({
          ...org,
          slug: org.id,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        getOrganization: async (id: string) => ({
          id,
          name: `Org ${id}`,
          slug: id,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        getOrganizationBySlug: async (slug: string) => ({
          id: slug === URL_SLUG ? URL_ORG : "org_outsider",
          name: `Org ${slug}`,
          slug,
          backfilledAt: createdAt,
          deletedAt: null,
          workosUpdatedAt: null,
          createdAt,
        }),
        markOrganizationDeleted: async () => null,
        deleteOrganizationCascade: async () => {},
      }),
    ),
});

// Authorization scans an organization the backfill never covered before it
// reads the mirror (`auth/organization.ts`); every org row above is marked
// backfilled, so the scan is never reached and the mirror is never written.
const stubMirror = Layer.succeed(
  WorkOsMirror,
  new Proxy({} as WorkOsMirrorShape, {
    get: (_target, prop) => () => Effect.die(`unexpected WorkOsMirror.${String(prop)} call`),
  }),
);

const run = (headers: Record<string, string>) =>
  resolveBillingOrganization(
    new Request("https://executor.test/api/billing/customer", { headers }),
    { userId: MEMBER },
  ).pipe(Effect.provide(Layer.mergeAll(stubWorkOS, stubUsers, stubDirectory, stubMirror)));

describe("billing route org selector", () => {
  it.effect("fails closed when no selector header is sent", () =>
    Effect.gen(function* () {
      // No fallback to the session org: the cookie's org is browser-global
      // and can name a different org than the tab's URL for a multi-org user.
      const error = yield* Effect.flip(run({}));
      expect(error).toMatchObject({ _tag: "HttpResponseError", status: 401 });
    }),
  );

  it.effect("scopes billing to the URL org selector", () =>
    Effect.gen(function* () {
      const org = yield* run({ "x-executor-organization": URL_SLUG });
      expect(org.id).toBe(URL_ORG);
    }),
  );

  it.effect("rejects a selector for an org the caller is not a member of", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run({ "x-executor-organization": "outsider-slug" }));
      expect(error).toMatchObject({ _tag: "HttpResponseError", status: 403 });
    }),
  );
});

describe("billing checkout tax ID collection", () => {
  it("asks Stripe Checkout to collect a tax ID on attach", () => {
    const body = withCheckoutTaxIdCollection("/api/billing/attach", {
      planId: "team",
      checkoutSessionParams: { locale: "auto", tax_id_collection: { enabled: false } },
    });
    expect(body).toEqual({
      planId: "team",
      checkoutSessionParams: { locale: "auto", ...CHECKOUT_TAX_ID_PARAMS },
    });
  });

  it("leaves other billing routes unchanged", () => {
    const body = { planId: "team" };
    expect(withCheckoutTaxIdCollection("/api/billing/previewAttach", body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Billing's freeze (see `../../org/move-to-v2`): while an organization moves
// to v2, only the reads the billing pages make reach Autumn.
// ---------------------------------------------------------------------------

describe("billing freeze", () => {
  it("serves only Autumn's read routes while an organization moves", () => {
    const routes = routeConfigs.map((config) => `/api/billing/${config.route}`);
    for (const path of BILLING_READ_PATHS) expect(routes).toContain(path);
    // A route Autumn adds later is refused until it is listed as a read.
    expect(
      routes
        .filter((path) => !BILLING_READ_PATHS.has(path))
        .map((path) => path.slice("/api/billing/".length))
        .sort(),
    ).toEqual([
      "attach",
      "createReferralCode",
      "multiAttach",
      "openCustomerPortal",
      "redeemReferralCode",
      "setupPayment",
      "updateSubscription",
    ]);
  });

  // MEMBER belongs to every organization, as the mirror reports it.
  const anyOrgDirectory = Layer.succeed(MemberDirectory)({
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

  const sessionWorkOS = Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) =>
        prop === "authenticateRequest"
          ? () => Effect.succeed({ userId: MEMBER, email: "member@placeholder.test" })
          : () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`),
    }),
  );

  const apps: { dispose: () => Promise<void> }[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.dispose()));
  });

  const post = async (organizationId: string, route: string) => {
    const rsLive = Layer.mergeAll(makeDbLayer(), stubUsers, anyOrgDirectory, stubMirror);
    const app = HttpRouter.toWebHandler(
      AutumnRoutesLive.pipe(
        Layer.provide(requestScopedMiddleware(rsLive).layer),
        // The route reads WorkOS from the app's boot context, as in production.
        Layer.provideMerge(sessionWorkOS),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );
    apps.push(app);
    const response = await app.handler(
      new Request(`https://executor.test/api/billing/${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-executor-organization": organizationId,
        },
        body: JSON.stringify({ planId: "team" }),
      }),
      undefined as never,
    );
    return { status: response.status, body: (await response.json()) as { code?: string } };
  };

  const seedMovingOrg = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        const id = `org_${crypto.randomUUID().replaceAll("-", "")}`;
        yield* Effect.promise(() =>
          db.insert(organizations).values({ id, name: "Synthetic Org", slug: id.slice(4, 20) }),
        );
        yield* Effect.promise(() => db.insert(orgMovedToV2).values({ orgId: id, state: "moving" }));
        return id;
      }).pipe(Effect.provide(makeDbLayer())),
    );

  it("refuses a plan change for a moving organization before calling Autumn", async () => {
    const org = await seedMovingOrg();
    for (const route of ["attach", "updateSubscription", "openCustomerPortal"]) {
      expect(await post(org, route)).toEqual({
        status: 423,
        body: { error: ORG_MOVING_MESSAGE, code: ORG_MOVING_CODE },
      });
    }
  });

  it("still hands a moving organization's billing reads to Autumn", async () => {
    const org = await seedMovingOrg();
    // No Autumn key is configured here, so Autumn's own handler refuses the
    // request: proof it got past the freeze.
    expect(await post(org, "getOrCreateCustomer")).toMatchObject({
      body: { code: "billing_request_failed" },
    });
  });
});
