import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AutumnService } from "../extensions/billing/service";
import {
  isPaidForV2Import,
  liveV2ImportSource,
  v2ImportEligible,
  v2ImportUrl,
  type V2ImportSource,
  type V2ImportSubscription,
} from "./v2-import";
import { WorkOSClient, type WorkOSClientService } from "./workos";

const USER = "user_signed_in";
const OTHER = "user_other";
const ORG = "org_example";

interface Facts {
  readonly emailVerified?: boolean;
  readonly members?: ReadonlyArray<string>;
  readonly subscriptions?: ReadonlyArray<V2ImportSubscription>;
  readonly failing?: "user" | "members" | "billing";
}

/** A source answering from fixed facts, recording which reads were made. */
const sourceOf = (facts: Facts) => {
  const reads: string[] = [];
  const answer = <A>(read: string, value: A) =>
    Effect.suspend(() => {
      reads.push(read);
      return facts.failing === read ? Effect.fail("unavailable") : Effect.succeed(value);
    });
  const source: V2ImportSource = {
    emailVerified: (userId) => {
      expect(userId).toBe(USER);
      return answer("user", facts.emailVerified ?? true);
    },
    activeMemberIds: (organizationId) => {
      expect(organizationId).toBe(ORG);
      return answer("members", facts.members ?? [USER]);
    },
    subscriptions: (organizationId) => {
      expect(organizationId).toBe(ORG);
      return answer("billing", facts.subscriptions ?? [{ planId: "free", status: "active" }]);
    },
  };
  return { source, reads };
};

describe("v2 import eligibility", () => {
  it.effect("admits a verified user who is the free org's only active member", () =>
    Effect.gen(function* () {
      const { source, reads } = sourceOf({});
      expect(yield* v2ImportEligible(source, USER, ORG)).toBe(true);
      expect(reads).toEqual(["user", "members", "billing"]);
    }),
  );

  it.effect("admits an org on the free pay-as-you-go plan or with no subscription", () =>
    Effect.gen(function* () {
      for (const subscriptions of [[{ planId: "free-pay-as-you-go", status: "active" }], []]) {
        const { source } = sourceOf({ subscriptions });
        expect(yield* v2ImportEligible(source, USER, ORG)).toBe(true);
      }
    }),
  );

  it.effect("refuses an unverified email without reading the org", () =>
    Effect.gen(function* () {
      const { source, reads } = sourceOf({ emailVerified: false });
      expect(yield* v2ImportEligible(source, USER, ORG)).toBe(false);
      expect(reads).toEqual(["user"]);
    }),
  );

  it.effect("refuses an org with more than one active member, without reading billing", () =>
    Effect.gen(function* () {
      const { source, reads } = sourceOf({ members: [USER, OTHER] });
      expect(yield* v2ImportEligible(source, USER, ORG)).toBe(false);
      expect(reads).toEqual(["user", "members"]);
    }),
  );

  it.effect("refuses an org whose only active member is someone else", () =>
    Effect.gen(function* () {
      for (const members of [[OTHER], []]) {
        const { source } = sourceOf({ members });
        expect(yield* v2ImportEligible(source, USER, ORG)).toBe(false);
      }
    }),
  );

  it.effect("refuses an org on a paid plan", () =>
    Effect.gen(function* () {
      const { source } = sourceOf({ subscriptions: [{ planId: "team", status: "active" }] });
      expect(yield* v2ImportEligible(source, USER, ORG)).toBe(false);
    }),
  );

  it.effect("refuses when any read is unavailable", () =>
    Effect.gen(function* () {
      for (const failing of ["user", "members", "billing"] as const) {
        const { source } = sourceOf({ failing });
        expect(yield* v2ImportEligible(source, USER, ORG), failing).toBe(false);
      }
    }),
  );
});

