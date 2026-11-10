---
name: pull-request
description: Pushing a branch and opening a GitHub pull request with a written summary. Use when asked to open a PR, push a branch upstream, or propose changes for review.
---

# Opening a pull request

Prefer the built-in flow: the IDE's **Open Pull Request** action pushes the branch and
opens the PR with a generated title and summary. To do it by hand with the GitHub CLI:

- Make sure `gh` is installed and you're signed in: `gh auth status` (if not, `gh auth login`).
- **Never open a PR from `main`/`master`.** Create a branch first: `git checkout -b eta/<short-topic>`.
- Stage and commit the change with a clear conventional message (`git add -A`, `git commit -m "feat: …"`).
- Push and set upstream: `git push -u origin <branch>`.
- Open the PR: `gh pr create --base main --title "<title>" --body "<summary>"`.
- Write the body from the real diff: 2–4 bullets on *what* changed and *why*, plus how it was tested. Keep the title in conventional-commit style.
- If `gh` isn't available, push the branch and tell the user the URL to open the PR manually — don't fail silently.
