// The in-IDE split browser — a browser pane that opens BESIDE the editor so the
// user can code and browse in one window. It renders pages in a VS Code webview
// iframe (shares VS Code's renderer — no separate Chrome instance, far lighter on
// RAM). Sites that forbid embedding (YouTube, Google, ...) can be popped out to the
// system browser with one click. This is the USER's browser; the agent's testing
// browser is BrowserSurface in browser.ts.
import * as vscode from "vscode";

export class EtaBrowserPanel {
  private static current: EtaBrowserPanel | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === "openExternal" && m.url) vscode.env.openExternal(vscode.Uri.parse(m.url));
    });
    panel.onDidDispose(() => {
      if (EtaBrowserPanel.current === this) EtaBrowserPanel.current = undefined;
    });
  }

  // Opens (or reveals) the browser split beside the active editor.
  static show(extUri: vscode.Uri, url?: string) {
    if (!this.current) {
      const panel = vscode.window.createWebviewPanel(
        "etaBrowser", "Eta Browser",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.iconPath = vscode.Uri.joinPath(extUri, "media", "eta.svg");
      panel.webview.html = html();
      this.current = new EtaBrowserPanel(panel);
    } else {
      this.current.panel.reveal(vscode.ViewColumn.Beside, false);
    }
    if (url) this.current.panel.webview.postMessage({ type: "navigate", url });
  }
}

function html(): string {
  const nonce = String(Math.random()).slice(2);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; frame-src http: https:; script-src 'nonce-${nonce}';`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root{--brand:#14b8a6;--line:var(--vscode-panel-border,#333)}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;font:13px var(--vscode-font-family);color:var(--vscode-foreground)}
#bar{display:flex;gap:4px;align-items:center;padding:5px 6px;border-bottom:1px solid var(--line);background:var(--vscode-editor-background)}
#bar button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:5px;width:26px;height:24px;cursor:pointer;font-size:13px;line-height:1}
#bar button:hover{background:var(--vscode-button-secondaryHoverBackground)}
#bar button:disabled{opacity:.4;cursor:default}
#go{width:auto;padding:0 10px;background:var(--brand);color:#04110f;font-weight:600}
#url{flex:1;min-width:60px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--line);border-radius:5px;padding:4px 8px;font:inherit;outline:none}
#url:focus{border-color:var(--brand)}
#f{flex:1;border:0;width:100%;background:#fff}
#start{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--vscode-descriptionForeground)}
#start b{color:var(--brand);font-size:16px}
#start .links{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
#start .links button{width:auto;padding:5px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:6px;cursor:pointer}
#hint{padding:3px 8px;font-size:11px;color:var(--vscode-descriptionForeground);border-top:1px solid var(--line)}
</style></head><body>
<div id="bar">
  <button id="back" title="Back">&#8592;</button>
  <button id="fwd" title="Forward">&#8594;</button>
  <button id="re" title="Reload">&#10227;</button>
  <input id="url" placeholder="localhost:3000, a URL, or docs… — Enter to go" spellcheck="false">
  <button id="go" title="Go">Go</button>
  <button id="ext" title="Open this page in your system browser">&#10697;</button>
</div>
<div id="start">
  <b>&#9883; Eta Browser</b>
  <div>Browse beside your code — dev servers &amp; docs, no separate Chrome window.</div>
  <div class="links">
    <button data-u="http://localhost:3000">localhost:3000</button>
    <button data-u="http://localhost:5173">localhost:5173</button>
    <button data-u="http://localhost:8080">localhost:8080</button>
    <button data-u="https://developer.mozilla.org">MDN</button>
  </div>
</div>
<iframe id="f" style="display:none" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"></iframe>
<div id="hint">Sites that block embedding (YouTube, Google…) stay blank here — press &#10697; to pop them into your system browser. localhost and most docs work great.</div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const f = document.getElementById('f'), urlBox = document.getElementById('url'), start = document.getElementById('start');
const back = document.getElementById('back'), fwd = document.getElementById('fwd');
let hist = [], idx = -1;
function normalize(u){
  u = (u || '').trim(); if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = (/^(localhost|127\\.|0\\.0\\.0\\.0|192\\.168\\.)/i.test(u) ? 'http://' : 'https://') + u;
  return u;
}
function paint(){ back.disabled = idx <= 0; fwd.disabled = idx >= hist.length - 1; }
function load(u){ start.style.display='none'; f.style.display='block'; f.src = u; urlBox.value = u; vs.setState({ hist, idx }); paint(); }
function go(u){ u = normalize(u); if (!u) return; hist = hist.slice(0, idx + 1); hist.push(u); idx = hist.length - 1; load(u); }
back.onclick = () => { if (idx > 0) { idx--; load(hist[idx]); } };
fwd.onclick = () => { if (idx < hist.length - 1) { idx++; load(hist[idx]); } };
document.getElementById('re').onclick = () => { if (idx >= 0) f.src = hist[idx]; };
document.getElementById('go').onclick = () => go(urlBox.value);
document.getElementById('ext').onclick = () => { const u = idx >= 0 ? hist[idx] : normalize(urlBox.value); if (u) vs.postMessage({ type: 'openExternal', url: u }); };
urlBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(urlBox.value); });
start.querySelectorAll('button').forEach((b) => b.onclick = () => go(b.dataset.u));
window.addEventListener('message', (e) => { if (e.data.type === 'navigate') go(e.data.url); });
const st = vs.getState();
if (st && st.hist && st.hist.length) { hist = st.hist; idx = st.idx; load(hist[idx]); } else { paint(); urlBox.focus(); }
</script></body></html>`;
}
