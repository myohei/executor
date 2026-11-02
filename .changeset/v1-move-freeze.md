---
"@executor-js/sdk": patch
"@executor-js/api": patch
"@executor-js/cloud": patch
---

Hosts can pause every change to a workspace with `workspaceWriteGate`: connection and OAuth writes, OAuth completion (before the code is exchanged) and OAuth token refreshes are refused with the host's message, while reads and tool calls keep working. The OAuth callback popup now shows why a refusal the user can act on happened. Executor Cloud uses this to freeze an organization while it moves to Executor v2, refuses changes to it once it has moved, and opens a moved organization's dashboard in v2.
