// Eta IDE extension — THIN CLIENT over the battle-tested console engine.
// The extension's only jobs: (1) spawn the engine (console/server.mjs) as a
// child process, (2) host the engine's full UI in a webview (iframe), (3) offer
// VS Code niceties (commands, split browser). All agent logic, verification,
// knowledge and chat live in the engine — ONE brain, many shells.
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as http from "http";
import { spawn, ChildProcess, execSync } from "child_process";
import { EtaBrowserPanel } from "./browserPanel";

const PORT = 8713; // dedicated port: never collides with the standalone app (8712)
const LSP_PORT = PORT + 1; // 8714 — the extension's language-intelligence bridge
let engine: ChildProcess | null = null;
let lspServer: http.Server | null = null;
let quitting = false;

function engineDir(context: vscode.ExtensionContext): string | null {
  const cfg = vscode.workspace.getConfiguration("eta").get<string>("enginePath", "");
  const candidates = [
    cfg,
    path.join(context.extensionPath, "console"),          // bundled (fork/production)
    "d:\\eta-ide\\console",                               // dev fallback on this machine
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(path.join(c, "server.mjs"))) return c;
  return null;
}

function startEngine(context: vscode.ExtensionContext) {
  const dir = engineDir(context);
  if (!dir) { vscode.window.showErrorMessage("Eta: engine not found (set eta.enginePath to the console folder)."); return; }
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(PORT), ETA_LSP_BRIDGE: `http://127.0.0.1:${LSP_PORT}` };
  engine = spawn(process.execPath, [path.join(dir, "server.mjs")], { env, cwd: dir });
  engine.stdout?.on("data", (d) => console.log("[eta-engine] " + d));
  engine.stderr?.on("data", (d) => console.log("[eta-engine] " + d));
  engine.on("exit", () => { if (!quitting) setTimeout(() => { if (!quitting) startEngine(context); }, 1200); });
}

function killEngine() {
  quitting = true;
  if (!engine) return;
  const pid = engine.pid; engine = null;
  try {
    if (process.platform === "win32" && pid) execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    else if (pid) process.kill(pid);
  } catch { /* already gone */ }
}

function waitForEngine(tries = 60): Promise<boolean> {
  return new Promise((resolve) => {
    const ping = (left: number) => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => { res.destroy(); resolve(true); });
      req.on("error", () => (left > 0 ? setTimeout(() => ping(left - 1), 400) : resolve(false)));
    };
    ping(tries);
  });
}

