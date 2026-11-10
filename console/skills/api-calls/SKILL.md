---
name: api-calls
description: Calling HTTP APIs robustly and handling responses and errors. Use when the task involves an API, HTTP/HTTPS request, fetch, endpoint, REST, JSON client, webhook, or authorization/token handling.
---

# Calling HTTP APIs

- Always set a **timeout** and check the status before using the body. Never assume a request succeeded.
- Handle failure explicitly: non-2xx status, network errors, and invalid/empty JSON each need a clear branch — don't let one crash the whole flow.
- **Never hardcode secrets** (API keys, tokens) in source. Read them from an environment variable or a config the user provides.
- Parse JSON defensively: guard against missing fields; don't index into a response shape you haven't verified.
- Prefer the language's standard client (Python `urllib`/`http.client`, Node `fetch`) unless a library is already in the project — don't add a dependency just to make a request.
- Be idempotent-aware: retry only safe (GET) calls on transient failure, with a small backoff; don't blindly retry POSTs.
- Log enough to debug (status + a short error snippet), but never log secrets.
