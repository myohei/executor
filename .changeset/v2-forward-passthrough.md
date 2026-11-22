---
"@executor-js/cloud": patch
---

Executor Cloud forwards MCP requests that use `mode=passthrough` for a workspace that has moved to Executor v2, instead of refusing them. v2 serves its own tools for them.
