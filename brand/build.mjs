// Builds the centred Eta IDE logo assets and puts them in every place that had the old logo.
// Source logo: D:\tmp\eta-logo (the zip package). Safe to run again.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire("D:/eta-ide-release/console/package.json");
const sharp = require("sharp");

const ROOT = "D:/eta-ide-release";
const APP = ROOT + "/dist/Eta-IDE/resources/app";
const OUT = ROOT + "/brand";
const BACK = OUT + "/original-backup";
fs.mkdirSync(BACK, { recursive: true });

const POLYS = [
  "387,76 268,0 98,46 0,202 105,359 278,341 373,268 134,307 59,197 128,87 270,45",
  "256,53 132,110 99,150 223,108",
  "383,190 291,129 139,171 98,239 139,288 190,204 293,167",
  "283,197 277,216 271,222 253,229 265,232 277,242 283,261 290,240 295,235 311,229 298,224 289,216",
];
// The shape is 387 wide and 359 tall. A 387 x 387 square with a 14 shift down puts it in the exact middle.
const shape = (fill) => POLYS.map((p) => `<polygon points="${p}" fill="${fill}"/>`).join("");
const square = (fill, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 387 387" width="1024" height="1024"><title>Eta IDE</title>${extra}<g transform="translate(0 14)">${shape(fill)}</g></svg>`;

const backup = (f) => { if (!fs.existsSync(f)) return; const d = BACK + "/" + f.replace(/[:\\/]/g, "_"); if (!fs.existsSync(d)) fs.copyFileSync(f, d); };
const put = (f, data) => { backup(f); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); console.log("wrote", f); };

// ---- clean copies of the logo (centred) ----
fs.writeFileSync(OUT + "/eta-logo-white.svg", square("#FFFFFF"));
fs.writeFileSync(OUT + "/eta-logo-black.svg", square("#000000"));
const render = (svg, size, bg) => {
  let s = sharp(Buffer.from(svg), { density: 300 }).resize(size, size);
  if (bg) s = s.flatten({ background: bg });
  return s.png().toBuffer();
};
for (const [name, fill] of [["white", "#FFFFFF"], ["black", "#000000"]]) fs.writeFileSync(`${OUT}/eta-logo-${name}-transparent-1024.png`, await render(square(fill), 1024));

// app icon: logo on a dark square with room around it
const iconSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}"><rect width="512" height="512" rx="104" fill="#0d0e12"/><g transform="translate(76 76) scale(1.0982)"><g transform="translate(0 14)">${shape("#FFFFFF")}</g></g></svg>`;
fs.writeFileSync(OUT + "/eta-app-icon.svg", iconSvg(512));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = []; for (const s of sizes) frames.push({ s, buf: await sharp(Buffer.from(iconSvg(512)), { density: 300 }).resize(s, s).png().toBuffer() });
fs.writeFileSync(OUT + "/eta-app-icon-512.png", await sharp(Buffer.from(iconSvg(512)), { density: 300 }).resize(512, 512).png().toBuffer());
// ICO file with PNG frames
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4);
let off = 6 + 16 * frames.length; const dir = []; for (const f of frames) { const e = Buffer.alloc(16); e[0] = f.s >= 256 ? 0 : f.s; e[1] = f.s >= 256 ? 0 : f.s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(f.buf.length, 8); e.writeUInt32LE(off, 12); off += f.buf.length; dir.push(e); }
fs.writeFileSync(OUT + "/eta-app-icon.ico", Buffer.concat([head, ...dir, ...frames.map((f) => f.buf)]));
console.log("brand files written to", OUT);

// ---- 1. activity bar icon of the agent extension ----
put(APP + "/extensions/eta-agent/media/eta.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-24 -24 435 435" width="24" height="24" fill="currentColor"><title>Eta IDE</title><g transform="translate(0 14)">${shape("currentColor")}</g></svg>\n`);

// ---- 2. editor watermark and code icon ----
const mark = (fill, op) => `<svg viewBox="0 0 387 387" xmlns="http://www.w3.org/2000/svg"><g opacity="${op}" transform="translate(0 14)">${shape(fill)}</g></svg>`;
put(APP + "/out/media/letterpress-dark.svg", mark("#FFFFFF", ".12"));
put(APP + "/out/media/letterpress-light.svg", mark("#000000", ".09"));
put(APP + "/out/media/letterpress-hcDark.svg", mark("#3C3C3C", "1"));
put(APP + "/out/media/letterpress-hcLight.svg", mark("#BBBBBB", "1"));
put(APP + "/out/media/code-icon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="104" fill="#0d0e12"/><g transform="translate(76 76) scale(1.0982)"><g transform="translate(0 14)">${shape("#FFFFFF")}</g></g></svg>`);

// ---- 3. Windows tiles + manifest ----
for (const [n, s] of [["150x150", 150], ["70x70", 70]]) put(`${APP}/resources/win32/code_${n}.png`, await sharp(Buffer.from(square("#FFFFFF")), { density: 300 }).resize(Math.round(s * 0.62), Math.round(s * 0.62)).extend({ top: Math.floor(s * 0.19), bottom: Math.ceil(s * 0.19), left: Math.floor(s * 0.19), right: Math.ceil(s * 0.19), background: { r: 0, g: 0, b: 0, alpha: 0 } }).resize(s, s).png().toBuffer());
const man = ROOT + "/dist/Eta-IDE/Eta IDE.VisualElementsManifest.xml";
backup(man); fs.writeFileSync(man, fs.readFileSync(man, "utf8").replace('ShortDisplayName="Code - OSS"', 'ShortDisplayName="Eta IDE"'));

// ---- 4. the agent panel (header mark, chat welcome mark, browser tab icon) ----
const maskSvg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 387 387'><g transform='translate(0 14)'>${shape("#000").replace(/"/g, "'")}</g></svg>`;
const maskUrl = "url(\"data:image/svg+xml," + encodeURIComponent(maskSvg).replace(/'/g, "%27") + "\")";
const favSvg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><rect width='512' height='512' rx='104' fill='#0d0e12'/><g transform='translate(76 76) scale(1.0982)'><g transform='translate(0 14)'>${shape("#fff").replace(/"/g, "'")}</g></g></svg>`;
const favUrl = "data:image/svg+xml," + encodeURIComponent(favSvg).replace(/'/g, "%27");
const css = `/* eta logo */\n.brand .mk,.cn-mk{background:var(--txt,currentColor)!important;-webkit-mask:${maskUrl} center/contain no-repeat;mask:${maskUrl} center/contain no-repeat;border-radius:0!important;box-shadow:none!important}\n.brand .mk{width:17px;height:17px}\n.cn-mk{width:44px;height:44px}\n`;
for (const f of [ROOT + "/console/ui.html", APP + "/extensions/eta-agent/console/ui.html"]) {
  const raw = fs.readFileSync(f, "utf8"); const crlf = raw.includes("\r\n"); let s = raw.replace(/\r\n/g, "\n");
  if (s.includes("/* eta logo */")) { s = s.replace(/\/\* eta logo \*\/[\s\S]*?\.cn-mk\{width:44px;height:44px\}\n/, () => css); }
  else { const i = s.indexOf("</style>"); if (i < 0) throw new Error("no </style> in " + f); s = s.slice(0, i) + css + s.slice(i); }
  s = s.replace(/<link rel="icon" href="[^"]*"[^>]*>/, () => `<link rel="icon" href="${favUrl}">`);
  backup(f); fs.writeFileSync(f, crlf ? s.replace(/\n/g, "\r\n") : s); console.log("patched", f);
}
console.log("DONE");
