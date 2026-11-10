---
name: refactoring
description: Safely renaming or restructuring existing code without breaking it. Use when asked to refactor, rename, restructure, clean up, reorganize, extract, or simplify existing code.
---

# Refactoring

Change the shape of the code without changing its behaviour — safely, in small steps.

- **Renames:** use the `rename_symbol` tool (a real language-server rename across the whole project), NOT text find-and-replace — it won't rename the wrong matches or miss usages.
- Make ONE small change at a time with `edit_file`, then re-run the tests before the next. Never do a big-bang rewrite.
- Keep the tests green the entire time — if a refactor turns a test red, revert that step and do it smaller.
- After each change, run `get_diagnostics` (if available) to catch broken references and type errors immediately.
- Preserve public behaviour and signatures unless the task explicitly asks to change them.
- Don't add features while refactoring; keep the diff about structure only.
