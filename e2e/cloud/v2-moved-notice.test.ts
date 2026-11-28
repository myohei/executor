// Cloud-only: the notice for an organization Executor v2 has already
// imported. v2 records the move on the v1 WorkOS organization's metadata
// (`executor_v2_org_slug`, `executor_v2_moved_at`); each scenario writes those
// keys through the WorkOS emulator's real Update Organization route, reads the
// real `/api/auth/v2-import` answer, and checks the dashboard in the browser.
//
// The notice's analytics events are not asserted here: the e2e stack mounts no
// PostHog client, so `trackEvent` is a no-op. Their names and properties are
// fixed by the typed catalog in `packages/react/src/api/analytics.tsx`.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { revisit, settle, visit } from "../src/surfaces/browser";
import type { Identity, Target as TargetShape } from "../src/target";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";
import { verifyAdmin } from "./support/admin-mfa";
import { cookieOf } from "./support/session";

const V2_IMPORT_API = "/api/auth/v2-import";
const V2_SLUG = "moved-example";
// Noon UTC, so the badge reads the same calendar day in any browser timezone
// between UTC-11 and UTC+11.
const MOVED_AT = "2026-10-09T12:00:00.000Z";
const MOVED_BADGE = "Moved Oct 9, 2026";

interface V2ImportAnswer {
  readonly url: string | null;
  readonly moved: {
    readonly v2Url: string;
    readonly v2Slug: string;
    readonly movedAt: string;
  } | null;
}

const v2ImportOf = (target: TargetShape, identity: Identity): Effect.Effect<V2ImportAnswer> =>
  Effect.promise(async () => {
    const response = await fetch(new URL(V2_IMPORT_API, target.baseUrl), {
      headers: identity.headers,
    });
    if (!response.ok) throw new Error(`${V2_IMPORT_API} failed (${response.status})`);
    return (await response.json()) as V2ImportAnswer;
  });

/** The identity's active org, with the name the dashboard shows. */
const orgOf = (
  target: TargetShape,
  identity: Identity,
): Effect.Effect<{ readonly id: string; readonly slug: string; readonly name: string }> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/me", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/auth/me failed (${response.status})`);
    const body = (await response.json()) as {
      organization: { id: string; slug: string; name: string } | null;
    };
    if (!body.organization) throw new Error("identity has no active organization");
    return body.organization;
  });

