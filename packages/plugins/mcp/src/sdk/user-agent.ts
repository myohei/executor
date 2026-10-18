// Some upstreams (Cloudflare bot rules among them) reject requests without a
// User-Agent, and Workers' fetch adds none. Every request the MCP plugin sends
// to an MCP server or its OAuth metadata carries this default. A configured
// User-Agent wins.
export const DEFAULT_USER_AGENT = "executor";

const configuredUserAgent = (headers: Readonly<Record<string, string>>): string | undefined =>
  Object.entries(headers).find(([name]) => name.toLowerCase() === "user-agent")?.[1];

export const withDefaultUserAgent = (headers: Record<string, string>): Record<string, string> =>
  configuredUserAgent(headers) === undefined
    ? { "User-Agent": DEFAULT_USER_AGENT, ...headers }
    : headers;

export const userAgentFor = (headers: Readonly<Record<string, string>>): string =>
  configuredUserAgent(headers) ?? DEFAULT_USER_AGENT;
