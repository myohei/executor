---
"@executor-js/sdk": patch
---

Keep OAuth requests within the scopes a dynamically registered client was registered for. DCR clients now persist the scopes their registration asked for (`oauth_client.origin_requested_scopes`) and the scopes the server registered, from the registration response (`oauth_client.origin_scopes`, RFC 7591 §3.2.1). Reuse picks a client only when its registration covers the requested scopes, so reconnecting after a server adds scopes registers a new client instead of pairing the old one with scopes the server refuses with `invalid_scope`. `oauth.start` narrows discovered scopes to the server-registered set and fails with a clear error when declared scopes fall outside it. Clients registered before this release have no recorded scopes and are registered again on their next connect; existing connections keep refreshing through them.
