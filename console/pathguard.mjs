// pathguard.mjs — ONE place for two safety checks (security pass 2026-11-15):
//  1) "is this path really inside the workspace folder?"  (insideRoot / guardPath)
//  2) "did the USER say this folder may run its own commands?"  (isTrusted / setTrusted)
// Pure Node, no deps. Used by server.mjs, agent.mjs, mcp.mjs, customize.mjs.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ---------------------------------------------------------------- path check
// The old check was  resolved.startsWith(path.resolve(root)) . That lets a SIBLING folder with the same
// prefix through (root D:\proj\app, path ..\app-evil\x.txt -> D:\proj\app-evil\x.txt starts with D:\proj\app).
function lexInside(root, target) {
  // path.relative compares without case on Windows and understands drive letters.
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return false;
  return true;
}
function real(p) { try { return fs.realpathSync.native(p); } catch { return fs.realpathSync(p); } }
// Real location of a path that may not exist yet: resolve links of the deepest EXISTING parent, then
// add the not-yet-existing rest back. A link or junction inside the workspace that points outside is
// found this way, also when the file below it is new.
export function realDeep(p) {
  let cur = path.resolve(p); const tail = [];
  for (;;) {
    try { const r = real(cur); return tail.length ? path.join(r, ...tail.reverse()) : r; }
    catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p); // nothing on this path exists (not even the drive)
      tail.push(path.basename(cur)); cur = up;
    }
  }
}
// true when `target` (absolute, or relative to root) is the root folder or below it — by name AND by real location.
export function insideRoot(root, target) {
  if (!root || typeof root !== "string" || typeof target !== "string" || target.includes("\0")) return false;
  const r = path.resolve(root), t = path.resolve(r, target);
  if (!lexInside(r, t)) return false;
  return lexInside(realDeep(r), realDeep(t));
}
// Resolve `rel` inside `root`, or throw. Returns the plain resolved path (same value the old code returned).
export function guardPath(root, rel) {
  if (!root || typeof root !== "string") throw new Error("path escapes workspace");
  const r = path.resolve(root, rel || ".");
  if (!insideRoot(root, r)) throw new Error("path escapes workspace");
  // Alternate data streams (file:stream) are never needed by a workspace path and hide the real name.
  if (r.slice(path.parse(r).root.length).includes(":")) throw new Error("path escapes workspace");
  // The user's own settings folders (trust list, global tool servers) are never reachable through a
  // workspace path, even when the workspace is the home folder itself. Checked by real location, so
  // short names (TRUSTE~1.JSO) and other spellings are caught too.
  for (const d of [path.join(os.homedir(), ".eta"), path.join(os.homedir(), ".eta-ide")]) {
    if (lexInside(realDeep(d), realDeep(r))) throw new Error("path escapes workspace");
  }
  return r;
}

