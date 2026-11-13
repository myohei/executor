import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolName,
} from "./ids";
import type { AuthMethodDescriptor } from "./integration";
import type { OAuthStartError } from "./oauth-client";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { scopesFromAuthorizeUrl, serveOAuthTestServer } from "./testing/oauth-test-server";

// A dynamically registered client may only be authorized for the scopes it
// registered for: Mercury answers `invalid_scope` for any other. When the
// server later advertises more scopes, reconnecting must register a client
// that covers them rather than reuse the old registration, and a flow through
// a client never asks for scopes outside its registration.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const FLOW_REDIRECT_URI = "https://localhost:5394/api/oauth/callback";

const registerRequestCount = (
  requests: readonly { readonly path: string; readonly method: string }[],
): number => requests.filter((r) => r.path === "/register" && r.method === "POST").length;

/** An integration whose OAuth method either declares `scopes` or, like MCP,
 *  discovers them from `discoveryUrl`. */
const scopePlugin = (oauth: AuthMethodDescriptor["oauth"]) =>
  definePlugin(() => ({
    id: "acme" as const,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({
        tools: [{ name: ToolName.make("whoami"), description: "whoami" }],
      }),
    invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
    describeAuthMethods: (): readonly AuthMethodDescriptor[] => [
      { id: "oauth", label: "OAuth2", kind: "oauth", template: String(TEMPLATE), oauth },
    ],
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
    }),
  }))();

const setup = (options: {
  readonly declaredScopes?: readonly string[];
  readonly registrableScopes?: readonly string[];
}) =>
  Effect.gen(function* () {
    const server = yield* serveOAuthTestServer({
      scopes: ["read", "write"],
      enforceRegisteredScopes: true,
      ...(options.registrableScopes === undefined
        ? {}
        : { registrableScopes: options.registrableScopes }),
    });
    const plugins = [
      memoryCredentialsPlugin(),
      scopePlugin(
        options.declaredScopes === undefined
          ? { discoveryUrl: server.mcpResourceUrl }
          : { scopes: options.declaredScopes },
      ),
    ] as const;
    const harness = yield* makeTestWorkspaceHarness({ plugins });
    yield* harness.executor.acme.seed();
    const probe = yield* harness.executor.oauth.probe({ url: server.mcpResourceUrl });
    const register = (scopes: readonly string[]) =>
      harness.executor.oauth.registerDynamicClient({
        owner: "org",
        slug: OAuthClientSlug.make("acme-dcr"),
        issuer: probe.issuer,
        registrationEndpoint: probe.registrationEndpoint!,
        authorizationUrl: probe.authorizationUrl,
        tokenUrl: probe.tokenUrl,
        resource: probe.resource,
        scopes,
        tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
        clientName: "Executor",
        redirectUri: FLOW_REDIRECT_URI,
        originIntegration: INTEG,
      });
    const start = (client: OAuthClientSlug) =>
      harness.executor.oauth.start({
        owner: "org",
        client,
        clientOwner: "org",
        name: ConnectionName.make("main"),
        integration: INTEG,
        template: TEMPLATE,
        redirectUri: FLOW_REDIRECT_URI,
      });
    return { ...harness, server, probe, register, start };
  });

describe("DCR registered scopes", () => {
  it.effect("reconnecting after the server added scopes registers a client covering them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, server, probe, register, start } = yield* setup({});
        expect(probe.scopesSupported).toEqual(["read", "write"]);

        // Registered while the server only offered `read`.
        const original = yield* register(["read"]);
        yield* server.clearRequests;

        // Reconnect registers with the scopes the server now advertises.
        const reconnected = yield* register(probe.scopesSupported ?? []);
        expect(registerRequestCount(yield* server.requests)).toBe(1);
        expect(String(reconnected)).not.toBe(String(original));

        const started = yield* start(reconnected);
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual(["read", "write"]);
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });
        expect(String(connection.address)).toBe("tools.acme.org.main");
      }),
    ),
  );

  it.effect("reuses a client whose registration covers the request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, register } = yield* setup({});
        const original = yield* register(["read", "write"]);
        yield* server.clearRequests;

        const reused = yield* register(["read"]);
        expect(registerRequestCount(yield* server.requests)).toBe(0);
        expect(String(reused)).toBe(String(original));
      }),
    ),
  );

  it.effect("does not reuse a client with no recorded registration scopes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, server, register } = yield* setup({});
        const legacy = yield* register(["read"]);
        yield* Effect.promise(() =>
          config.db.updateMany("oauth_client", {
            where: (b) => b("slug", "=", String(legacy)),
            set: { origin_requested_scopes: null, origin_scopes: null },
          }),
        );
        yield* server.clearRequests;

        const registered = yield* register(["read"]);
        expect(registerRequestCount(yield* server.requests)).toBe(1);
        expect(String(registered)).not.toBe(String(legacy));
      }),
    ),
  );

  it.effect("start narrows to the scopes the server registered, not the ones asked for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The server registers only `read` though the client asked for both.
        const { executor, server, register, start } = yield* setup({
          registrableScopes: ["read"],
        });
        const client = yield* register(["read", "write"]);

        const started = yield* start(client);
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual(["read"]);
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });
        expect(connection.oauthScope).toBe("read");
      }),
    ),
  );

  it.effect("reuses a narrowed registration instead of registering again on reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, register } = yield* setup({ registrableScopes: ["read"] });
        const original = yield* register(["read", "write"]);
        yield* server.clearRequests;

        // Registering again would be narrowed the same way, so the client that
        // already asked for these scopes is reused.
        const reused = yield* register(["read", "write"]);
        expect(registerRequestCount(yield* server.requests)).toBe(0);
        expect(String(reused)).toBe(String(original));
      }),
    ),
  );

  it.effect("start narrows discovered scopes to the client's registration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, server, register, start } = yield* setup({});
        const client = yield* register(["read"]);

        const started = yield* start(client);
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual(["read"]);
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });
        expect(connection.oauthScope).toBe("read");
      }),
    ),
  );

  it.effect("start refuses declared scopes outside the client's registration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, register, start } = yield* setup({ declaredScopes: ["read", "write"] });
        const client = yield* register(["read"]);
        yield* server.clearRequests;

        const error = yield* start(client).pipe(Effect.flip);
        expect(Predicate.isTagged("OAuthStartError")(error)).toBe(true);
        const startError = error as OAuthStartError;
        expect(startError.message).toContain("write");
        const requests = yield* server.requests;
        expect(requests.filter((r) => r.path === "/authorize")).toHaveLength(0);
      }),
    ),
  );
});