// POST JSON to the local engine and parse the JSON reply.
function enginePost(pathname: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      let body = ""; res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

// The embedded agent panel opens files in the REAL editor via postMessage. Shared by the
// sidebar view AND the full-tab Manager view so both behave identically.
function wireOpenFileRelay(webview: vscode.Webview, extUri?: vscode.Uri) {
  webview.onDidReceiveMessage(async (m: { eta?: string; path?: string; line?: number }) => {
    // FULL SCREEN button in the panel header → reopen the agent as a full editor tab.
    if (m?.eta === "fullscreen") { if (extUri) EtaManagerPanel.show(extUri); return; }
    if (m?.eta !== "open" || !m.path) return;
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      const fp = path.isAbsolute(m.path) ? m.path : path.join(root, m.path);
      const doc = await vscode.workspace.openTextDocument(fp);
      const ed = await vscode.window.showTextDocument(doc, { preview: true });
      if (m.line) {
        const pos = new vscode.Position(Math.max(0, Number(m.line) - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch { /* file missing or unreadable — nothing to open */ }
  });
}

class EtaPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "eta.agent";
  constructor(private readonly context: vscode.ExtensionContext) {}
  async resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true };
    view.webview.html = loadingHtml();
    wireOpenFileRelay(view.webview, this.context.extensionUri);
    const up = await waitForEngine();
    view.webview.html = up ? frameHtml() : failHtml();
  }
}

// MANAGER VIEW — the same agent surface opened as a FULL EDITOR TAB instead of the ~420px
// sidebar strip. Antigravity patched VS Code's core to add its "Manager" mission-control
// view; we get the same real estate with a plain WebviewPanel — no core patching, so we
// still rebase cleanly on upstream VS Code. Singleton: reveal if it already exists.
class EtaManagerPanel {
  private static current: EtaManagerPanel | undefined;
  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => {
      if (EtaManagerPanel.current === this) EtaManagerPanel.current = undefined;
      // give the docked panel back when the full-screen tab is closed
      vscode.commands.executeCommand("eta.agent.focus").then(undefined, () => { /* view may be gone */ });
    });
  }
  static async show(extUri: vscode.Uri) {
    if (EtaManagerPanel.current) { EtaManagerPanel.current.panel.dispose(); return; } // toggle: closing the tab brings the side panel back (see onDidDispose)
    // FULL SCREEN means full screen. The Eta view is docked in the AUXILIARY BAR (right),
    // so without this the same chat renders TWICE and the new tab is squeezed into a narrow
    // column — worse than before. Close the docked copy so the tab gets the whole editor area.
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => { /* already closed */ });
    const panel = vscode.window.createWebviewPanel(
      "etaManager", "Eta Manager",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    try { panel.iconPath = vscode.Uri.joinPath(extUri, "media", "eta.svg"); } catch { /* icon optional */ }
    panel.webview.html = loadingHtml();
    wireOpenFileRelay(panel.webview, extUri);
    EtaManagerPanel.current = new EtaManagerPanel(panel);
    const up = await waitForEngine();
    panel.webview.html = up ? frameHtml() : failHtml();
  }
}