// ---------------------------------------------------------------- folder trust
// A downloaded project can carry .eta/hooks.json (shell commands) and .eta/mcp.json / .mcp.json (programs to
// start). Those run only after the USER trusts the folder. The list lives in the user's own home folder
// (~/.eta/trusted-folders.json), never inside a project, so a project cannot mark itself trusted.
export const TRUST_NOTICE = "Project hooks and project tool servers are off until you trust this folder.";
export const trustFilePath = () => path.join(os.homedir(), ".eta", "trusted-folders.json");
// One fixed spelling per folder: absolute, links resolved, no trailing slash, lower case on Windows.
export function folderKey(p) {
  if (!p || typeof p !== "string" || !p.trim()) return "";
  let k = realDeep(p.trim());
  if (k.length > path.parse(k).root.length) k = k.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? k.toLowerCase() : k;
}
// Trust is tied to CONTENT (2026-11-15b): the decision stores a sha256 of the bytes of the three files that can
// make us run programs. When any of them changes (git pull, an edit, the agent itself writing .eta/hooks.json),
// the folder is untrusted again until the user looks at the new list and says yes again.
// Trust file:  { "version": 2, "folders": [ { "path": <folderKey>, "fp": <sha256>, "files": { <name>: <sha256|"missing"> }, "at": <iso> } ] }
// Old entries (plain strings, written before content checks) are kept in the file but count as NOT trusted:
// the user must confirm once more, this time with the full list in front of them.
export const TRUST_CHANGED_NOTICE = "This folder's hooks or tool servers changed since you trusted it. They are off until you trust it again.";
export const TRUST_FILES = [".eta/hooks.json", ".eta/mcp.json", ".mcp.json"];
const MISSING = "missing";
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// Read the three files once. Bytes are kept so the fingerprint and the shown list come from the SAME read.
function readProjectFiles(folder) {
  const out = {};
  for (const name of TRUST_FILES) {
    try { out[name] = fs.readFileSync(path.join(folder, ...name.split("/"))); }
    catch (e) { out[name] = e?.code === "ENOENT" || e?.code === "ENOTDIR" ? null : "unreadable:" + (e?.code || "error"); }
  }
  return out;
}
function fingerprintOf(raw) {
  const files = {};
  for (const name of TRUST_FILES) { const b = raw[name]; files[name] = b === null ? MISSING : typeof b === "string" ? b : sha256(b); }
  return { files, fp: sha256(JSON.stringify(TRUST_FILES.map((n) => [n, files[n]]))) };
}
export function folderFingerprint(folder) { return folder ? fingerprintOf(readProjectFiles(folder)) : { files: {}, fp: "" }; }
function readTrustRaw() {
  try { const j = JSON.parse(fs.readFileSync(trustFilePath(), "utf8")); return Array.isArray(j?.folders) ? j.folders : []; }
  catch { return []; }
}
const entryKey = (f) => folderKey(typeof f === "string" ? f : f?.path);
// "none" = never trusted, "old" = trusted before content checks existed, "changed" = files differ, "trusted".
// `contentRoot`: where the files are really read from (a git worktree copy of the folder). In a copy, a file that is
// missing runs nothing, so only files that EXIST there must match what the user trusted.
export function trustState(folder, contentRoot) {
  const k = folderKey(folder); if (!k) return "none";
  const e = readTrustRaw().filter((f) => entryKey(f) === k); // exact folder only: a trusted parent does not cover what is cloned below it
  if (!e.length) return "none";
  const cur = e.find((f) => f && typeof f === "object" && typeof f.fp === "string" && f.files && typeof f.files === "object");
  if (!cur) return "old";
  const copy = contentRoot && folderKey(contentRoot) !== k;
  const now = folderFingerprint(copy ? contentRoot : folder);
  if (!copy) return now.fp === cur.fp ? "trusted" : "changed";
  return TRUST_FILES.every((n) => now.files[n] === MISSING || now.files[n] === cur.files[n]) ? "trusted" : "changed";
}
export function isTrusted(folder, contentRoot) { return trustState(folder, contentRoot) === "trusted"; }
// `expectFp` (optional): the fingerprint the user was shown. If the files changed in between, nothing is trusted.
export function setTrusted(folder, trusted, expectFp) {
  const k = folderKey(folder); if (!k) throw new Error("a folder path is required");
  const rest = readTrustRaw().filter((f) => (typeof f === "string" || (f && typeof f === "object")) && entryKey(f) !== k);
  if (trusted) {
    const now = folderFingerprint(folder);
    if (expectFp && expectFp !== now.fp) { const e = new Error("The folder's hooks or tool servers changed while you were looking. Check the new list."); e.code = "TRUST_STALE"; throw e; }
    rest.push({ path: k, fp: now.fp, files: now.files, at: new Date().toISOString() });
  }
  const file = trustFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, folders: rest }, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return !!trusted;
}
// Text for the screen: no control or direction-changing characters (they can hide part of a command), and long
// text shortened with a count of what was cut. The FULL text is returned too (for a tooltip). Never HTML: the page
// puts these values in with textContent.
const HIDDEN_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
function showText(s, max = 240) {
  const full = String(s ?? "").replace(HIDDEN_CHARS, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).replace(/[\r\n\t]+/g, " ");
  const short = full.length > max ? full.slice(0, max) + " ... (" + (full.length - max) + " more characters)" : full;
  return { text: short, full };
}
const parseJson = (b) => { if (!b || typeof b === "string") return undefined; try { return JSON.parse(b.toString("utf8")); } catch { return undefined; } };
// What a folder carries that would run programs. `hooks` and `servers` are counts (old callers use them);
// `details` lists each hook command and each project tool server; `fp` is the fingerprint of the same bytes.
export function projectCommands(folder) {
  const out = { hooks: 0, servers: 0, details: { hooks: [], servers: [], serversFile: "" }, fp: "" };
  if (!folder) return out;
  const raw = readProjectFiles(folder);
  out.fp = fingerprintOf(raw).fp;
  const a = parseJson(raw[".eta/hooks.json"]);
  if (Array.isArray(a)) {
    out.hooks = a.length;
    for (const h of a) {
      const run = h && typeof h.run === "string" ? h.run : JSON.stringify(h ?? null);
      out.details.hooks.push({ when: showText(h?.when ?? "", 20).text, match: showText(h?.match ?? "*", 60).text, run: showText(run) });
    }
  } else if (raw[".eta/hooks.json"] !== null) out.details.hooks.push({ when: "", match: "", run: showText("(.eta/hooks.json could not be read as a list)") });
  // Same order as mcp.mjs loadProjectMcp: the first file that names any server is the one used.
  for (const name of [".eta/mcp.json", ".mcp.json"]) {
    const c = parseJson(raw[name]); const s = c && typeof c === "object" ? (c.mcpServers || c.servers || {}) : {};
    const names = s && typeof s === "object" ? Object.keys(s) : [];
    if (!names.length) continue;
    out.servers = names.length; out.details.serversFile = name;
    for (const n of names) {
      const v = s[n] && typeof s[n] === "object" ? s[n] : {};
      const args = Array.isArray(v.args) ? v.args.map((x) => String(x)) : [];
      const env = v.env && typeof v.env === "object" ? Object.entries(v.env).map(([ek, ev]) => ek + "=" + String(ev)) : [];
      out.details.servers.push({
        name: showText(n, 80).text, command: showText(v.command ?? v.url ?? ""), args: showText(args.join(" ")),
        env: env.length ? showText(env.join(" ")) : null, disabled: !!v.disabled,
      });
    }
    break;
  }
  return out;
}

// ---------------------------------------------------------------- one direct run per folder (2026-11-15c)
// Two runs that write straight into the same folder overwrite each other's files and undo points.
// Returns the reason a NEW direct run must wait, or null when it may start. `runs` = the server's run records.
// Isolated runs (own git worktree) still count toward the total cap, but not toward the same-folder rule.
export function directRunRefusal(runs, workspace, cap = 3) {
  const key = folderKey(workspace);
  let running = 0;
  for (const r of runs) {
    if (r?.status !== "running") continue;
    running++;
    if (key && !r.wtPath && !(r.isolated && r.branch) && folderKey(r.workspace) === key)
      return `Another Eta run (run ${r.id}) is still working in this folder. Wait until it finishes, or stop it, then start the new task.`;
  }
  if (running >= Math.max(1, cap)) return `${running} Eta runs are already working, which is the most this computer handles at once. Wait until one finishes, then start the new task.`;
  return null;
}
