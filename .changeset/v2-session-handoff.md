---
"@executor-js/cloud": patch
---

Executor Cloud hands a signed-in member of a workspace that has moved to Executor v2 to v2 with a short-lived signed token, so v2 opens the workspace without asking them to sign in again. It is off until `V2_SESSION_HANDOFF_SECRET` is set.
