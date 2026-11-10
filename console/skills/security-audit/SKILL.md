---
name: security-audit
description: Auditing code and dependencies for security issues and vulnerabilities. Use when asked to audit, scan, or secure code against injection, XSS, leaked secrets/credentials, or known CVEs.
---

# Security audit

Find real risks — don't just claim it's "secure".

- **Scan dependencies** with the project's ecosystem tool via `run_command`: Node → `npm audit`; Python → `pip-audit` or `safety check`. Report the actual advisories; fix by upgrading, not by ignoring.
- **Hunt hardcoded secrets:** `search` for `api_key`, `secret`, `password`, `token`, `BEGIN PRIVATE KEY`, `sk-`, `AKIA`. Secrets belong in environment variables, never in source or git history.
- **Injection:** never build SQL with string concatenation — use parameterized queries. Never pass user input to `eval`, `exec`, `os.system`, or a shell without validation.
- **Web:** escape user content before inserting into HTML (XSS); validate and size-limit all inputs; set auth checks on every protected route.
- **Files/paths:** reject `..` path traversal; validate that resolved paths stay inside the intended directory.
- Report findings as: file:line → the risk → the concrete fix. Fix the highest-severity issues first, then re-scan.
