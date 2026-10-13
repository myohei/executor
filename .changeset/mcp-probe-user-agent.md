---
"executor": patch
---

Send the default User-Agent on the MCP endpoint probe and its OAuth metadata request too, so adding a server that rejects requests without one no longer fails. A configured User-Agent still wins.
