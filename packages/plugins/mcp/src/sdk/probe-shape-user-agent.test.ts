import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { probeMcpEndpointShape } from "./probe-shape";

const endpoint = "https://mcp.example/mcp";
const metadataUrl = "https://mcp.example/.well-known/oauth-protected-resource/mcp";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly mcpProtocolVersion: string | undefined;
  readonly userAgent: string | undefined;
}

/** Records every request and answers with `respond`'s status. */
const recordingClientLayer = (
  recorded: Array<RecordedRequest>,
  respond: (request: HttpClientRequest.HttpClientRequest) => number,
) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      recorded.push({
        method: request.method,
        url: request.url,
        mcpProtocolVersion: request.headers["mcp-protocol-version"],
        userAgent: request.headers["user-agent"],
      });
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("", { status: respond(request) })),
      );
    }),
  );

/** POST → 405, so the probe falls back to GET; GET → 401 with no Bearer
 *  challenge, so the probe reads RFC 9728 metadata, which is missing. */
const challengeWithoutBearer = (request: HttpClientRequest.HttpClientRequest): number =>
  request.method === "POST" ? 405 : request.url === endpoint ? 401 : 404;

const summarize = (recorded: ReadonlyArray<RecordedRequest>) =>
  recorded.map((request) => ({
    request: `${request.method} ${request.url}${
      request.mcpProtocolVersion ? ` (${request.mcpProtocolVersion})` : ""
    }`,
    userAgent: request.userAgent,
  }));

describe("MCP shape probe User-Agent", () => {
  it.effect("sends a default User-Agent on the probe and its OAuth metadata request", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];

      yield* probeMcpEndpointShape(endpoint, {
        httpClientLayer: recordingClientLayer(recorded, challengeWithoutBearer),
      });

      expect(summarize(recorded)).toEqual([
        { request: `POST ${endpoint}`, userAgent: "executor" },
        { request: `GET ${endpoint}`, userAgent: "executor" },
        { request: `GET ${metadataUrl}`, userAgent: "executor" },
      ]);
    }),
  );

  it.effect("sends a default User-Agent on the discover request", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];

      yield* probeMcpEndpointShape(endpoint, {
        httpClientLayer: recordingClientLayer(recorded, () => 404),
      });

      expect(summarize(recorded)).toEqual([
        { request: `POST ${endpoint}`, userAgent: "executor" },
        { request: `GET ${endpoint}`, userAgent: "executor" },
        { request: `POST ${endpoint} (2026-07-28)`, userAgent: "executor" },
      ]);
    }),
  );

  it.effect("keeps a configured User-Agent on every probe request", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = [];

      yield* probeMcpEndpointShape(endpoint, {
        headers: { "User-Agent": "custom-agent/1.0" },
        httpClientLayer: recordingClientLayer(recorded, challengeWithoutBearer),
      });

      expect(summarize(recorded)).toEqual([
        { request: `POST ${endpoint}`, userAgent: "custom-agent/1.0" },
        { request: `GET ${endpoint}`, userAgent: "custom-agent/1.0" },
        { request: `GET ${metadataUrl}`, userAgent: "custom-agent/1.0" },
      ]);
    }),
  );
});
