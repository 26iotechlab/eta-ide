---
name: documentation
description: Writing docstrings, comments, and README documentation. Use when asked to document, comment, explain, or write a README, guide, or API reference.
---

# Documentation

Write docs a real developer can use — describe behaviour and intent, not the obvious.

- **Docstrings/JSDoc** on public functions and classes: one line on what it does, then its parameters, return value, and the errors/exceptions it can raise. Match the language's convention (Python triple-quoted, JS `/** */`).
- **Comments explain WHY, not what.** `i += 1  # increment i` is noise; `# skip the header row` is useful. Comment the non-obvious decision or edge case.
- **README** for a project or module: what it is, how to install/run it, a short usage example that actually works, and how to run the tests.
- Keep docs **in sync with the code** — if you change a signature or behaviour, update its docstring in the same edit. Wrong docs are worse than none.
- Prefer a runnable example over prose. Don't document private internals unless they're genuinely tricky.
- Keep it concise; delete boilerplate and restated obvious lines.
