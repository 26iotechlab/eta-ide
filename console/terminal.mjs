// Eta terminal: the command POLICY (what the agent may run) and the RUNNER (how it runs). Gokul, 2026-11-10:
// "It should be excellent in terminal use and know what to do and what not to do."
//
// Every command gets one verdict before it runs:
//   block  - never runs (disk wipe, shutdown, registry, security off, download-and-run, secrets, admin, other programs)
//   ask    - runs only after the user clicks Approve, even when auto-approve is on (git push/reset, publish, deletes…)
//   server - keeps running (dev servers, watchers): started in the background, never waited on
//   input  - opens an editor or a prompt that needs typing: refused with the non-interactive way
//   ok     - runs normally
// Runner: no keyboard input (prompts end at once instead of hanging), non-interactive settings, the whole process tree
// is stopped on timeout, output cleaned (no colour codes, no progress bars) and cut to head + tail.
import { spawn, spawnSync, execFile } from "child_process";
import path from "path"; import fs from "fs"; import os from "os";

const WIN = process.platform === "win32";

// ---------- policy ----------
const BLOCK = [
  [/\b(format(\.com)?)\s+[a-z]:/i, "formats a disk"],
  [/\b(diskpart|mkfs(\.\w+)?|fdisk|bcdedit|cipher\s+\/w|vssadmin\s+delete|wbadmin\s+delete)\b/i, "changes disks or system recovery"],
  [/\bdd\s+if=/i, "writes raw disk data"],
  [/\b(shutdown|reboot|poweroff|halt|logoff)\b|\b(Restart|Stop)-Computer\b/i, "turns off or restarts the computer"],
  [/:\(\)\s*\{\s*:\|:&\s*\}/, "fork bomb"],
  [/\breg(\.exe)?\s+(add|delete|import|load|unload|restore)\b|\b(Set|New|Remove)-Item(Property)?\b[^|&;]*\bHK(LM|CU|CR|U|CC)\s*:/i, "changes the Windows registry"],
  [/\bSet-MpPreference\b|\bAdd-MpPreference\b|\bnetsh\s+(adv)?firewall\b|\bDisable-WindowsOptionalFeature\b|\bSet-NetFirewallProfile\b/i, "changes Windows security settings"],
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|certutil)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python3?|node|powershell|pwsh|cmd)\b/i, "downloads a script and runs it at once"],
  [/\b(iex|Invoke-Expression)\b[^|&;]*\b(DownloadString|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+Net\.WebClient)\b/i, "downloads a script and runs it at once"],
  [/\bcertutil\b[^|&;]*-urlcache\b|\bbitsadmin\b/i, "downloads files with a system tool"],
  [/(^|[\s"'\\\/])\.ssh([\\\/]|\s|$)|\bid_(rsa|ed25519|ecdsa)\b|\.aws[\\\/]credentials|\.git-credentials|\\Login Data\b|\\Cookies\b|\bcmdkey\b|\bvaultcmd\b|\bmimikatz\b|\blsass\b/i, "touches passwords, keys or browser data"],
  [/(^|&&|\|\||;|\|)\s*(runas|sudo|su|doas)\b|-Verb\s+RunAs\b|\bnet\s+(user|localgroup)\b|\bAdd-LocalGroupMember\b/i, "needs administrator rights or changes user accounts"],
  [/\bschtasks\b[^|&;]*\/(create|change)\b|\bsc(\.exe)?\s+(create|config|delete)\b|\bNew-Service\b|\bRegister-ScheduledTask\b/i, "installs a background service or scheduled task"],
  [/\btaskkill\b[^|&;]*\/im\s+"?(explorer|svchost|csrss|winlogon|wininit|services|lsass|smss|dwm|eta ide|code|node|python|pythonw|py)(\.exe)?\b|\b(Stop-Process|kill(all)?|pkill)\b[^|&;]*\b(explorer|svchost|node|python|eta)\b/i, "stops other programs (also Eta itself); use stop_process for what you started"],
  [/\bgit\s+push\b[^|&;]*(--force\b|-f\b|--force-with-lease\b|\+\w)/i, "force-pushes and can erase other people's work"],
  [/\bchmod\s+-R\s+777\s+\/|\bchown\s+-R\b[^|&;]*\s\/(\s|$)|\btakeown\b|\bicacls\b[^|&;]*\/(grant|reset)\b/i, "changes file permissions widely"],
  [/\bSet-ExecutionPolicy\b[^|&;]*\b(LocalMachine)\b/i, "changes the PC-wide script policy"],
];
const ASK = [
  [/\bgit\s+(push|reset\s+--hard|clean\s+-\w*f\w*|checkout\s+--\s|restore\s+\.|rebase|branch\s+-D|stash\s+(drop|clear)|filter-branch|reflog\s+expire)\b/i, "changes git history or sends code to a server"],
  [/\b(npm|yarn|pnpm)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bvsce\s+publish\b|\bovsx\s+publish\b|\bcargo\s+publish\b|\bgh\s+(release|repo|pr)\s+create\b/i, "publishes something to the internet"],
  [/\b(npm|pnpm)\s+(i|install|add|uninstall|remove|rm)\b[^|&;]*\s(-g|--global)\b|\byarn\s+global\b|\b(winget|choco|scoop)\s+(install|uninstall|upgrade)\b|\bpip3?\s+install\b[^|&;]*--user\b/i, "installs or removes programs for the whole PC"],
  [/\bsetx\b|\[Environment\]::SetEnvironmentVariable/i, "changes settings that stay after Eta closes"],
  [/\bSet-ExecutionPolicy\b/i, "changes the script policy"],
  [/\b(ssh|scp|sftp|rsync)\s/i, "connects to another computer"],
  [/\bcurl\b[^|&;]*\s(-F|--form|-T|--upload-file|--data(-binary)?\s+@|-d\s+@)/i, "uploads a file to the internet"],
  // LIVE-CAUGHT 2026-11-10 (35B): port busy -> "netstat | findstr :3456" -> "taskkill /F /PID 8580". The number can be ANY
  // program of the user's (their own dev server, a database). Processes Eta started are stopped with stop_process.
  [/\btaskkill\b[^|&;]*\/pid\b|\bStop-Process\b[^|&;]*-Id\b|(^|&&|\|\||;)\s*kill\s+(-\w+\s+)*\d+/i, "stops a program by its number, and it may be one of the user's own programs (for programs Eta started, use stop_process)"],
];
// Keep running until stopped: start in the background (start_process), never wait on them.
const SERVER = /^\s*(npx\s+(--yes\s+|-y\s+)?)?((npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b|vite(\s+(dev|preview|serve)\b|\s*$|\s+--)|next\s+(dev|start)\b|nuxt\s+dev\b|ng\s+serve\b|astro\s+dev\b|remix\s+dev\b|nodemon\b|live-server\b|http-server\b|serve(\s|$)|webpack\s+(serve|--watch)\b|tsc\b[^&|;]*\s(-w|--watch)\b|jest\b[^&|;]*--watch|vitest(\s*$|\s+(dev|watch)\b)|parcel(\s+serve)?\s+\S+\.html|eleventy\b[^&|;]*--serve|hugo\s+server\b|jekyll\s+serve\b|php\s+-S\b|python3?\s+-m\s+(http\.server|flask\s+run|uvicorn|streamlit)\b|py\s+-m\s+http\.server\b|flask\s+run\b|uvicorn\b|gunicorn\b|hypercorn\b|daphne\b|python3?\s+\S*manage\.py\s+runserver\b|streamlit\s+run\b|gradio\b|jupyter\s+(notebook|lab)\b|docker(-|\s+)compose\s+up(?![^&|;]*\s-d\b)|ping\s+[^&|;]*-t\b|tail\s+-f\b|Get-Content\b[^&|;]*-Wait\b)/i;
const INPUT = [
  [/^\s*(vi|vim|nvim|nano|emacs|pico|notepad|code|less|more|top|htop|edit)(\.exe)?(\s|$)/i, "opens an editor or a full-screen program that waits for you", "Read files with read_file and change them with edit_file."],
  [/^\s*(python3?|py|node|deno|irb|ghci|sqlite3|psql|mysql|powershell|pwsh|cmd)(\.exe)?\s*$/i, "opens an interactive prompt that waits for typing", "Run a file (python app.py) or a one-line command (python -c \"print(1)\")."],
  [/\bgit\s+commit\b(?![^&|;]*\s(-\w*m|--message|-F|--file|--no-edit|-C)\b)/i, "opens an editor for the commit message", "Use git commit -m \"message\"."],
  [/\bnpm\s+init\b(?![^&|;]*\s(-y|--yes)\b)(?![^&|;]*\s\S+@)/i, "asks questions one by one", "Use npm init -y."],
  [/\bgit\s+(rebase|add)\s+(-i|--interactive|-p|--patch)\b/i, "is interactive", "Use the non-interactive form."],
];
// Deleting folders: never outside the project or the whole project; inside it the user approves (except build leftovers).
const DEL = /(^|&&|\|\||;|\|)\s*(rm\s+(-\w*r\w*|--recursive)\b|rmdir\s+\/s\b|rd\s+\/s\b|del\s+\/[sq]\b|Remove-Item\b[^|&;]*-Recurse\b|rimraf\b|shutil\.rmtree)([^|&;]*)/gi;
const SAFE_DIRS = /^(node_modules|dist|build|out|\.next|\.nuxt|\.vite|\.cache|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|target|bin|obj|\.parcel-cache|\.turbo|\.eta[\\\/]tmp)([\\\/]|$)/i;

function deleteVerdict(cmd, root) {
  let m; DEL.lastIndex = 0;
  while ((m = DEL.exec(cmd))) {
    const targets = (m[4] || "").replace(/(^|\s)(-{1,2}[\w-]+|\/[a-z])(?=\s|$)/gi, " ").match(/"[^"]+"|'[^']+'|\S+/g) || [];
    if (!targets.length) return { level: "ask", why: "deletes folders" };
    for (let t of targets) {
      t = t.replace(/^["']|["']$/g, "");
      if (/^(\*|\.|\.\/|\.\\|~|\/|[a-z]:\\?|\$HOME|%USERPROFILE%|\$env:USERPROFILE)$/i.test(t) || /^[a-z]:\\(windows|program files|users)\b/i.test(t)) return { level: "block", why: "deletes the whole project, a drive or a system folder" };
      if (root && (path.isAbsolute(t) || /^[\\\/]/.test(t))) {
        const rel = path.relative(path.resolve(root), path.resolve(root, t));
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { level: "block", why: "deletes something outside the project folder" };
        if (!SAFE_DIRS.test(rel)) return { level: "ask", why: "deletes a folder in the project" };
      } else if (/(^|[\\\/])\.\.([\\\/]|$)/.test(t)) return { level: "block", why: "deletes something outside the project folder" };
      else if (!SAFE_DIRS.test(t.replace(/^\.[\\\/]/, ""))) return { level: "ask", why: "deletes a folder in the project" };
    }
  }
  return null;
}

// ANY change outside the project folder is blocked: deleting a single file, an empty folder, moving, renaming,
// writing (> or Set-Content) - not only folder-wide deletes. LIVE-CAUGHT 2026-11-10 (live test, 35B): after
// "rd /s" was blocked, the model deleted the file with "del" and then the empty folder with "rmdir".
// Copying INTO the project from outside stays allowed (only the destination counts for copy).
const MUTATE = /^\s*(del|erase|rd|rmdir|rm|unlink|move|mv|ren|rename|Remove-Item|Move-Item|Rename-Item|Set-Content|Add-Content|Clear-Content|Out-File|New-Item|mkdir|md|touch|truncate|attrib)\b/i;
const COPY = /^\s*(copy|cp|xcopy|robocopy|Copy-Item)\b/i;
const PATHS = /"([a-z]:[\\\/][^"]*|\\\\[^"]+)"|'([a-z]:[\\\/][^']*)'|(?:^|\s|=)([a-z]:[\\\/][^\s"'|&;>]*|\\\\[^\s"'|&;>]+|~[\\\/][^\s"'|&;>]*|%USERPROFILE%[^\s"'|&;>]*|\$env:\w+[^\s"'|&;>]*|\$HOME[^\s"'|&;>]*|(?:\.\.[\\\/])+[^\s"'|&;>]*|\.\.)(?=\s|$|[|&;>"'])/gi;
function outsideOf(root, p) {
  if (!root) return /^[a-z]:|^\\\\|^~|^%|^\$/i.test(p);
  if (/^(~|%USERPROFILE%|\$env:|\$HOME|\\\\)/i.test(p)) return true;
  const rel = path.relative(path.resolve(root), path.resolve(root, p));
  return rel.startsWith("..") || path.isAbsolute(rel);
}
function changesOutside(cmd, root) {
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const paths = []; let m; PATHS.lastIndex = 0;
    while ((m = PATHS.exec(seg))) paths.push(m[1] || m[2] || m[3]);
    const redir = [...seg.matchAll(/>>?\s*("([^"]+)"|(\S+))/g)].map((x) => x[2] || x[3]).filter((x) => !/^(nul|&\d|\$null|\/dev\/null)$/i.test(x));
    if (redir.some((p) => outsideOf(root, p))) return true;
    if (MUTATE.test(seg) && paths.some((p) => outsideOf(root, p))) return true;
    if (COPY.test(seg)) { // destination = the last argument that is not an option
      const args = (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).slice(1).map((a) => a.replace(/^["']|["']$/g, "")).filter((a) => !/^(-{1,2}[\w-]+|\/[a-z]+(:\S*)?)$/i.test(a));
      if (args.length >= 2 && outsideOf(root, args[args.length - 1])) return true;
    }
  }
  return false;
}

// cd / pushd out of the project, or writing into system places.
function outsideVerdict(cmd, root) {
  if (changesOutside(cmd, root)) return { level: "block", why: "changes, deletes or moves files outside the project folder" };
  const m = cmd.match(/(^|&&|;)\s*(cd|pushd|Set-Location|chdir)\s+(\/d\s+)?("[^"]+"|\S+)/i);
  if (m && root) { const t = m[4].replace(/^"|"$/g, ""); const rel = path.relative(path.resolve(root), path.resolve(root, t));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { level: "ask", why: "works outside the project folder" }; }
  if (/(^|[\s>"'])([a-z]:\\(windows|program files( \(x86\))?|programdata)\b|\/(etc|usr|bin|sbin|boot|sys)\/)/i.test(cmd) && /(>|\b(copy|move|xcopy|robocopy|cp|mv|del|rm|Set-Content|Out-File|New-Item|Copy-Item|Move-Item)\b)/i.test(cmd))
    return { level: "block", why: "changes system folders" };
  return null;
}

export function classifyCommand(command, root = "") {
  const cmd = String(command || "").trim();
  if (!cmd) return { level: "block", why: "empty command" };
  for (const [re, why] of BLOCK) if (re.test(cmd)) return { level: "block", why };
  const d = deleteVerdict(cmd, root); if (d?.level === "block") return d;
  const o = outsideVerdict(cmd, root); if (o?.level === "block") return o;
  for (const [re, why, how] of INPUT) if (re.test(cmd)) return { level: "input", why, how };
  for (const [re, why] of ASK) if (re.test(cmd)) return { level: "ask", why };
  if (d) return d; if (o) return o;
  // the LAST step decides: "cd app && npm install && npm run dev" ends in a server
  const last = cmd.split(/&&|\|\||;/).map((x) => x.trim()).filter(Boolean).pop() || "";
  if (SERVER.test(last)) return { level: "server", why: "keeps running (a server or a watcher)" };
  return { level: "ok", why: "" };
}

// ---------- runner ----------
// No colours, no prompts, no update nags. CI is NOT set on purpose: some tools then turn warnings into errors.
export const QUIET_ENV = {
  NO_COLOR: "1", FORCE_COLOR: "0", npm_config_color: "false", npm_config_yes: "true", npm_config_fund: "false", npm_config_audit: "false",
  npm_config_update_notifier: "false", npm_config_progress: "false", PIP_NO_INPUT: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONUNBUFFERED: "1",
  PYTHONIOENCODING: "utf-8", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_PAGER: "cat", PAGER: "cat", DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", BROWSER: "none",
};
function childEnv() { const e = { ...process.env, ...QUIET_ENV }; delete e.ELECTRON_RUN_AS_NODE; for (const k of Object.keys(e)) if (/^(VSCODE_|ELECTRON_)/.test(k)) delete e[k]; return e; }

// Clean output: colour codes out, progress bars (\r rewrites) reduced to their last state, repeated lines folded,
// and long output cut to its start and its end (errors are usually at the end, the command echo at the start).
export function cleanOutput(s, max = 4000) {
  let t = String(s || "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
  t = t.split("\n").map((l) => { const parts = l.split("\r").filter((p) => p.trim()); return parts.length ? parts[parts.length - 1] : ""; }).join("\n");
  const lines = t.split("\n"), out = []; let prev = null, rep = 0;
  for (const l of lines) { if (l === prev && l.trim()) { rep++; continue; } if (rep) out.push(`  (the line above repeated ${rep} more times)`); rep = 0; out.push(l); prev = l; }
  if (rep) out.push(`  (the line above repeated ${rep} more times)`);
  t = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > max) { const head = Math.floor(max * 0.3), tail = max - head; const cut = t.slice(head, t.length - tail).split("\n").length;
    t = t.slice(0, head) + `\n… (${cut} lines cut from the middle) …\n` + t.slice(t.length - tail); }
  return t;
}

export function killTree(pid) {
  if (!pid) return;
  try { if (WIN) spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); else process.kill(-pid, "SIGKILL"); } catch {}
}

// ---------- leftovers: background programs must never outlive Eta ----------
// LIVE-CAUGHT 2026-11-10: a "node server.js" the agent started kept running after the engine was killed hard. A hard kill
// (closing the IDE, Task Manager, the test's kill) never runs the "exit" handler, the cmd.exe in between was gone, so
// "taskkill /T" could no longer find the node below it. Now every background program's whole tree is written down
// (process number + start time, so a reused number is never hit) in ~/.eta-ide/procs.json; a new engine stops what the
// last one left behind, and stopping a process also stops its children directly.
// One list per engine (several engines can run at once: the daily IDE, a test IDE): procs-<engine number>.json.
const LDIR = path.join(os.homedir(), ".eta-ide");
const LEDGER = path.join(LDIR, `procs-${process.pid}.json`);
let selfBorn = null; // this engine's own start time, so a later engine can tell "still running" from "number reused"
function winProcs() { // Map pid -> { ppid, born }   (born = start time, Windows file time)
  return new Promise((res) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '' + $_.ProcessId + ',' + $_.ParentProcessId + ',' + $_.CreationDate.ToFileTimeUtc() } }"],
    { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 }, (err, so) => {
      const m = new Map(); for (const l of String(so || "").split(/\r?\n/)) { const [a, b, c] = l.trim().split(","); if (c) m.set(+a, { ppid: +b, born: c }); } res(m); }));
}
const treeOf = (all, pid) => { const out = [], q = [pid]; while (q.length) { const p = q.shift(); if (!all.has(p) || out.some((x) => x.pid === p)) continue; out.push({ pid: p, born: all.get(p).born }); for (const [c, v] of all) if (v.ppid === p && c !== p) q.push(c); } return out; };
function writeLedger(list) { try { if (!list.length) { fs.rmSync(LEDGER, { force: true }); return; } fs.mkdirSync(LDIR, { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify({ engine: { pid: process.pid, born: selfBorn }, list })); } catch {} }
function saveLedger() { writeLedger([...procs.values()].filter((r) => r.status === "running" && r.tree?.length).map((r) => ({ id: r.id, command: r.command, tree: r.tree }))); }
async function recordTree(rec) { // called once a background program is up; best effort, never blocks the agent
  if (!WIN || !rec.pid) return;
  try { const all = await winProcs(); if (!selfBorn && all.has(process.pid)) selfBorn = all.get(process.pid).born;
    const t = treeOf(all, rec.pid); if (t.length) { rec.tree = t; if (procs.has(rec.id)) saveLedger(); } } catch {}
}
function killRec(rec) { killTree(rec.pid); for (const x of rec.tree || []) if (x.pid !== rec.pid) killTree(x.pid); }
// Called once when the engine starts: stops programs a crashed or hard-killed engine left running.
export async function cleanupLeftovers() {
  if (!WIN) return 0;
  let files = []; try { files = fs.readdirSync(LDIR).filter((f) => /^procs-\d+\.json$/.test(f) && path.join(LDIR, f) !== LEDGER); } catch {}
  if (!files.length) return 0;
  const all = await winProcs(); let n = 0;
  for (const f of files) {
    const fp = path.join(LDIR, f); let j; try { j = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { try { fs.rmSync(fp, { force: true }); } catch {} continue; }
    const eng = all.get(j?.engine?.pid);
    if (eng && (!j.engine.born || String(eng.born) === String(j.engine.born))) continue; // that engine is still running: its programs are its own
    for (const e of j.list || []) for (const x of e.tree || []) { const now = all.get(x.pid); if (now && String(now.born) === String(x.born)) { killTree(x.pid); n++; } }
    try { fs.rmSync(fp, { force: true }); } catch {}
  }
  return n;
}

const LONG = /\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add)\b|\bpip3?\s+install\b|\buv\s+(pip|sync|add)\b|\bpoetry\s+install\b|\bcargo\s+(build|test|install)\b|\bgo\s+(build|test|mod)\b|\bdotnet\s+(restore|build|test|publish)\b|\bmvn\b|\bgradle\b|\bnpx\s+create-|\bnpm\s+(run\s+)?build\b|\bdocker\s+build\b/i;
export function timeoutFor(command) { return LONG.test(command) ? 300000 : 120000; }

// Runs one command to its end. Returns { code, out, timedOut, ms, waitedForInput }.
// adopt: a command that turns out to be a server (prints a local address or "listening" and keeps running) is not
// waited on or killed: it is handed to the background list and the result says so. LIVE-CAUGHT 2026-11-10: the model ran
// "node server.js" with run_command and waited the full 2 minutes (the name alone does not say "server").
export function runShell(root, command, { timeoutMs, adopt = false, owner = root } = {}) {
  const limit = timeoutMs || timeoutFor(command);
  return new Promise((res) => {
    const t0 = Date.now(); let buf = "", done = false, timedOut = false, adoptT = null;
    const p = spawn(command, { cwd: root, shell: true, env: childEnv(), windowsHide: true, detached: !WIN, stdio: ["pipe", "pipe", "pipe"] });
    try { p.stdin.end(); } catch {} // no keyboard: a prompt gets "end of input" at once instead of waiting forever
    const tryAdopt = () => {
      if (done || !adopt || adoptT) return;
      const clean = cleanOutput(buf, 1e9); if (!(URL_RE.test(clean) || READY_RE.test(clean))) return;
      adoptT = setTimeout(async () => {
        if (done) return; done = true; clearTimeout(timer);
        const id = "p" + nextProc++; const m = clean.match(URL_RE);
        const rec = { id, root, owner, command, status: "running", code: null, out: buf, readAt: 0, url: m ? m[0].replace("0.0.0.0", "localhost").replace(/[.,;:]+$/, "") : "", started: t0, pid: p.pid };
        procs.set(id, rec);
        p.stdout.on("data", (d) => { rec.out += d; }); p.stderr.on("data", (d) => { rec.out += d; });
        p.on("close", (code) => { rec.status = "exited"; rec.code = code; });
        if (rec.url) for (let i = 0; i < 10; i++) { try { await fetch(rec.url, { signal: AbortSignal.timeout(1500) }); rec.answers = true; break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
        rec.readAt = rec.out.length; recordTree(rec);
        res({ code: null, out: buf, timedOut: false, ms: Date.now() - t0, adopted: describe(rec, cleanOutput(rec.out, 2500)) });
      }, 2500);
    };
    const add = (d) => { buf += d; if (buf.length > 4 << 20) buf = buf.slice(-(2 << 20)); tryAdopt(); };
    p.stdout.on("data", add); p.stderr.on("data", add);
    const timer = setTimeout(() => { timedOut = true; killTree(p.pid); }, limit);
    const end = (code) => { if (done) return; done = true; clearTimeout(timer);
      res({ code: timedOut ? null : code, out: buf, timedOut, ms: Date.now() - t0, waitedForInput: /EOFError|EOF when reading a line|end of file|stdin.*(closed|EOF)|Unexpected end of input|readline was closed|ERR_USE_AFTER_CLOSE|Terminate batch job/i.test(buf) }); };
    p.on("error", (e) => { buf += String(e?.message || e); end(1); });
    p.on("close", (code) => end(code));
  });
}

// ---------- background processes (servers, watchers) ----------
const procs = new Map(); let nextProc = 1;
const URL_RE = /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+\.local)(:\d+)?(\/[^\s"'<>)\]]*)?/i;
const READY_RE = /\b(listening|ready in|ready on|started server|server (is )?running|running (at|on)|serving|compiled successfully|local:\s|watching for file changes|application startup complete|development server)/i;
const MAX_PROCS = 3;

export function listProcesses(root) { return [...procs.values()].filter((p) => !root || p.root === root); }

export async function startProcess(root, command, { waitMs = 25000, owner = root } = {}) {
  const alive = listProcesses().filter((p) => p.owner === owner && p.status === "running");
  if (alive.length >= MAX_PROCS) return { ok: false, text: `Already ${alive.length} background processes running (${alive.map((p) => `${p.id}: ${p.command}`).join("; ")}). Stop one with stop_process first.` };
  const id = "p" + nextProc++;
  const rec = { id, root, owner, command, status: "running", code: null, out: "", readAt: 0, url: "", started: Date.now(), pid: 0 };
  const p = spawn(command, { cwd: root, shell: true, env: childEnv(), windowsHide: true, detached: !WIN, stdio: ["pipe", "pipe", "pipe"] });
  try { p.stdin.end(); } catch {}
  rec.pid = p.pid; procs.set(id, rec);
  const add = (d) => { rec.out += d; if (rec.out.length > 200000) { const cut = rec.out.length - 100000; rec.out = rec.out.slice(cut); rec.readAt = Math.max(0, rec.readAt - cut); }
    if (!rec.url) { const m = cleanOutput(rec.out, 1e9).match(URL_RE); if (m) rec.url = m[0].replace("0.0.0.0", "localhost").replace(/[.,;:]+$/, ""); } };
  p.stdout.on("data", add); p.stderr.on("data", add);
  p.on("close", (code) => { rec.status = "exited"; rec.code = code; });
  p.on("error", (e) => { rec.out += String(e?.message || e); rec.status = "exited"; rec.code = 1; });
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs && rec.status === "running" && !(rec.url && READY_RE.test(rec.out)) && !(rec.url && Date.now() - t0 > 4000) && !(!rec.url && READY_RE.test(rec.out) && Date.now() - t0 > 3000)) await new Promise((r) => setTimeout(r, 250));
  if (rec.url && rec.status === "running") { // the address printed is only an address: check that it answers
    for (let i = 0; i < 20; i++) { try { await fetch(rec.url, { signal: AbortSignal.timeout(1500) }); rec.answers = true; break; } catch { await new Promise((r) => setTimeout(r, 500)); } } }
  rec.readAt = rec.out.length; if (rec.status === "running") recordTree(rec);
  return { ok: rec.status === "running", rec, text: describe(rec, cleanOutput(rec.out, 2500)) };
}

function describe(rec, output) {
  const busy = /EADDRINUSE|address already in use|port \d+ is (already )?in use|Only one usage of each socket address/i.test(rec.out);
  const mine = listProcesses().filter((p) => p.owner === rec.owner && p.id !== rec.id && p.status === "running");
  const busyHint = !busy ? "" : mine.length
    ? ` The port is already in use, most likely by the server Eta already started: ${mine.map((p) => `${p.id}: ${p.command}`).join("; ")}. It is still running, so check it with http_request. To restart it after a code change, stop_process it first.`
    : " The port is already in use by another program of the user. Do not stop that program: use another port.";
  if (rec.status !== "running") return `⚠ COMMAND FAILED — background process ${rec.id} stopped by itself (exit ${rec.code}).${busyHint}\nOutput:\n${output || "(no output)"}`;
  return `Started in the background as ${rec.id}: ${rec.command}\n` +
    (rec.url ? `Address: ${rec.url}${rec.answers ? " (answers)" : " (printed, but did not answer yet)"}\n` : "No address seen yet; read_process to see more output.\n") +
    `It keeps running. Check it with http_request or check_page, see new output with read_process {"id":"${rec.id}"}, stop it with stop_process {"id":"${rec.id}"}.\nOutput so far:\n${output || "(no output yet)"}`;
}

export function readProcess(id) {
  const rec = procs.get(String(id || "").trim()) || [...procs.values()].pop();
  if (!rec) return "No background process is running. Start one with start_process.";
  const fresh = rec.out.slice(rec.readAt); rec.readAt = rec.out.length;
  return `${rec.id} (${rec.command}) is ${rec.status === "running" ? "running" : `stopped (exit ${rec.code})`}${rec.url ? ", address " + rec.url : ""}.\nNew output:\n${cleanOutput(fresh, 3000) || "(nothing new)"}`;
}

export function stopProcess(id) {
  const key = String(id || "").trim();
  const list = key === "all" ? [...procs.values()] : [procs.get(key)].filter(Boolean);
  if (!list.length) return `No background process "${key}". Running: ${[...procs.values()].filter((p) => p.status === "running").map((p) => p.id).join(", ") || "none"}.`;
  for (const rec of list) { killRec(rec); rec.status = "exited"; procs.delete(rec.id); }
  saveLedger();
  return `Stopped ${list.map((r) => r.id).join(", ")}.`;
}

// A new run in the same folder starts clean; Eta closing stops everything it started.
export function stopAllFor(owner) { for (const rec of [...procs.values()]) if (rec.owner === owner) { killRec(rec); procs.delete(rec.id); } saveLedger(); }
process.once("exit", () => { for (const rec of procs.values()) killRec(rec); writeLedger([]); });
// a normal stop (Ctrl+C, the IDE asking politely) also runs the cleanup above
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) { try { process.once(sig, () => process.exit(0)); } catch {} }

// The terminal rules the agent reads (kept short: small models follow short lists better).
export const TERMINAL_RULES = `TERMINAL RULES (the shell is Windows cmd.exe, started in the project folder):
- Nothing can type into a command. Use the non-interactive form: npm init -y, npm create vite@latest app -- --template vanilla, git commit -m "msg", pip install -q pkg.
- Servers and watchers (npm run dev, npm start, python -m http.server, flask run, uvicorn …) go to start_process, never run_command. Then test them with http_request or check_page, read logs with read_process. Leave it running while the task goes on, also between steps: Eta stops it when the whole run ends. If the port is busy, the server is usually still running from before: check it with http_request instead of starting it again.
- Stay inside the project folder. Never delete, move or change anything outside it.
- Blocked, never try: wiping or formatting disks, shutdown, registry or Windows security changes, downloading a script and running it (curl … | sh, iwr … | iex), reading passwords, keys or browser data, admin rights, stopping other programs (also node or python by name). Never stop a program by its number (taskkill /PID): use stop_process for what Eta started.
- The user must approve: git push / reset --hard / clean, publishing (npm publish), installs for the whole PC (npm -g, winget), deleting folders. If refused, find another way.
- Read the output before the next step. If a command fails, fix the cause; never repeat the same command unchanged. "command not found" means the tool is missing: say so, do not guess another tool.
- One clear command per step; chain only short steps with &&. Use relative paths.`;
