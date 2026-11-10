---
name: merge-conflict
description: Resolving git merge and rebase conflicts correctly. Use when there's a merge/rebase conflict, diverged branches, or a cherry-pick conflict to resolve (ours vs theirs).
---

# Resolving merge conflicts

- **Find the conflicts:** `git status` lists the files "both modified". Open each and locate the `<<<<<<<`, `=======`, `>>>>>>>` markers.
- Understand BOTH sides before touching anything: the code above `=======` is your current branch (ours), below is the incoming change (theirs). Read what each was trying to do.
- **Resolve by intent, not by picking a side blindly.** Usually the correct result KEEPS BOTH behaviours (combine them), not just one. Only take one side when they truly conflict.
- Remove ALL three markers completely — a leftover `<<<<<<<` is a syntax error.
- After editing every conflicted file, run the **tests** to prove the merge didn't break behaviour, then `git add <files>` and `git commit` (or `git rebase --continue`).
- If it's badly tangled and you're unsure, `git merge --abort` / `git rebase --abort` to return to a clean state and try a smaller, more careful merge — never leave the tree half-merged.
