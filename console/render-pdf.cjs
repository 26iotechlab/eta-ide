// Render an HTML file to PDF via headless system Chromium: node render-pdf.cjs <in.html> <out.pdf>
const fs = require("fs");
const path = require("path");
(async () => {
  const [inHtml, outPdf] = process.argv.slice(2);
  if (!inHtml || !outPdf) return console.error("usage: node render-pdf.cjs <in.html> <out.pdf>");
  const { chromium } = require("playwright-core");
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  let exe = null; for (const c of candidates) if (fs.existsSync(c)) { exe = c; break; }
  if (!exe) throw new Error("no Chrome/Edge found");
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const p = await b.newPage();
  await p.goto("file:///" + path.resolve(inHtml).replace(/\\/g, "/"), { waitUntil: "load" });
  await p.pdf({ path: outPdf, format: "A4", printBackground: true, displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate: '<div style="width:100%;text-align:center;font-size:8px;color:#888">Eta IDE — Complete Project Documentation · <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
    margin: { top: "14mm", bottom: "16mm", left: "0", right: "0" } });
  await b.close();
  console.log("PDF written:", outPdf, fs.statSync(outPdf).size, "bytes");
})().catch((e) => { console.error(String(e)); process.exit(1); });
