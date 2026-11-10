---
name: debugging
description: Systematically finding and fixing a failing test, error, or crash. Use when something fails, crashes, throws an exception/traceback, or is broken/incorrect/not working.
---

# Debugging

Don't rewrite whole files hoping the bug goes away. Work the failure precisely:

1. **Read the exact failure.** Find the last line of your OWN code in the traceback — the `File "...", line N` that is NOT in the standard library. That line, or the one above it, is where to look.
2. **State the root cause** in one sentence: what value/condition is wrong, and why. (Example: "evaluate returns None because parse_expr never handles a leading '-', so unary minus falls through.")
3. **Make the smallest fix.** Use `edit_file` (SEARCH/REPLACE) to change only the broken lines — never a full rewrite, which reintroduces bugs.
4. **Re-run the exact same command.** If it still fails, compare expected vs actual for the failing case specifically, and repeat from step 1.
5. Use `get_diagnostics` (if available) to catch undefined names / type errors the run didn't reach.

Never edit the tests to make a failing test pass — the bug is in the implementation.
