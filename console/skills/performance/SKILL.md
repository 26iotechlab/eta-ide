---
name: performance
description: Finding and fixing performance, memory, and code-smell problems. Use when asked to optimize, speed up, profile, or fix a slow/inefficient/bottlenecked/unscalable piece of code.
---

# Performance & efficiency

Measure first, then fix the real bottleneck — don't guess.

- **Profile before optimizing.** Time the slow path (`time`, `timeit`, or simple timestamps) so you optimize what actually matters, and measure again after to prove the win.
- **Algorithmic wins beat micro-tuning.** Replace nested loops over the same data (O(n²)) with a dict/set lookup (O(n)); avoid repeated work inside loops; hoist invariant computations out.
- **Cache / memoize** pure, repeated computations. Reuse connections and compiled regexes instead of rebuilding them each call.
- **I/O is usually the cost:** batch database/network/file calls; stream large data instead of loading it all into memory; use pagination.
- **Memory:** avoid building huge intermediate lists — use generators/iterators; free large objects; watch for accidental O(n) copies.
- **Code smells to fix:** long functions doing many things, duplicated logic, deep nesting, magic numbers — extract and name them, but keep tests green through every change.
