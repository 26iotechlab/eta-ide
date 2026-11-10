// Functional drive for any generated Kanban board: node drive-kanban.cjs <dir>
// Selector-agnostic: buttons found by text (→/->, x/✕), columns by heading text.
const fs = require("fs");
const path = require("path");
(async () => {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(path.join(dir, "index.html"))) return console.log(JSON.stringify({ error: "no index.html in " + dir }));
  const { chromium } = require("playwright-core");
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  let exe = null; for (const c of candidates) if (fs.existsSync(c)) { exe = c; break; }
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const p = await b.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e).slice(0, 120)));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 120)); });
  const url = "file:///" + path.resolve(dir, "index.html").replace(/\\/g, "/");
  await p.goto(url, { waitUntil: "load" });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "load" });
  await p.waitForTimeout(400);

  const snap = () => p.evaluate(() => {
    const sel = ".card, li.task, .task-card, .kanban-card";
    const doingCol = [...document.querySelectorAll("div,section,ul")].find((d) => {
      const h = d.querySelector(":scope > h2, :scope > h3");
      return h && /doing|progress/i.test(h.textContent);
    });
    return {
      cards: document.querySelectorAll(sel).length,
      cols: [...document.querySelectorAll("h2, h3")].map((h) => h.textContent.trim()),
      inDoing: doingCol ? doingCol.querySelectorAll(sel).length : -1,
    };
  });

  let added = false;
  try {
    await p.fill('input[type="text"], input:not([type])', "Bench card 42");
    added = await p.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((x) => /add/i.test(x.textContent)) ||
        document.querySelector('button[type="submit"], form button');
      if (!btn) return false; btn.click(); return true;
    });
  } catch { /* no input */ }
  await p.waitForTimeout(400);
  const afterAdd = await snap();

  const moved = await p.evaluate(() => {
    const card = document.querySelector(".card, li.task, .task-card, .kanban-card");
    if (!card) return "no-card";
    const btn = [...card.querySelectorAll("button")].find((x) => /(→|->|»|right|^>$)/i.test(x.textContent.trim()));
    if (!btn) return "no-move-btn";
    btn.click(); return "clicked";
  });
  await p.waitForTimeout(400);
  const afterMove = await snap();

  await p.reload({ waitUntil: "load" });
  await p.waitForTimeout(400);
  const afterReload = await snap();

  const deleted = await p.evaluate(() => {
    const card = document.querySelector(".card, li.task, .task-card, .kanban-card");
    if (!card) return "no-card";
    const btn = [...card.querySelectorAll("button")].find((x) => /^(x|✕|×|✖|del|delete)$/i.test(x.textContent.trim()));
    if (!btn) return "no-del-btn";
    btn.click(); return "clicked";
  });
  await p.waitForTimeout(400);
  const afterDelete = await snap();

  console.log(JSON.stringify({ added, afterAdd, moved, afterMove, afterReload, deleted, afterDelete, errors }, null, 1));
  await b.close();
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e).slice(0, 250) })); process.exit(1); });