function loadingHtml() {
  return `<!doctype html><html><body style="background:#131318;color:#9d9dab;font:13px 'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">starting the Eta engine…</body></html>`;
}
function failHtml() {
  return `<!doctype html><html><body style="background:#131318;color:#f48771;font:13px 'Segoe UI',sans-serif;padding:20px">Eta engine did not start on :${PORT}. Check the extension host log.</body></html>`;
}
function frameHtml() {
  // The engine serves the AGENT PANEL (?embed=1 = chat/plan/agents only — VS Code
  // itself is the IDE); workspace comes from VS Code's folder. The inline script
  // (1) relays the panel's open-file requests up to the extension host, and
  // (2) THEME BRIDGE: reads the host's live --vscode-* palette + fonts and forwards
  // them into the cross-origin iframe (which can't read them itself), re-sending
  // whenever VS Code swaps the color theme — so the panel matches native chrome.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:${PORT}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>html,body{height:100%;margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e)}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="f" src="http://127.0.0.1:${PORT}/?embed=1&ws=${encodeURIComponent(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "")}"></iframe>
<script>
const api=acquireVsCodeApi(), f=document.getElementById("f");
function readTheme(){
  const cs=getComputedStyle(document.documentElement), g=(...n)=>{for(const x of n){const v=cs.getPropertyValue(x).trim();if(v)return v;}return "";};
  const cls=document.body.className||"";
  const kind=cls.indexOf("vscode-light")>=0?"light":(cls.indexOf("vscode-high-contrast")>=0&&cls.indexOf("vscode-high-contrast-light")<0?"dark":(cls.indexOf("vscode-high-contrast-light")>=0?"light":"dark"));
  return {kind,colors:{
    editor:g("--vscode-sideBar-background","--vscode-editor-background"),
    chrome:g("--vscode-sideBarSectionHeader-background","--vscode-editorGroupHeader-tabsBackground","--vscode-editorWidget-background"),
    card:g("--vscode-editorWidget-background","--vscode-editor-background"),
    elev:g("--vscode-editorHoverWidget-background","--vscode-editorWidget-background"),
    txt:g("--vscode-foreground","--vscode-editor-foreground"),
    txt2:g("--vscode-descriptionForeground","--vscode-foreground"),
    txt3:g("--vscode-disabledForeground","--vscode-descriptionForeground"),
    border:g("--vscode-panel-border","--vscode-widget-border","--vscode-editorWidget-border"),
    border2:g("--vscode-focusBorder","--vscode-contrastBorder"),
    accent:g("--vscode-button-background","--vscode-textLink-foreground","--vscode-focusBorder"),
    accent2:g("--vscode-textLink-activeForeground","--vscode-button-hoverBackground","--vscode-textLink-foreground"),
    green:g("--vscode-charts-green","--vscode-testing-iconPassed","--vscode-terminal-ansiGreen"),
    red:g("--vscode-charts-red","--vscode-errorForeground","--vscode-terminal-ansiRed"),
    amber:g("--vscode-charts-yellow","--vscode-editorWarning-foreground","--vscode-terminal-ansiYellow"),
    inputBg:g("--vscode-input-background"),
    btnFg:g("--vscode-button-foreground"),
    font:g("--vscode-font-family"),
    mono:g("--vscode-editor-font-family")
  }};
}
function push(){ try{ f.contentWindow.postMessage({etaTheme:readTheme()},"*"); }catch(e){} }
window.addEventListener("message",e=>{ const d=e.data||{}; if(d.eta==="ready"){ push(); return; } if(d.eta){ api.postMessage(d); } });
f.addEventListener("load",push);
new MutationObserver(push).observe(document.documentElement,{attributes:true,attributeFilter:["style","class"]});
new MutationObserver(push).observe(document.body,{attributes:true,attributeFilter:["class"]});
</script></body></html>`;
}

// ---- Language-intelligence bridge --------------------------------------------
// The engine (agent) can't call VS Code APIs directly — it's a child process. So
// the extension hosts a tiny HTTP server that answers the agent's language queries
// using VS Code's OWN language providers. This is the "easy way": VS Code already
// runs the language servers; we just read their results and hand them to the agent.
function lspUri(rel: string): vscode.Uri | null {
  if (!rel) return null;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  return vscode.Uri.file(path.isAbsolute(rel) ? rel : path.join(root, rel));
}
function waitForDiagnostics(uri: vscode.Uri, cap = 2200): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; sub.dispose(); clearTimeout(t); resolve(); };
    const sub = vscode.languages.onDidChangeDiagnostics((e) => { if (e.uris.some((u) => u.toString() === uri.toString())) finish(); });
    const t = setTimeout(finish, cap);
  });
}
// LIVE EDITOR RECONCILIATION. The engine writes files straight to disk and then asks
// this bridge for diagnostics — so a diagnostics request is a reliable "the agent just
// wrote this file" signal. If an editor for that file is holding a STALE buffer that
// differs from what the agent just wrote, quietly bring it in line with disk so it can
// neither show wrong content nor later clobber the agent's write. Fully non-destructive:
// it is a no-op unless the buffer is dirty AND differs from disk (VS Code already
// auto-reloads clean editors), and it matches the disk the agent authored, not a guess.
async function reconcileEditorToDisk(uri: vscode.Uri) {
  try {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (!doc || !doc.isDirty) return;                 // clean editors auto-reload — nothing to do
    let disk: string;
    try { disk = fs.readFileSync(uri.fsPath, "utf8"); } catch { return; } // file gone — leave the buffer
    if (doc.getText() === disk) return;               // already in sync
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), disk);
    if (await vscode.workspace.applyEdit(edit)) await doc.save(); // adopt disk + clear the dirty flag
  } catch { /* best-effort; never block diagnostics */ }
}

async function lspDiagnostics(rel: string) {
  const uri = lspUri(rel); if (!uri) return { diagnostics: [] };
  try {
    await reconcileEditorToDisk(uri);             // keep an open editor in step with the agent's write
    await vscode.workspace.openTextDocument(uri); // loads + triggers linting (not shown to the user)
    if (vscode.languages.getDiagnostics(uri).length === 0) await waitForDiagnostics(uri);
    const sev = ["error", "warning", "info", "hint"];
    return { diagnostics: vscode.languages.getDiagnostics(uri).map((d) => ({
      severity: sev[d.severity] || "info",
      message: d.message,
      line: d.range.start.line + 1,
      character: d.range.start.character + 1,
      source: d.source || "",
      code: d.code && typeof d.code === "object" ? String((d.code as any).value) : (d.code != null ? String(d.code) : ""),
    })) };
  } catch (e: any) { return { diagnostics: [], error: String(e?.message || e) }; }
}
function findSymbolPos(doc: vscode.TextDocument, symbol: string, nearLine?: number): vscode.Position | null {
  const re = new RegExp("\\b" + symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
  const lines = doc.getText().split("\n");
  const idx = [...lines.keys()];
  if (nearLine) idx.sort((a, b) => Math.abs(a - (nearLine - 1)) - Math.abs(b - (nearLine - 1)));
  for (const i of idx) { const m = re.exec(lines[i]); if (m) return new vscode.Position(i, m.index); }
  return null;
}
async function lspSymbol(op: string, rel: string, symbol: string, nearLine?: number) {
  const uri = lspUri(rel); if (!uri) return op === "hover" ? { hover: "" } : { locations: [] };
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = findSymbolPos(doc, symbol, nearLine);
    if (!pos) return op === "hover" ? { hover: "" } : { locations: [] };
    if (op === "hover") {
      const hs = (await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, pos)) || [];
      const text = hs.flatMap((h) => h.contents.map((c: any) => (typeof c === "string" ? c : c?.value || ""))).join("\n").trim();
      return { hover: text };
    }
    const cmd = op === "references" ? "vscode.executeReferenceProvider" : "vscode.executeDefinitionProvider";
    const raw = (await vscode.commands.executeCommand<any[]>(cmd, uri, pos)) || [];
    const locations = raw.map((l) => {
      const u = l.uri || l.targetUri; const r = l.range || l.targetRange || l.targetSelectionRange;
      return { path: u ? vscode.workspace.asRelativePath(u) : "", line: (r?.start?.line ?? 0) + 1 };
    }).filter((l) => l.path);
    return { locations };
  } catch { return op === "hover" ? { hover: "" } : { locations: [] }; }
}
async function lspRename(rel: string, symbol: string, newName: string, nearLine?: number) {
  const uri = lspUri(rel); if (!uri) return { ok: false, error: "no file" };
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = findSymbolPos(doc, symbol, nearLine);
    if (!pos) return { ok: false, error: `symbol '${symbol}' not found in ${rel}` };
    const wsEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", uri, pos, newName);
    if (!wsEdit || wsEdit.size === 0) return { ok: false, error: "no rename edits produced (is the cursor on a renameable symbol?)" };
    const changedFiles = [...wsEdit.entries()].map(([u]) => vscode.workspace.asRelativePath(u));
    const edits = [...wsEdit.entries()].reduce((n, [, es]) => n + es.length, 0);
    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (applied) await vscode.workspace.saveAll(false);
    return { ok: applied, files: changedFiles.length, edits, changedFiles };
  } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}
function startLspBridge() {
  if (lspServer) return;
  lspServer = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/lsp")) { res.writeHead(404); res.end(); return; }
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let out: any = {};
      try {
        const b = JSON.parse(body || "{}");
        if (b.op === "diagnostics") out = await lspDiagnostics(b.path);
        else if (b.op === "definition" || b.op === "references" || b.op === "hover") out = await lspSymbol(b.op, b.path, b.symbol, b.line);
        else if (b.op === "rename") out = await lspRename(b.path, b.symbol, b.newName, b.line);
        else out = { error: "unknown op" };
      } catch (e: any) { out = { error: String(e?.message || e) }; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
    });
  });
  lspServer.on("error", () => { /* port busy — bridge simply stays down; engine degrades */ });
  lspServer.listen(LSP_PORT, "127.0.0.1");
}

export function activate(context: vscode.ExtensionContext) {
  (globalThis as any).__etaCtx = context; // so importSettings can locate this fork's User dir
  startEngine(context);
  startLspBridge();
  const provider = new EtaPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EtaPanel.viewId, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("eta.newTask", () => vscode.commands.executeCommand("eta.agent.focus")),
    vscode.commands.registerCommand("eta.stop", () => killEngine()),
    vscode.commands.registerCommand("eta.openManager", () => EtaManagerPanel.show(context.extensionUri)),
    vscode.commands.registerCommand("eta.splitBrowser", () => EtaBrowserPanel.show(context.extensionUri)),
    vscode.commands.registerCommand("eta.openBrowser", async () => {
      const url = await vscode.window.showInputBox({ prompt: "URL to open in the split browser", value: "http://localhost:3000" });
      if (url) EtaBrowserPanel.show(context.extensionUri, url);
    }),
    vscode.commands.registerCommand("eta.inlineEdit", () => inlineEdit()),
    vscode.commands.registerCommand("eta.importSettings", () => importSettings()),
  );

  // Agent-first layout: the Eta view is contributed to the AUXILIARY BAR (VS Code's
  // secondary side bar, on the RIGHT) — so it reads as a built-in part of the IDE,
  // not a left-hand extension. On startup we just open that bar and focus the view:
  // Explorer stays left, editor center, Eta docked right — matching the product design.
  // The Eta view's dock location (right-hand Auxiliary Bar) is seeded directly into
  // the workbench's views.customizations storage, so it reads as a built-in part of
  // the IDE — Explorer left, editor center, Eta chat right. On startup we just reveal
  // it (which opens the secondary side bar it now lives in).
  {
    const toggle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    toggle.text = "$(layout-sidebar-right) Agent"; toggle.tooltip = "Show or hide the Agent panel (Ctrl+Alt+A)"; toggle.command = "eta.togglePanel"; toggle.show();
    context.subscriptions.push(toggle, vscode.commands.registerCommand("eta.togglePanel", () => vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar")));
  }
  setTimeout(async () => {
    // The secondary side bar (where the Eta view now lives) is hidden by default —
    // open it once; VS Code then remembers it's visible on later launches.
    // focusing the Eta view opens the right-hand bar by itself; no toggle (a toggle could close it).
    for (let i = 0; i < 6; i++) {
      try { await vscode.commands.executeCommand("eta.agent.focus"); break; }   // focus the Eta view in it
      catch { await new Promise((r) => setTimeout(r, 700)); }
    }
  }, 1400);
}

// ---- Inline edit (Cmd-K): rewrite the selection per a one-line instruction ----
async function inlineEdit() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage("Eta: open a file and select code to edit."); return; }
  let range: vscode.Range = editor.selection.isEmpty
    ? editor.document.lineAt(editor.selection.active.line).range
    : new vscode.Range(editor.selection.start, editor.selection.end);
  const code = editor.document.getText(range);
  if (!code.trim()) { vscode.window.showInformationMessage("Eta: nothing to edit — select some code first."); return; }
  const instruction = await vscode.window.showInputBox({
    prompt: "Eta — describe the edit for the selected code",
    placeHolder: "e.g. add error handling / convert to async / add JSDoc",
  });
  if (!instruction) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Eta is editing…" }, async () => {
    try {
      if (!(await waitForEngine(20))) { vscode.window.showErrorMessage("Eta engine not reachable."); return; }
      const r = await enginePost("/api/edit", {
        code, instruction, lang: editor.document.languageId,
        path: vscode.workspace.asRelativePath(editor.document.uri),
      });
      if (r?.error) { vscode.window.showErrorMessage("Eta: " + r.error); return; }
      const edit = String(r?.edit ?? "");
      if (!edit || edit === code) { vscode.window.showInformationMessage("Eta: no change."); return; }
      await editor.edit((b) => b.replace(range, edit));
    } catch (e: any) { vscode.window.showErrorMessage("Eta inline edit failed: " + (e?.message || e)); }
  });
}

// ---- Migration importer: bring settings + keybindings from VS Code / Cursor ----
function stripJsonc(s: string): string {
  return s
    .replace(/\\"|"(?:\\.|[^"\\])*"|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === "/" ? "" : m)) // drop comments, keep strings
    .replace(/,\s*([}\]])/g, "$1"); // trailing commas
}
function readJsonc(fp: string): any {
  try { return JSON.parse(stripJsonc(fs.readFileSync(fp, "utf8"))); } catch { return null; }
}
async function importSettings() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const sources = [
    { label: "Visual Studio Code", dir: path.join(appData, "Code", "User") },
    { label: "VS Code Insiders", dir: path.join(appData, "Code - Insiders", "User") },
    { label: "Cursor", dir: path.join(appData, "Cursor", "User") },
    { label: "Windsurf", dir: path.join(appData, "Windsurf", "User") },
  ].filter((s) => fs.existsSync(path.join(s.dir, "settings.json")) || fs.existsSync(path.join(s.dir, "keybindings.json")));
  if (!sources.length) { vscode.window.showInformationMessage("Eta: no VS Code / Cursor settings found to import."); return; }
  const pick = await vscode.window.showQuickPick(sources.map((s) => s.label), { placeHolder: "Import settings & keybindings from…" });
  if (!pick) return;
  const src = sources.find((s) => s.label === pick)!;
  // dest = this fork's User dir (globalStorageUri = <User>/globalStorage/<ext>)
  const globalStorage = (globalThis as any).__etaCtx?.globalStorageUri?.fsPath as string | undefined;
  const destUserDir = globalStorage ? path.dirname(path.dirname(globalStorage)) : path.join(appData, "Eta-IDE", "User");
  fs.mkdirSync(destUserDir, { recursive: true });

  let msg: string[] = [];
  // settings.json — merge source over existing (source wins for keys it defines)
  const srcSettings = readJsonc(path.join(src.dir, "settings.json")) || {};
  if (Object.keys(srcSettings).length) {
    const destPath = path.join(destUserDir, "settings.json");
    const cur = (fs.existsSync(destPath) && readJsonc(destPath)) || {};
    const merged = { ...cur, ...srcSettings };
    fs.writeFileSync(destPath, JSON.stringify(merged, null, 2), "utf8");
    msg.push(`${Object.keys(srcSettings).length} settings`);
  }
  // keybindings.json — union, dedup by key+command
  const srcKeys = readJsonc(path.join(src.dir, "keybindings.json"));
  if (Array.isArray(srcKeys) && srcKeys.length) {
    const destPath = path.join(destUserDir, "keybindings.json");
    const cur = (fs.existsSync(destPath) && readJsonc(destPath)) || [];
    const seen = new Set((Array.isArray(cur) ? cur : []).map((k: any) => `${k.key}|${k.command}`));
    const merged = [...(Array.isArray(cur) ? cur : [])];
    let added = 0;
    for (const k of srcKeys) { const id = `${k.key}|${k.command}`; if (!seen.has(id)) { merged.push(k); seen.add(id); added++; } }
    fs.writeFileSync(destPath, JSON.stringify(merged, null, 2), "utf8");
    if (added) msg.push(`${added} keybindings`);
  }
  if (!msg.length) { vscode.window.showInformationMessage("Eta: nothing new to import."); return; }
  const choice = await vscode.window.showInformationMessage(`Eta imported ${msg.join(" + ")} from ${pick}.`, "Reload Window");
  if (choice === "Reload Window") vscode.commands.executeCommand("workbench.action.reloadWindow");
}

export function deactivate() { killEngine(); try { lspServer?.close(); lspServer = null; } catch { /* already down */ } }