describe("v2 import billing read", () => {
  const AUTUMN_URL = "https://autumn.example.test";
  interface AutumnRequest {
    readonly url: string;
    readonly method: string;
    readonly body: string;
  }

  let requests: AutumnRequest[] = [];
  const originalFetch = globalThis.fetch;
  const { AUTUMN_SECRET_KEY, AUTUMN_API_URL } = env;

  /** Autumn answering every request with `answer`, recording each request. */
  const autumnAnswers = (answer: () => Response | Promise<Response>) => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body),
      });
      return answer();
    }) as typeof fetch;
  };
  const customer = (subscriptions: ReadonlyArray<{ plan_id: string; status: string }>) =>
    Response.json({ id: ORG, name: null, balances: {}, subscriptions, purchases: [] });

  beforeEach(() => {
    requests = [];
    env.AUTUMN_SECRET_KEY = "am_sk_test";
    env.AUTUMN_API_URL = AUTUMN_URL;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    env.AUTUMN_SECRET_KEY = AUTUMN_SECRET_KEY;
    env.AUTUMN_API_URL = AUTUMN_API_URL;
  });

  // WorkOS is not read here: the user and member answers come from `sourceOf`.
  const unreadWorkOS = Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`),
    }),
  );

  /** The eligibility answer for a verified sole member, billing read from Autumn. */
  const eligibleWithLiveBilling = Effect.gen(function* () {
    const live = yield* liveV2ImportSource;
    const source = { ...sourceOf({}).source, subscriptions: live.subscriptions };
    return yield* v2ImportEligible(source, USER, ORG);
  }).pipe(Effect.provide(Layer.merge(AutumnService.Default, unreadWorkOS)));

  it.effect("looks the customer up read-only, so an org Autumn has never seen stays absent", () =>
    Effect.gen(function* () {
      autumnAnswers(() =>
        Response.json(
          { message: `Customer ${ORG} not found`, code: "customer_not_found" },
          { status: 404 },
        ),
      );
      expect(yield* eligibleWithLiveBilling, "no customer is free").toBe(true);
      expect(requests).toEqual([
        { url: `${AUTUMN_URL}/v1/customers.get`, method: "POST", body: `{"customer_id":"${ORG}"}` },
      ]);
    }),
  );

  it.effect("admits a customer on a free plan or with no subscription", () =>
    Effect.gen(function* () {
      for (const subscriptions of [
        [{ plan_id: "free", status: "active" }],
        [{ plan_id: "free-pay-as-you-go", status: "active" }],
        [],
      ]) {
        autumnAnswers(() => customer(subscriptions));
        expect(yield* eligibleWithLiveBilling, JSON.stringify(subscriptions)).toBe(true);
      }
    }),
  );

  it.effect("refuses a customer on a paid plan", () =>
    Effect.gen(function* () {
      autumnAnswers(() => customer([{ plan_id: "team", status: "active" }]));
      expect(yield* eligibleWithLiveBilling).toBe(false);
    }),
  );

  it.effect("admits a customer whose paid plan has expired", () =>
    Effect.gen(function* () {
      autumnAnswers(() =>
        customer([
          { plan_id: "free", status: "active" },
          { plan_id: "team", status: "expired" },
        ]),
      );
      expect(yield* eligibleWithLiveBilling).toBe(true);
    }),
  );

  it.effect("refuses when the lookup fails or answers something unexpected", () =>
    Effect.gen(function* () {
      const failures: ReadonlyArray<readonly [string, () => Response | Promise<Response>]> = [
        [
          "network error",
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: fetch rejects with a TypeError on a network failure; that rejection is the fixture
          () => Promise.reject(new TypeError("fetch failed")),
        ],
        ["server error", () => Response.json({ message: "boom" }, { status: 500 })],
        ["unauthorized", () => Response.json({ code: "invalid_secret_key" }, { status: 401 })],
        ["404 without customer_not_found", () => new Response("Not Found", { status: 404 })],
        ["body without subscriptions", () => Response.json({ id: ORG })],
        ["body that is not JSON", () => new Response("<html>", { status: 200 })],
      ];
      for (const [name, answer] of failures) {
        autumnAnswers(answer);
        expect(yield* eligibleWithLiveBilling, name).toBe(false);
      }
    }),
  );

  it.effect("refuses without an Autumn secret, without calling Autumn", () =>
    Effect.gen(function* () {
      delete env.AUTUMN_SECRET_KEY;
      autumnAnswers(() => customer([]));
      expect(yield* eligibleWithLiveBilling).toBe(false);
      expect(requests).toEqual([]);
    }),
  );
});

describe("v2 import paid plans", () => {
  it("counts every plan outside v2's free list that has not expired", () => {
    expect(isPaidForV2Import([{ planId: "team", status: "active" }])).toBe(true);
    expect(isPaidForV2Import([{ planId: "enterprise", status: "trialing" }])).toBe(true);
    expect(isPaidForV2Import([{ planId: "team", status: "past_due" }])).toBe(true);
    expect(isPaidForV2Import([{ planId: "team", status: "scheduled" }])).toBe(true);
    // A grandfathered or later plan v1 never listed is paid too.
    expect(isPaidForV2Import([{ planId: "professional", status: "active" }])).toBe(true);
    expect(
      isPaidForV2Import([
        { planId: "free", status: "active" },
        { planId: "team", status: "active" },
      ]),
    ).toBe(true);
  });

  it("does not count free plans or expired subscriptions", () => {
    expect(isPaidForV2Import([])).toBe(false);
    expect(isPaidForV2Import([{ planId: "free", status: "active" }])).toBe(false);
    expect(isPaidForV2Import([{ planId: "free-pay-as-you-go", status: "active" }])).toBe(false);
    expect(isPaidForV2Import([{ planId: "team", status: "expired" }])).toBe(false);
  });
});

describe("v2 import url", () => {
  const configured = {
    V2: { fetch: () => Promise.resolve(new Response(null)) },
    V2_SIGN_UP_URL: "https://app.example.test/login?mode=signup",
    V2_OAUTH_STATE_PREFIX: "x2.",
    V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
    V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
  };

  it("is the import page on v2's app host, the sign-up page's origin", () => {
    expect(v2ImportUrl(configured)?.href).toBe("https://app.example.test/v1-import");
  });

  it("is absent without the v2 settings or with broken ones", () => {
    expect(v2ImportUrl({})).toBeNull();
    expect(v2ImportUrl({ ...configured, V2_SIGN_UP_URL: "not a url" })).toBeNull();
    expect(v2ImportUrl({ ...configured, V2: undefined })).toBeNull();
  });
});
