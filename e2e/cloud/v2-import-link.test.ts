// Cloud-only: the sidebar's "Move to Executor v2" link to v2's workspace
// import. v2 imports an organization only for a verified user who is its one
// active member and only when it is not on a paid plan, so v1 shows the link to
// exactly those users. Each scenario reads the real `/api/auth/v2-import`
// answer the dashboard renders from, and the browser checks the sidebar itself.
//
// An unverified email is covered by `apps/cloud/src/auth/v2-import.test.ts`:
// the WorkOS emulator signs every user in with a verified email.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Autumn, Billing, Browser, Target } from "../src/services";
import { settle, visit } from "../src/surfaces/browser";
import type { Identity, Target as TargetShape } from "../src/target";
import { activeOrg, forBrowser, joinOrg } from "./support/session";

const LINK_NAME = "Move to Executor v2";
const V2_IMPORT_API = "/api/auth/v2-import";

/** The link the dashboard would render for this identity's org, or null. */
const v2ImportUrlOf = (target: TargetShape, identity: Identity): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    const response = await fetch(new URL(V2_IMPORT_API, target.baseUrl), {
      headers: identity.headers,
    });
    if (!response.ok) throw new Error(`${V2_IMPORT_API} failed (${response.status})`);
    return ((await response.json()) as { url: string | null }).url;
  });

scenario(
  "v2 import · the only member of a free org sees the link to v2's import",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    const url = yield* v2ImportUrlOf(target, identity);
    expect(url, "a sole member of a free org is offered the import").not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.pathname, "the link opens v2's import page").toBe("/v1-import");
    expect(parsed.origin, "the import page is on v2's host, not v1's").not.toBe(
      new URL(target.baseUrl).origin,
    );

    const { slug } = yield* activeOrg(target, identity);
    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the dashboard", async () => {
        await visit(page, `/${slug}`);
      });
      await step(`See "${LINK_NAME}" in the sidebar`, async () => {
        const link = page.getByRole("link", { name: LINK_NAME });
        await link.waitFor();
        expect(await link.getAttribute("href"), "the sidebar links to v2's import").toBe(url);
        expect(await link.getAttribute("target"), "it opens in a new tab").toBe("_blank");
      });
    });
  }),
);

scenario(
  "v2 import · billing is read without creating a customer, and no customer is free",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const identity = yield* target.newIdentity();
    const { id } = yield* activeOrg(target, identity);
    const lookups = autumn
      .ledgerFor("customers.get")
      .pipe(Effect.map((entries) => entries.filter((entry) => entry.customerId === id)));

    // The org's customer exists, so the read-only lookup answers it: free.
    expect(
      yield* v2ImportUrlOf(target, identity),
      "a free customer is offered the import",
    ).not.toBeNull();
    const answered = yield* lookups;
    expect(answered.length, "the billing read is Autumn's read-only customers.get").toBeGreaterThan(
      0,
    );
    expect(answered.every((entry) => !entry.faulted)).toBe(true);

    // Autumn answering that it has no such customer is an answer too: free.
    yield* Effect.gen(function* () {
      yield* autumn.armFault({
        match: { operationId: "customers.get" },
        response: {
          status: 404,
          body: { message: "Customer not found", code: "customer_not_found" },
        },
        times: 1,
      });
      expect(
        yield* v2ImportUrlOf(target, identity),
        "an org Autumn has no customer for is offered the import",
      ).not.toBeNull();
      expect(
        (yield* lookups).some((entry) => entry.faulted),
        "the lookup reached Autumn and was answered customer_not_found",
      ).toBe(true);
    }).pipe(Effect.ensuring(autumn.clearFaults().pipe(Effect.ignore)));
  }),
);

scenario(
  "v2 import · members of a shared org do not see the link",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const admin = yield* target.newIdentity();
    const invitee = yield* target.newIdentity({ org: false });
    const member = yield* joinOrg(target, admin, invitee);

    expect(
      yield* v2ImportUrlOf(target, admin),
      "the admin of a two-member org is not offered the import",
    ).toBeNull();
    expect(
      yield* v2ImportUrlOf(target, member),
      "a member of a two-member org is not offered the import",
    ).toBeNull();

    const { slug } = yield* activeOrg(target, admin);
    yield* browser.session(forBrowser(admin), async ({ page, step }) => {
      await step("Open the shared org's dashboard", async () => {
        const answered = page.waitForResponse((response) => response.url().endsWith(V2_IMPORT_API));
        await visit(page, `/${slug}`);
        await answered;
        await settle(page);
      });
      await step(`See no "${LINK_NAME}" in the sidebar`, async () => {
        await page.getByRole("button", { name: "Get support" }).waitFor();
        expect(await page.getByRole("link", { name: LINK_NAME }).count()).toBe(0);
      });
    });
  }),
);

scenario(
  "v2 import · the only member of a paid org does not see the link",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const identity = yield* target.newIdentity();
    const { id } = yield* activeOrg(target, identity);

    // Enterprise activates inline in the emulator (no checkout), like the
    // rate-limit scenario's paid org.
    yield* autumn.attachPlan(id, "enterprise");

    expect(
      yield* v2ImportUrlOf(target, identity),
      "a paid org is not offered the import",
    ).toBeNull();
  }),
);
