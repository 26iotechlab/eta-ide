---
name: git-commit
description: Writing clear conventional commit messages and committing changes safely. Use when committing staged changes, writing a git commit message, or pushing history.
---

# Git commits

- **Look before you commit:** run `git status` and `git diff` (or `git diff --staged`) to see exactly what changed. Write the message from the real diff, not from memory.
- Use a **conventional commit** subject: `type(scope): short imperative summary` — types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`. Keep the subject ≤ 72 chars, imperative mood ("add", not "added").
- Add a body only when the *why* isn't obvious from the subject: explain the reason and any trade-off, wrapped at ~72 columns.
- **One logical change per commit.** If the diff mixes unrelated changes, stage and commit them separately (`git add <path>`).
- Never force-push a shared branch; branch off `main` before committing new work. Don't commit secrets, build output, or `node_modules` — respect `.gitignore`.
- After committing, confirm with `git log --oneline -1`.
