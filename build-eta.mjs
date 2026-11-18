// Eta IDE build: a ready-built VSCodium (the base) + the Eta layer (identity, agent, engine, brand). Gokul, 2026-11-10:
// "updates need to change only the base, never Eta". A new base = download the newest VSCodium zip, unzip it, run this again.
//
//   node build-eta.mjs <unzipped VSCodium folder> [output folder]
//
// Every change to VS Code's own code finds its place by VS Code's setting names and texts, never by the short minified
// names (they change in every version). If a place is not found exactly as expected, the build STOPS with the reason,
// so a new base can never break Eta silently.
import fs from "fs"; import path from "path"; import { spawnSync } from "child_process"; import { fileURLToPath } from "url"; import { createRequire } from "module";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] && path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3] || path.join(ROOT, "build", "Eta-IDE"));
const LAYER = path.join(ROOT, "eta-layer");          // Eta's own files that are not in /console (frozen once from the old build)
const OLD = path.join(ROOT, "dist", "Eta-IDE");      // only used to make the layer the first time
const RCEDIT = process.env.RCEDIT || path.join(ROOT, "ide-patches", "tools", "rcedit-x64.exe");
const YEAR = new Date().getFullYear();
const LANG_EXTS = ["detachhead.basedpyright", "golang.go", "llvm-vs-code-extensions.vscode-clangd", "ms-python.debugpy", "muhammad-sammy.csharp", "rust-lang.rust-analyzer"];

const log = (...a) => console.log(...a);
const fail = (m) => { console.error("\nBUILD STOPPED: " + m); process.exit(1); };
const rd = (f) => fs.readFileSync(f, "utf8");
const cp = (a, b, filter) => fs.cpSync(a, b, { recursive: true, filter });
if (!BASE || !fs.existsSync(path.join(BASE, "resources", "app", "product.json"))) fail("give the unzipped VSCodium folder (it must have resources/app/product.json)");
if (OUT.startsWith(OLD)) fail("the output must not be the old build folder");

// ---------- 0. the Eta layer (made once) ----------
if (!fs.existsSync(LAYER)) {
  log("making eta-layer from the old build (one time)");
  const OA = path.join(OLD, "resources", "app");
  cp(path.join(OA, "extensions", "eta-agent"), path.join(LAYER, "eta-agent"), (s) => !s.includes(path.join("eta-agent", "console")));
  for (const e of LANG_EXTS) cp(path.join(OA, "extensions", e), path.join(LAYER, "lang", e));
  for (const f of ["out/media/letterpress-dark.svg", "out/media/letterpress-light.svg", "out/media/letterpress-hcDark.svg", "out/media/letterpress-hcLight.svg",
    "out/media/code-icon.svg", "resources/win32/code_150x150.png", "resources/win32/code_70x70.png"]) cp(path.join(OA, f), path.join(LAYER, "brand", f));
  const tpn = rd(path.join(OA, "ThirdPartyNotices.txt")); const i = tpn.indexOf("Streaming engine used by Eta Engine");
  if (i < 0) fail("Eta section not found in the old ThirdPartyNotices.txt");
  fs.writeFileSync(path.join(LAYER, "third-party-eta.txt"), "\n" + tpn.slice(tpn.lastIndexOf("====", i) - 76));
}

// ---------- 1. fresh copy of the base ----------
const base = JSON.parse(rd(path.join(BASE, "resources", "app", "product.json")));
log(`base: VSCodium ${base.version}  ->  ${OUT}`);
if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
cp(BASE, OUT);
const A = path.join(OUT, "resources", "app");
fs.renameSync(path.join(OUT, "VSCodium.exe"), path.join(OUT, "Eta IDE.exe"));
const vem = path.join(OUT, "VSCodium.VisualElementsManifest.xml");
fs.writeFileSync(path.join(OUT, "Eta IDE.VisualElementsManifest.xml"), rd(vem).replace(/ShortDisplayName="[^"]*"/, 'ShortDisplayName="Eta IDE"').replace(/BackgroundColor="[^"]*"/, 'BackgroundColor="#000000"')); fs.rmSync(vem);
const bin = path.join(OUT, "bin");
fs.writeFileSync(path.join(bin, "eta-ide.cmd"), rd(path.join(bin, "codium.cmd")).replace(/VSCodium\.exe/g, "Eta IDE.exe"));
fs.writeFileSync(path.join(bin, "eta-ide"), rd(path.join(bin, "codium")).replace(/^APP_NAME=.*$/m, 'APP_NAME="eta-ide"').replace(/^NAME=.*$/m, 'NAME="Eta IDE"').replace(/^SERVERDATAFOLDER=.*$/m, 'SERVERDATAFOLDER=".eta-ide-server-oss"'));
for (const f of ["codium.cmd", "codium", "codium-tunnel.exe"]) fs.rmSync(path.join(bin, f), { force: true }); // the tunnel tool carries VSCodium's own name inside
fs.rmSync(path.join(OUT, "policies"), { recursive: true, force: true });
log("1. base copied, program renamed to Eta IDE.exe");

