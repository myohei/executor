import { describe, expect, it } from "@effect/vitest";

import { OAuthSessionNotFoundError, OAuthState, OrgWriteDeniedError } from "@executor-js/sdk";

import { toPopupErrorMessage } from "./oauth";

describe("OAuth callback popup message", () => {
  it("says why a refusal the user can act on happened", () => {
    expect(
      toPopupErrorMessage(new OrgWriteDeniedError({ reason: "This workspace is paused." })),
    ).toEqual({
      short: "Could not complete authentication",
      details: "This workspace is paused.",
    });
    expect(toPopupErrorMessage(new OrgWriteDeniedError({}))).toEqual({
      short: "Could not complete authentication",
      details: "Adding connections or changing workspace settings requires a workspace admin.",
    });
  });

  it("keeps the messages it already had", () => {
    expect(
      toPopupErrorMessage(new OAuthSessionNotFoundError({ state: OAuthState.make("st_1") })),
    ).toEqual({ short: "OAuth session expired or not found", details: "State: st_1" });
    expect(toPopupErrorMessage("unexpected")).toEqual({ short: "Authentication failed" });
  });
});