/** Write WorkOS organization metadata the way v2 does: Update Organization. */
const setOrgMetadata = (
  organizationId: string,
  metadata: Record<string, string>,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const response = await fetch(
      `http://127.0.0.1:${WORKOS_EMULATOR_PORT}/organizations/${organizationId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer sk_test_emulate" },
        body: JSON.stringify({ metadata }),
      },
    );
    if (!response.ok) throw new Error(`WorkOS update organization failed (${response.status})`);
    await response.body?.cancel();
  });

const markMoved = (organizationId: string) =>
  setOrgMetadata(organizationId, {
    executor_v2_org_slug: V2_SLUG,
    executor_v2_moved_at: MOVED_AT,
  });

/** Rename the identity's active org through the product's own settings route. */
const renameOrg = (target: TargetShape, identity: Identity, name: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/account/name", target.baseUrl), {
      method: "PATCH",
      headers: {
        ...identity.headers,
        origin: new URL(target.baseUrl).origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error(`/api/account/name failed (${response.status})`);
    await response.body?.cancel();
  });

const noticeOf = (page: Page) => page.getByRole("dialog");

/** Open the dashboard and wait for the v2 answer it renders the notice from. */
const openDashboard = async (page: Page, slug: string) => {
  const answered = page.waitForResponse((response) => response.url().endsWith(V2_IMPORT_API));
  await visit(page, `/${slug}`);
  await answered;
  await settle(page);
};

scenario(
  "v2 moved · a moved org's dashboard says where it lives in v2, and ✕ hides it",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const org = yield* orgOf(target, identity);

    yield* markMoved(org.id);

    const answer = yield* v2ImportOf(target, identity);
    expect(answer.url, "a moved org is not offered the import again").toBeNull();
    expect(answer.moved, "the move v2 recorded is answered").not.toBeNull();
    const v2Url = new URL(answer.moved!.v2Url);
    expect(v2Url.pathname, "the link opens the org's page in v2").toBe(`/org/${V2_SLUG}`);
    expect(v2Url.origin, "the org's page is on v2's host, not v1's").not.toBe(
      new URL(target.baseUrl).origin,
    );
    expect(answer.moved!.movedAt).toBe(MOVED_AT);

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the moved org's dashboard", async () => {
        await openDashboard(page, org.slug);
      });

      await step("See the notice with the org's v1 and v2 homes", async () => {
        const notice = noticeOf(page);
        await notice.waitFor();
        await notice
          .getByRole("heading", { name: `${org.name} now lives in Executor v2`, exact: true })
          .waitFor();
        expect(await notice.getByText(MOVED_BADGE).count(), "the move date badge").toBe(1);
        const pair = await notice.getByTestId("v2-moved-pair").textContent();
        expect(pair).toContain(`v1 · ${org.name}`);
        expect(pair).toContain(`v2 · ${V2_SLUG}`);
        expect(await notice.getByText("Changes made here won't sync to v2.").count()).toBe(1);

        const open = notice.getByRole("link", { name: "Open in v2", exact: true });
        expect(await open.getAttribute("href"), "the button opens the org in v2").toBe(
          answer.moved!.v2Url,
        );
        expect(await open.getAttribute("target"), "it opens in a new tab").toBe("_blank");
        expect(await notice.getByRole("button", { name: "Keep using v1" }).count()).toBe(1);
      });

      await step("Close it with ✕", async () => {
        await noticeOf(page).getByRole("button", { name: "Close" }).click();
        await noticeOf(page).waitFor({ state: "hidden" });
      });

      await step(
        'See "Open in Executor v2" in the sidebar instead of the import link',
        async () => {
          const link = page.getByRole("link", { name: "Open in Executor v2" });
          expect(await link.getAttribute("href")).toBe(answer.moved!.v2Url);
          expect(await link.getAttribute("target")).toBe("_blank");
          expect(await page.getByRole("link", { name: "Move to Executor v2" }).count()).toBe(0);
        },
      );

      await step("Reload and see the notice stays hidden", async () => {
        const answered = page.waitForResponse((response) => response.url().endsWith(V2_IMPORT_API));
        await revisit(page);
        await answered;
        await settle(page);
        await page.getByRole("link", { name: "Open in Executor v2" }).waitFor();
        expect(await noticeOf(page).count(), "✕ snoozes the notice in this browser").toBe(0);
      });
    });
  }),
);

scenario(
  "v2 moved · keeping v1 asks why, and sending the answer hides the notice",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const org = yield* orgOf(target, identity);
    yield* markMoved(org.id);

    yield* browser.session(identity, async ({ page, step }) => {
      const notice = noticeOf(page);
      const send = notice.getByRole("button", { name: "Send and stay in v1" });
      const answerField = notice.getByRole("textbox");

      await step("Open the moved org's dashboard", async () => {
        await openDashboard(page, org.slug);
        await notice.waitFor();
      });

      await step('Click "Keep using v1" and see the feedback step', async () => {
        await notice.getByRole("button", { name: "Keep using v1" }).click();
        await notice.getByRole("heading", { name: "What went wrong?" }).waitFor();
        expect(
          await notice.getByText("Tell us why you're staying on v1, so we can fix it.").count(),
        ).toBe(1);
        expect(await notice.getByRole("radio").count(), "free text only, no options").toBe(0);
        expect(await send.isDisabled(), "nothing to send yet").toBe(true);
      });

      await step("Type only spaces and see Send stays disabled", async () => {
        await answerField.fill("   ");
        expect(await send.isDisabled(), "a blank answer is not an answer").toBe(true);
      });

      await step("Go back, then return to the feedback step", async () => {
        await notice.getByRole("button", { name: "Back" }).click();
        await notice.getByRole("button", { name: "Keep using v1" }).waitFor();
        await notice.getByRole("button", { name: "Keep using v1" }).click();
        await notice.getByRole("heading", { name: "What went wrong?" }).waitFor();
      });

      await step("Write why and send it", async () => {
        await answerField.fill("Synthetic feedback: a feature I use is not in v2 yet.");
        expect(await send.isDisabled(), "a written answer can be sent").toBe(false);
        await send.click();
        await notice.waitFor({ state: "hidden" });
      });

      await step("Reload and see the notice stays hidden", async () => {
        const answered = page.waitForResponse((response) => response.url().endsWith(V2_IMPORT_API));
        await revisit(page);
        await answered;
        await settle(page);
        await page.getByRole("link", { name: "Open in Executor v2" }).waitFor();
        expect(await noticeOf(page).count(), "sending the answer snoozes the notice").toBe(0);
      });
    });
  }),
);

scenario(
  "v2 moved · malformed move metadata shows no notice and keeps the import link",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const org = yield* orgOf(target, identity);

    yield* setOrgMetadata(org.id, {
      executor_v2_org_slug: "Not A Slug",
      executor_v2_moved_at: "yesterday",
    });

    const answer = yield* v2ImportOf(target, identity);
    expect(answer.moved, "malformed metadata is not a move").toBeNull();
    expect(answer.url, "the sole member of a free org is still offered the import").not.toBeNull();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the dashboard", async () => {
        await openDashboard(page, org.slug);
      });
      await step("See the import link and no notice", async () => {
        await page.getByRole("link", { name: "Move to Executor v2" }).waitFor();
        expect(await noticeOf(page).count()).toBe(0);
      });
    });
  }),
);

scenario(
  "v2 moved · a long organization name stays inside the notice",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const longName = "Synthetic Extraordinarily Long Organization Name For Layout Checks";
    // Renaming is an organization setting, which needs a verified admin session; the browser
    // below uses the plain session.
    yield* renameOrg(target, yield* verifyAdmin(target.baseUrl, identity), longName);
    const org = yield* orgOf(target, identity);
    expect(org.name, "the rename reached the dashboard's org").toBe(longName);
    yield* markMoved(org.id);

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the moved org's dashboard", async () => {
        await openDashboard(page, org.slug);
        await noticeOf(page)
          .getByRole("heading", { name: `${longName} now lives in Executor v2` })
          .waitFor();
      });

      await step("See the pair and both buttons inside the notice", async () => {
        const notice = noticeOf(page);
        const box = await notice.boundingBox();
        if (box === null) throw new Error("the notice has no layout box");
        const right = box.x + box.width;
        for (const [label, part] of [
          ["the v1 → v2 pair", notice.getByTestId("v2-moved-pair")],
          ["Keep using v1", notice.getByRole("button", { name: "Keep using v1" })],
          ["Open in v2", notice.getByRole("link", { name: "Open in v2", exact: true })],
        ] as const) {
          const partBox = await part.boundingBox();
          if (partBox === null) throw new Error(`${label} has no layout box`);
          expect(partBox.x, `${label} starts inside the notice`).toBeGreaterThanOrEqual(box.x);
          expect(partBox.x + partBox.width, `${label} ends inside the notice`).toBeLessThanOrEqual(
            right,
          );
        }
      });
    });
  }),
);