// ---------- 2. product.json: Eta identity on the new base ----------
const ETA = {
  nameShort: "Eta IDE", nameLong: "Eta IDE", applicationName: "eta-ide", dataFolderName: ".eta-ide", sharedDataFolderName: ".eta-ide-shared",
  serverApplicationName: "eta-ide-server-oss", serverDataFolderName: ".eta-ide-server-oss", tunnelApplicationName: "eta-ide-tunnel-oss",
  win32DirName: "Eta IDE", win32NameVersion: "Eta IDE", win32RegValueName: "EtaIDE", win32ShellNameShort: "Eta IDE", win32AppUserModelId: "26io.EtaIDE",
  win32MutexName: "etaide", win32TunnelMutex: "etaideoss-tunnel", win32TunnelServiceMutex: "etaideoss-tunnelservice",
  win32AppId: "{{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}", win32x64AppId: "{{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}", win32arm64AppId: "{{D1ACE434-89C5-48D1-88D3-E2991DF85475}",
  win32UserAppId: "{{CC6B787D-37A0-49E8-AE24-8559A032BE0C}", win32x64UserAppId: "{{CC6B787D-37A0-49E8-AE24-8559A032BE0C}", win32arm64UserAppId: "{{3AEBF0C8-F733-4AD4-BADE-FDB816D53D7B}",
  win32ContextMenu: { x64: { clsid: "AF7F4A9D-3A1F-4C92-9DDB-A268A07AA04E" }, arm64: { clsid: "C441F3DB-CB53-4B42-87E0-B5CF7A79C35C" } },
  darwinBundleIdentifier: "io.26.eta-ide", linuxIconName: "eta-ide", urlProtocol: "eta-ide",
  reportIssueUrl: "https://26io.com/contact", downloadUrl: "https://26io.com", licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
  serverLicenseUrl: "https://github.com/microsoft/vscode/blob/main/LICENSE.txt",
  enableTelemetry: false, showTelemetryOptOut: false,
};
const p = { ...base, ...ETA };
// updateUrl: VSCodium's own update address would replace Eta with plain VSCodium. Eta's own address comes later (Cloudflare, needs Gokul's yes).
// checksums: Eta changes workbench files on purpose, so the base's file checks would show "your installation is corrupt".
for (const k of ["updateUrl", "checksums", "serverDownloadUrlTemplate", "configurationDefaults", "releaseNotesUrl"]) delete p[k];
// Microsoft / GitHub Copilot ADDRESSES from the base (removed 2026-11-15): Microsoft help, video and voice links, and every address inside defaultChatAgent.
// Only the addresses go. Deleting defaultChatAgent itself (or trustedExtensionAuthAccess) left the window empty and black (tested 2026-11-15).
for (const k of ["voiceWsUrl", "checksumFailMoreInfoUrl", "documentationUrl", "introductoryVideosUrl", "keyboardShortcutsUrlLinux", "keyboardShortcutsUrlMac", "keyboardShortcutsUrlWin", "requestFeatureUrl", "tipsAndTricksUrl", "twitterUrl"]) delete p[k];
if (p.defaultChatAgent) for (const k of Object.keys(p.defaultChatAgent)) if (/url/i.test(k)) delete p.defaultChatAgent[k];
// releaseNotesUrl: the base points it at Microsoft's Visual Studio Code release notes, which opened in a tab at start (2026-11-15). Removed; Eta's own address can be set with ETA_RELEASE_NOTES_URL.
if (process.env.ETA_RELEASE_NOTES_URL) p.releaseNotesUrl = process.env.ETA_RELEASE_NOTES_URL;
// Must stay a list: removing the key stops ALL extensions from loading ("not iterable", found 2026-11-10). Empty = no Copilot auto-updates.
p.builtInExtensionsEnabledWithAutoUpdates = [];
if (process.env.ETA_UPDATE_URL) p.updateUrl = process.env.ETA_UPDATE_URL;
p.onboardingThemes = [{ id: "eta-black", label: "Eta Black", themeId: "Eta Black", type: "dark" }, ...(base.onboardingThemes || [])];
fs.writeFileSync(path.join(A, "product.json"), JSON.stringify(p, null, "\t"));
log("2. product.json: Eta names, no VSCodium update address, no file checks");

