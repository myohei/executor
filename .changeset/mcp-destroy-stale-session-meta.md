---
"@executor-js/cloud": patch
---

An MCP request that reaches a session while the session is being torn down now gets the "Session not found" protocol error instead of a 500.
