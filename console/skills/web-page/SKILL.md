---
name: web-page
description: Building a working single-file HTML/CSS/JS web page that loads cleanly. Use for HTML/CSS/JavaScript web page, website, or frontend/browser UI work.
---

# Web page

- Prefer a **single self-contained file**: put CSS in a `<style>` and JS in a `<script>` inside the HTML unless the task asks for separate files.
- Do NOT load external CDNs/frameworks/fonts — the page must work fully offline. Write plain HTML/CSS/vanilla JS.
- Start every page with `<!doctype html>` and a real `<html><head>…</head><body>…</body></html>` structure.
- Wait for the DOM: wrap JS that touches elements in `DOMContentLoaded`, or place the `<script>` at the end of `<body>`.
- Give interactive elements real handlers; update the DOM in response to events. Keep the console clean — no uncaught errors, no references to undefined ids.
- After writing an `.html` file, VERIFY it with the `check_page` tool: it opens the page in a real browser and reports console/JS/load errors. Fix anything it finds, then re-check.
- Make it responsive with flexbox/grid and relative units; images `max-width:100%`.