// ---------- 3. VS Code core changes (anchored by names, stop if not found) ----------
const WB = path.join(A, "out", "vs", "workbench", "workbench.desktop.main.js");
let w = rd(WB);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function once(name, re, to) {
  const m = w.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (!m || m.length !== 1) fail(`core change "${name}": expected 1 place, found ${m ? m.length : 0}. VS Code changed this part; update build-eta.mjs.`);
  w = w.replace(re, to); log("   ok", name);
}
const varOf = (key) => { const m = w.match(new RegExp(`([A-Za-z_$][\\w$]*)="${esc(key)}"`)); if (!m) fail(`setting name "${key}" not found`); return m[1]; };
// (05) no "Do you trust the authors" question: the agent opens many folders, and the question blocks the first run.
const trust = varOf("security.workspace.trust.enabled");
once("trust prompt off", new RegExp(`(\\[${esc(trust)}\\]:\\{type:"boolean",default:)!0`), "$1!1");
// (03) no welcome page, no walkthrough on install, Eta Black as the default dark theme.
once("no welcome page", /("workbench\.startupEditor":\{scope:\d+,type:"string",enum:\[[^\]]*\],enumDescriptions:\[[^\]]*\],default:)"welcomePage"/, '$1"none"');
once("no walkthrough on install", /("workbench\.welcomePage\.walkthroughs\.openOnInstall":\{scope:\d+,type:"boolean",default:)!0/, "$1!1");
once("Eta Black theme", /(\.COLOR_THEME_DARK=)"[^"]+"/, '$1"Eta Black"');
// (06) removed 2026-11-10: two Agent panel width changes had no effect in 1.143, and Gokul approved the standard width
// ("the panel is good"). Removed so a future base update cannot fail the build on them.
fs.writeFileSync(WB, w);
// (02) the right bar shows only the Agent, without its own tab row.
const CSS = path.join(A, "out", "vs", "workbench", "workbench.desktop.main.css");
fs.appendFileSync(CSS, "\n/*eta-ide*/.monaco-workbench .part.auxiliarybar>.title>.composite-bar-container{display:none!important}\n" +
  // 1.143 adds its own "maximize" button above the Agent; Eta has its own full-screen button, so two looked doubled (Gokul, 2026-11-10).
  ".monaco-workbench .part.auxiliarybar>.title .action-item:has(.codicon-auxiliarybar-maximize){display:none!important}\n");
// (10, 32) texts users read: "Hide Agent Panel", Eta IDE instead of Visual Studio Code, Chat instead of Copilot.
const NLS = path.join(A, "out", "nls.messages.json");
let msgs = JSON.parse(rd(NLS)); let nHide = 0, nName = 0, nCop = 0;
msgs = msgs.map((s) => typeof s !== "string" ? s : s
  .replace(/Hide Secondary Side Bar/g, () => (nHide++, "Hide Agent Panel"))
  .replace(/Visual Studio Code/g, () => (nName++, "Eta IDE"))
  .replace(/GitHub Copilot Chat|GitHub Copilot|Copilot Chat|Copilot/g, () => (nCop++, "Chat")));
fs.writeFileSync(NLS, JSON.stringify(msgs));
w = rd(WB); const before = w;
w = w.replace(/"Hide Secondary Side Bar"/g, () => (nHide++, '"Hide Agent Panel"')).replace(/Visual Studio Code/g, () => (nName++, "Eta IDE"));
if (w !== before) fs.writeFileSync(WB, w);
if (!nHide) fail('"Hide Secondary Side Bar" text not found');
log(`3. core: 4 changes, texts: ${nHide} hide, ${nName} product name, ${nCop} Copilot`);

// ---------- 4. Eta extensions ----------
const EXT = path.join(A, "extensions");
// The extension is built here from its source in extension/ (2026-11-10: before, a built file was copied from the old
// build, so the published source and the shipped program could drift apart).
const XS = path.join(ROOT, "extension"), XO = path.join(EXT, "eta-agent");
if (!fs.existsSync(path.join(XS, "node_modules", "esbuild"))) fail("the extension's build tools are missing: run \"npm ci\" in the extension folder");
for (const f of ["package.json", "LICENSE", "NOTICE", "media", "themes"]) cp(path.join(XS, f), path.join(XO, f));
{ const esb = createRequire(path.join(XS, "package.json"))("esbuild");
  esb.buildSync({ entryPoints: [path.join(XS, "src", "extension.ts")], bundle: true, format: "cjs", platform: "node", target: "node18",
    outfile: path.join(XO, "dist", "extension.js"), external: ["vscode", "playwright-core"], minify: true, logLevel: "error" }); }
for (const e of LANG_EXTS) cp(path.join(LAYER, "lang", e), path.join(EXT, e));
const SKIP = /[\\/](\.hf-cache|\.sys-sandbox|\.test-sandbox|\.eta|\.git)([\\/]|$)|[\\/](test-[^\\/]*|uitest|genimgs|hardimg\d*)\.mjs$|[\\/]drive-kanban\.cjs$|\.log$/;
cp(path.join(ROOT, "console"), path.join(EXT, "eta-agent", "console"), (s) => !SKIP.test(s));
// Python for Eta Engine (UPGRADE E1, 2026-11-13). The engine's launcher needs Python 3 (standard library only). Without it a PC that has no
// Python failed on the first start. We ship python.org's "embeddable" package (about 11 MB, 22 MB unpacked, PSF licence) in console/python.
// Pinned: exact version, size and SHA-256 (checked when the build downloads it; also published on python.org). 3.13.17 is the last 3.13
// release with Windows binaries (3.13.18 is source only). To update: change the three values below and run the build.
const PYV = { version: "3.13.17", size: 11441267, sha256: "9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38" };
{ const { createHash } = await import("crypto");
  const zip = path.join(LAYER, "python", `python-${PYV.version}-embed-amd64.zip`);
  const sum = () => createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  if (!fs.existsSync(zip) || sum() !== PYV.sha256) {
    fs.mkdirSync(path.dirname(zip), { recursive: true });
    const url = `https://www.python.org/ftp/python/${PYV.version}/python-${PYV.version}-embed-amd64.zip`;
    log("   downloading " + url);
    const res = await fetch(url); if (!res.ok) fail(`Python download failed: HTTP ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    if (sum() !== PYV.sha256) { fs.rmSync(zip, { force: true }); fail("the Python download does not match the pinned SHA-256 (deleted). Check PYV in build-eta.mjs."); }
  }
  const PYD = path.join(EXT, "eta-agent", "console", "python");
  fs.rmSync(PYD, { recursive: true, force: true });
  const AdmZip = createRequire(path.join(ROOT, "console", "package.json"))("adm-zip");
  new AdmZip(zip).extractAllTo(PYD, true);
  if (!fs.existsSync(path.join(PYD, "python.exe"))) fail("Python unpacked but python.exe is missing");
  const t = spawnSync(path.join(PYD, "python.exe"), ["-I", "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", timeout: 20000 });
  if (t.status !== 0 || String(t.stdout).trim() !== "3") fail("the bundled Python does not start: " + (t.stderr || t.error));
  log(`   Python ${PYV.version} bundled in console/python and started once`); }
// Smaller download: only the Windows x64 copy of onnxruntime-node (the Mac, Linux and ARM copies were 153 MB), and no
// source-map files (.map, only for developers). Only the build copy changes, never console/.
const NM = path.join(EXT, "eta-agent", "console", "node_modules"); let cut = 0;
const rmCount = (p) => { if (!fs.existsSync(p)) return; for (const f of fs.readdirSync(p, { recursive: true })) { try { const s = fs.statSync(path.join(p, f)); if (s.isFile()) cut += s.size; } catch {} } fs.rmSync(p, { recursive: true, force: true }); };
const ORT = path.join(NM, "onnxruntime-node", "bin");
if (fs.existsSync(ORT)) for (const napi of fs.readdirSync(ORT)) { for (const os_ of ["darwin", "linux"]) rmCount(path.join(ORT, napi, os_)); rmCount(path.join(ORT, napi, "win32", "arm64")); }
for (const f of fs.readdirSync(NM, { recursive: true })) if (String(f).endsWith(".map")) { const p = path.join(NM, f); try { cut += fs.statSync(p).size; fs.rmSync(p); } catch {} }
// Jest snapshot folders are test data. Their file names are very long: with the install folder in front they passed Windows' 260-character limit and the
// installer stopped with "MoveFile failed; code 3" (found 2026-11-14). Not needed to run, so they are not shipped.
for (const f of fs.readdirSync(NM, { recursive: true })) if (/(^|[\\/])__(image_)?snapshots__$/.test(String(f))) rmCount(path.join(NM, String(f)));
log(`   smaller: ${Math.round(cut / 1048576)} MB of other-system copies and map files removed`);
// (01) The new base lets an extension live in the right bar itself, so no core change is needed for this any more.
const pjf = path.join(EXT, "eta-agent", "package.json"); const pj = JSON.parse(rd(pjf));
const vc = pj.contributes.viewsContainers;
if (vc.activitybar) { vc.secondarySidebar = vc.activitybar; delete vc.activitybar; }
pj.contributes.configurationDefaults = { ...(pj.contributes.configurationDefaults || {}),
  "workbench.startupEditor": "none", "chat.commandCenter.enabled": false, "workbench.panel.defaultLocation": "bottom" };
fs.writeFileSync(pjf, JSON.stringify(pj, null, 2) + "\n");
log("4. eta-agent + console + 6 language helpers copied; Agent lives in the right bar");

// ---------- 5. brand, licences, program file ----------
cp(path.join(LAYER, "brand"), A);
for (const f of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
fs.appendFileSync(path.join(A, "ThirdPartyNotices.txt"), rd(path.join(LAYER, "third-party-eta.txt")));
const ico = path.join(ROOT, "brand", "eta-app-icon.ico");
if (!fs.existsSync(RCEDIT)) fail("rcedit not found: " + RCEDIT);
const r = spawnSync(RCEDIT, [path.join(OUT, "Eta IDE.exe"), "--set-icon", ico, "--set-version-string", "CompanyName", "26io Techlab", "--set-version-string", "ProductName", "Eta IDE",
  "--set-version-string", "FileDescription", "Eta IDE", "--set-version-string", "LegalCopyright", `Copyright (C) ${YEAR} 26io Techlab`,
  "--set-version-string", "OriginalFilename", "Eta IDE.exe", "--set-version-string", "InternalName", "Eta IDE"], { encoding: "utf8" });
if (r.status !== 0) fail("rcedit failed: " + (r.stderr || r.error));
log("5. logo, LICENSE, NOTICE, notices, program file properties");

// ---------- 6. checks ----------
const left = [];
const pf = rd(path.join(A, "product.json"));
for (const bad of ["VSCodium.VSCodium", "\"codium\"", "raw.githubusercontent.com/VSCodium", "\"nameShort\": \"VSCodium\""]) if (pf.includes(bad)) left.push("product.json has " + bad);
if (/api\.github\.com\/copilot|aka\.ms\/|go\.microsoft\.com\/fwlink/i.test(pf)) left.push("product.json still has Copilot or Microsoft help addresses");
if (/releaseNotesUrl[^,]*microsoft/i.test(pf)) left.push("product.json still points release notes at Microsoft");
if (!rd(WB).includes('"Eta Black"')) left.push("theme change missing");
if (!fs.existsSync(path.join(EXT, "eta-agent", "console", "engine", "coli"))) left.push("Eta Engine missing in console/engine");
if (!fs.existsSync(path.join(EXT, "eta-agent", "console", "python", "python.exe"))) left.push("bundled Python missing in console/python");
{ // B4: the engine that ships must be exactly the pinned one (console/engine-pin.json; update it on purpose with: node console/engine-pin.mjs write)
  const { checkPin, readPin } = await import("./console/engine-pin.mjs");
  const r = checkPin(path.join(EXT, "eta-agent", "console", "engine"), readPin());
  if (!r.ok) left.push("the engine differs from the pin (console/engine-pin.json): " + r.problems.slice(0, 5).join("; "));
}
if (!fs.existsSync(path.join(EXT, "eta-agent", "dist", "extension.js"))) left.push("agent extension.js missing");
if (!fs.existsSync(path.join(EXT, "eta-agent", "themes", "eta-black.json"))) left.push("Eta Black theme file missing");
for (const f of fs.readdirSync(OUT)) if (/vscodium|codium/i.test(f)) left.push("file name with VSCodium: " + f);
{ // longest file path inside the app. The install folder goes in front of it and Windows allows 260 in total (Inno Setup is not long-path aware).
  let longest = 0, which = ''; for (const f of fs.readdirSync(OUT, { recursive: true })) { const n = String(f).length + 1; if (n > longest) { longest = n; which = String(f); } }
  log(`   longest path inside the app: ${longest} characters (an install folder up to ${259 - longest} characters is safe)`);
  if (longest > 200) left.push(`a file path inside the app is ${longest} characters (limit 200), the installer would fail on normal PCs: ${which.slice(0, 120)}`);
}
if (left.length) fail("checks:\n  " + left.join("\n  "));
fs.writeFileSync(path.join(OUT, "eta-build.json"), JSON.stringify({ base: "VSCodium " + base.version, commit: base.commit, built: new Date().toISOString() }, null, 2));
log(`6. checks passed\nDONE: Eta IDE on VSCodium ${base.version} in ${OUT}`);
