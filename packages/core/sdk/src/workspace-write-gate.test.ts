import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { OrgWriteDeniedError } from "./errors";
import { activeFumaDbRef } from "./fuma-runtime";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolAddress,
  ToolName,
} from "./ids";
import { createExecutor } from "./executor";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import {
  serveOAuthTestServer,
  type OAuthTestServerRequest,
  type OAuthTestServerShape,
} from "./testing/oauth-test-server";

// ---------------------------------------------------------------------------
// `ExecutorConfig.workspaceWriteGate` — the host's freeze of a workspace.
//
// While the host's gate refuses, every user-intent write fails with the host's
// message, whoever owns the target; OAuth completion is refused before the
// authorization code is exchanged; and an OAuth refresh is refused before the
// token endpoint is called, without recording the grant as dead. The gate is
// read on every guarded operation, so the same executor follows the host's
// state as it changes. It is never asked while a storage transaction is open:
// a host's gate does its own I/O, which a held connection would block.
// ---------------------------------------------------------------------------

const FROZEN = "This workspace is paused for maintenance.";

const KEY_INTEG = IntegrationSlug.make("vercel");
const KEY_TEMPLATE = AuthTemplateSlug.make("apiKey");
const OAUTH_INTEG = IntegrationSlug.make("acme");
const OAUTH_TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");
const OAUTH_TOOL = ToolAddress.make("tools.acme.org.main.whoami");

const keyPlugin = definePlugin(() => ({
  id: "vercel" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("deploy"), description: "deploy" }] }),
  invokeTool: ({ credential }) => Effect.succeed({ value: credential.value }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({ slug: KEY_INTEG, description: "Vercel", config: {} }),
    /** Registers inside the plugin's own transaction, as spec imports do. */
    registerInTransaction: (slug: string) =>
      ctx.transaction(
        ctx.core.integrations.register({
          slug: IntegrationSlug.make(slug),
          description: slug,
          config: {},
        }),
      ),
  }),
}))();

const oauthPlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
  describeAuthMethods: () => [
    {
      id: "oauth",
      label: "OAuth2",
      kind: "oauth" as const,
      template: String(OAUTH_TEMPLATE),
      oauth: { scopes: [] },
    },
  ],
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({ slug: OAUTH_INTEG, description: "Acme", config: {} }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), keyPlugin, oauthPlugin] as const;

/** The host's state, flipped by each test; the gate reads it on every call. */
const makeHost = () => {
  const host = { frozen: false, calls: 0 };
  const workspaceWriteGate = () =>
    Effect.suspend(() => {
      host.calls += 1;
      return host.frozen ? Effect.fail(new OrgWriteDeniedError({ reason: FROZEN })) : Effect.void;
    });
  return { host, workspaceWriteGate };
};

const setup = Effect.gen(function* () {
  const harness = yield* makeTestWorkspaceHarness({ plugins });
  const { host, workspaceWriteGate } = makeHost();
  const executor = yield* createExecutor({ ...harness.config, workspaceWriteGate });
  yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));
  yield* executor.vercel.seed();
  yield* executor.acme.seed();
  return { ...harness, executor, host };
});

const expectFrozen = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error).toMatchObject({ _tag: "OrgWriteDeniedError", reason: FROZEN });
    }),
  );

const tokenRequests = (requests: readonly OAuthTestServerRequest[]) =>
  requests.filter((request) => request.path === "/token" && request.method === "POST");

