// Browser-in-the-loop: open the agent's web pages in a REAL browser (headless
// Chrome/Edge via playwright-core), harvest console/JS/load errors, and take a
// screenshot as a walkthrough artifact. This converts "plausible-looking web
// code" into "verified-running web code" — the biggest multiplier for a weak
// model on web tasks (its 'definition of done' becomes: it runs, console clean).
import * as path from "path";
import * as fs from "fs/promises";

let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const { chromium } = await import("playwright-core");
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  let exe = null;
  for (const c of candidates) { try { await fs.access(c); exe = c; break; } catch {} }
  if (!exe) throw new Error("no Chrome/Edge found for browser checks");
  _browser = await chromium.launch({ executablePath: exe, headless: true });
  return _browser;
}

export async function checkPage(root, rel) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("JS error: " + String(e.message || e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text().slice(0, 300)); });
  page.on("requestfailed", (r) => errors.push("failed to load: " + r.url().split(/[\\/]/).pop() + " (" + (r.failure()?.errorText || "") + ")"));
  const full = path.resolve(root, rel);
  const url = "file:///" + full.replace(/\\/g, "/");
  try { await page.goto(url, { waitUntil: "load", timeout: 15000 }); await page.waitForTimeout(2000); }
  catch (e) { errors.push("page failed to load: " + String(e.message).slice(0, 200)); }
  // INTERACTION PROBE — load-only checks pass pages whose buttons are broken
  // (undefined handlers only throw on click). Fill the first text input, then
  // click every visible button once and attribute any new errors to that click.
  try {
    await page.evaluate(() => {
      const i = document.querySelector('input[type="text"], input:not([type])');
      if (i) { i.value = "probe"; i.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    const buttons = await page.$$("button, [role=button], input[type=button], input[type=submit]");
    for (const b of buttons.slice(0, 8)) {
      let label = ""; try { label = ((await b.innerText()) || "").trim().slice(0, 30); } catch {}
      const before = errors.length;
      try { await b.click({ timeout: 1500 }); } catch { continue; } // hidden/covered — skip
      await page.waitForTimeout(200);
      for (let k = before; k < errors.length; k++) errors[k] = `on click "${label || "button"}": ` + errors[k];
    }
  } catch { /* probe is best-effort */ }
  // Visual-emptiness heuristic (model-independent): elements exist in the DOM but
  // almost nothing actually renders => missing CSS sizes/colors. Console-clean
  // pages can still be visually blank — this catches that class.
  try {
    const stats = await page.evaluate(() => {
      const els = [...document.querySelectorAll("body *")];
      const visible = els.filter((e) => e.offsetWidth > 4 && e.offsetHeight > 4);
      return { total: els.length, visible: visible.length };
    });
    if (stats.total > 3 && stats.visible <= 2)
      errors.push(`page renders visually EMPTY: ${stats.total} elements exist but only ${stats.visible} are visible — elements likely have no size/color (missing or unlinked CSS)`);
    // broken images decode to nothing without any console error — catch them
    const badImgs = await page.evaluate(() =>
      [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => (i.getAttribute("src") || "").slice(-60)));
    for (const s of badImgs.slice(0, 4)) errors.push(`broken image (exists but does not decode/display): ${s}`);
  } catch {}
  const shotDir = path.join(root, ".eta", "shots");
  await fs.mkdir(shotDir, { recursive: true });
  const shotName = rel.replace(/[\\/]/g, "_").replace(/\.html?$/i, "") + "-" + Date.now() + ".png";
  const shotFull = path.join(shotDir, shotName);
  let shot = null;
  try { await page.screenshot({ path: shotFull }); shot = ".eta/shots/" + shotName; } catch {}
  await page.close();
  return { ok: errors.length === 0, errors: errors.slice(0, 8), shot };
}

// Render an HTML file in the workspace to a real PDF using the same bundled
// headless Chromium — no extra libraries. Loads via file:// so the page's own
// CSS/images/fonts resolve. Returns { ok, output, bytes } or { ok:false, error }.
export async function renderPdf(root, srcRel, outRel, opts = {}) {
  let browser;
  try { browser = await getBrowser(); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  const page = await browser.newPage();
  try {
    const full = path.resolve(root, srcRel);
    const url = "file:///" + full.replace(/\\/g, "/");
    await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    const out = path.resolve(root, outRel);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await page.pdf({
      path: out,
      format: opts.format || "A4",
      printBackground: true,
      margin: opts.margin || { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
    });
    const { size } = await fs.stat(out);
    return { ok: true, output: outRel, bytes: size };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  } finally { try { await page.close(); } catch {} }
}

// Screenshot an HTML file in the workspace, or a full http(s) URL, to a PNG.
export async function screenshotPage(root, target, outRel) {
  let browser;
  try { browser = await getBrowser(); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const url = /^https?:\/\//i.test(target) ? target : "file:///" + path.resolve(root, target).replace(/\\/g, "/");
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    const out = path.resolve(root, outRel);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, fullPage: true });
    const { size } = await fs.stat(out);
    return { ok: true, output: outRel, bytes: size };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
  finally { try { await page.close(); } catch {} }
}

export async function closeBrowser() { try { if (_browser) await _browser.close(); } catch {} _browser = null; }