/** An org OAuth connection named `main`, connected while the host is open. */
const connectOAuth = (
  executor: Effect.Success<typeof setup>["executor"],
  server: OAuthTestServerShape,
) =>
  Effect.gen(function* () {
    yield* executor.oauth.createClient({
      owner: "org",
      slug: CLIENT,
      authorizationUrl: server.authorizationEndpoint,
      tokenUrl: server.tokenEndpoint,
      grant: "authorization_code",
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const started = yield* executor.oauth.start({
      owner: "org",
      clientOwner: "org",
      client: CLIENT,
      integration: OAUTH_INTEG,
      template: OAUTH_TEMPLATE,
      name: ConnectionName.make("main"),
    });
    if (started.status !== "redirect") return yield* Effect.die("expected a redirect");
    const callback = yield* server.completeAuthorizationCodeFlow({
      authorizationUrl: started.authorizationUrl,
    });
    return { state: started.state, code: callback.code };
  });

describe("workspaceWriteGate", () => {
  it.effect("refuses connection writes for every owner, read fresh on each call", () =>
    Effect.gen(function* () {
      const { executor, host } = yield* setup;
      host.frozen = true;
      for (const owner of ["user", "org"] as const) {
        yield* expectFrozen(
          executor.connections.create({
            owner,
            name: ConnectionName.make(`frozen-${owner}`),
            integration: KEY_INTEG,
            template: KEY_TEMPLATE,
            value: "token",
          }),
        );
      }
      expect(yield* executor.connections.list({ owner: "user" })).toEqual([]);

      // The same executor follows the host as soon as it reopens…
      host.frozen = false;
      const mine = yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("mine"),
        integration: KEY_INTEG,
        template: KEY_TEMPLATE,
        value: "token",
      });
      const ref = { owner: mine.owner, integration: mine.integration, name: mine.name };

      // …and again when it freezes: no change goes through, but the
      // connection is still read and still runs its tools.
      host.frozen = true;
      yield* expectFrozen(executor.connections.update(ref, { description: "renamed" }));
      yield* expectFrozen(executor.connections.refresh(ref));
      yield* expectFrozen(executor.connections.remove(ref));
      yield* expectFrozen(
        executor.policies.create({ owner: "user", pattern: "*", action: "block" }),
      );
      expect((yield* executor.connections.list({ owner: "user" })).map((c) => c.name)).toEqual([
        "mine",
      ]);
      const out = yield* executor.execute(ToolAddress.make("tools.vercel.user.mine.deploy"), {});
      expect(out).toMatchObject({ value: "token" });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an OAuth callback before the authorization code is exchanged", () =>
    Effect.gen(function* () {
      const server = yield* serveOAuthTestServer({ scopes: [] });
      const { executor, host } = yield* setup;
      const { state, code } = yield* connectOAuth(executor, server);

      host.frozen = true;
      yield* server.clearRequests;
      yield* expectFrozen(executor.oauth.complete({ state, code }));
      expect(tokenRequests(yield* server.requests)).toEqual([]);
      expect(yield* executor.connections.list({ owner: "org" })).toEqual([]);

      // The code was never spent: the same callback completes once reopened.
      host.frozen = false;
      const connection = yield* executor.oauth.complete({ state, code });
      expect(String(connection.name)).toBe("main");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a token refresh before the token endpoint, leaving the grant usable", () =>
    Effect.gen(function* () {
      const server = yield* serveOAuthTestServer({ scopes: [] });
      const { executor, host, config } = yield* setup;
      const { state, code } = yield* connectOAuth(executor, server);
      yield* executor.oauth.complete({ state, code });
      const first = (yield* executor.execute(OAUTH_TOOL, {})) as { token: string };

      // Expire the access token so the next call must refresh.
      yield* Effect.promise(() =>
        config.db.updateMany("connection", {
          where: (b) => b("name", "=", "main"),
          set: { expires_at: Date.now() - 60_000 },
        }),
      );

      host.frozen = true;
      yield* server.clearRequests;
      const refused = yield* Effect.flip(executor.execute(OAUTH_TOOL, {}));
      expect(refused).toMatchObject({
        _tag: "CredentialResolutionError",
        integration: "acme",
        name: "main",
        message: FROZEN,
      });
      expect(refused).not.toHaveProperty("reauthRequired", true);
      expect(tokenRequests(yield* server.requests)).toEqual([]);

      // Nothing recorded the grant as dead: once reopened, it refreshes.
      host.frozen = false;
      const refreshed = (yield* executor.execute(OAUTH_TOOL, {})) as { token: string };
      expect(refreshed.token).toMatch(/^at_/);
      expect(refreshed.token).not.toBe(first.token);
      expect(tokenRequests(yield* server.requests)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("is asked before each write transaction opens, never inside one", () =>
    Effect.gen(function* () {
      const harness = yield* makeTestWorkspaceHarness({ plugins });
      const host = { frozen: false, askedInTransaction: [] as boolean[] };
      const executor = yield* createExecutor({
        ...harness.config,
        workspaceWriteGate: () =>
          Effect.gen(function* () {
            host.askedInTransaction.push((yield* activeFumaDbRef) !== null);
            if (host.frozen) return yield* new OrgWriteDeniedError({ reason: FROZEN });
          }),
      });
      yield* Effect.addFinalizer(() => executor.close().pipe(Effect.ignore));

      yield* executor.vercel.seed();
      yield* executor.vercel.registerInTransaction("in-plugin-transaction");
      const mine = yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("mine"),
        integration: KEY_INTEG,
        template: KEY_TEMPLATE,
        value: "token",
      });
      const ref = { owner: mine.owner, integration: mine.integration, name: mine.name };
      yield* executor.connections.update(ref, { description: "renamed" });
      const policy = yield* executor.policies.create({
        owner: "user",
        pattern: "*",
        action: "block",
      });
      yield* executor.policies.update({ owner: "user", id: policy.id, action: "approve" });
      yield* executor.policies.remove({ owner: "user", id: policy.id });
      yield* executor.connections.remove(ref);
      expect(host.askedInTransaction.length).toBeGreaterThanOrEqual(8);
      expect(host.askedInTransaction).not.toContain(true);

      // The verdict taken before the transaction still refuses inside it.
      host.frozen = true;
      yield* expectFrozen(executor.vercel.registerInTransaction("frozen-in-transaction"));
      expect(host.askedInTransaction).not.toContain(true);
      const slugs = (yield* executor.integrations.list()).map((i) => String(i.slug));
      expect(slugs).toContain("in-plugin-transaction");
      expect(slugs).not.toContain("frozen-in-transaction");
    }).pipe(Effect.scoped),
  );

  it.effect("is not consulted by reads or by tool calls that need no refresh", () =>
    Effect.gen(function* () {
      const { executor, host } = yield* setup;
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("mine"),
        integration: KEY_INTEG,
        template: KEY_TEMPLATE,
        value: "token",
      });
      host.frozen = true;
      const before = host.calls;
      yield* executor.connections.list({ owner: "user" });
      yield* executor.integrations.list();
      yield* executor.execute(ToolAddress.make("tools.vercel.user.mine.deploy"), {});
      expect(host.calls).toBe(before);
    }).pipe(Effect.scoped),
  );
});
