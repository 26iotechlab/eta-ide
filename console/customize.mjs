// CUSTOMIZE: add skills, agents and tools (MCP) to Eta IDE — create them, or import them from a
// GitHub link, a web link, a folder, a .zip, or pasted text. Formats are the open ones other tools
// use (Agent Skills SKILL.md folders, Claude-style agent .md files, mcpServers JSON), so things
// copied from those places work as they are.
//
// Imports are two steps on purpose: PREVIEW (download to a temp folder, list what was found, warn
// about scripts and commands) and then COMMIT (copy only what the user picked). Nothing is
// installed by a preview.
import * as fs from "fs/promises";
import { existsSync, statSync, mkdirSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import AdmZip from "adm-zip";
import { loadSkills, loadAgents, parseFmLines } from "./agent.mjs";
import { loadMcpConfig, loadMcpFile, globalMcpPath, testMcpServer } from "./mcp.mjs";

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCRIPT_EXT = new Set([".sh", ".ps1", ".bat", ".cmd", ".py", ".js", ".mjs", ".cjs", ".ts", ".exe", ".dll", ".rb", ".pl", ".php"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".github", "dist", "__pycache__"]);
const MAX_DOWNLOAD = 40 * 1024 * 1024, MAX_UNZIPPED = 80 * 1024 * 1024, MAX_FILES = 6000;
const stash = new Map(); // preview id -> { dir, items, ts }

export const slug = (s) => String(s || "").toLowerCase().replace(/\.md$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
const home = () => path.join(os.homedir(), ".eta");
const base = (ws, scope) => (scope === "global" || !ws ? home() : path.join(ws, ".eta"));

function frontmatter(raw) {
  const fm = String(raw).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!fm) return { meta: {}, body: String(raw) };
  return { meta: parseFmLines(fm[1]), body: fm[2] };
}
// make the declared name equal the folder name (the standard requires it)
function withName(raw, name, desc) {
  const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)(\r?\n---[\s\S]*)$/);
  if (!m) return `---\nname: ${name}\ndescription: ${q(desc || "")}\n---\n\n${raw}`;
  const head = /^name:/m.test(m[1]) ? m[1].replace(/^name:.*$/m, "name: " + name) : "name: " + name + "\n" + m[1];
  return "---\n" + head + m[2];
}
const q = (s) => String(s).replace(/"/g, "'").replace(/\r?\n/g, " ").trim();

// ---------- list ----------
export async function listCustom(ws) {
  const own = (p) => /[\\/]\.eta[\\/]/.test(p || "");
  const skills = (await loadSkills(ws || null)).map((s) => ({ name: s.name, description: s.description, scope: s.scope, editable: s.scope !== "bundled" && own(s.dir) }));
  const agents = (await loadAgents(ws || null)).map((a) => ({ name: a.name, description: a.description, scope: a.scope, editable: own(a.file) }));
  const glob = await loadMcpFile(globalMcpPath());
  const proj = ws ? await loadMcpFile(path.join(ws, ".eta", "mcp.json")) : {};
  const row = (name, c, scope) => ({ name, command: [c.command, ...(c.args || [])].filter(Boolean).join(" ") || c.url || "", web: !c.command && !!c.url, scope, editable: true });
  const mcp = [...Object.entries(glob).filter(([n]) => !(n in proj)).map(([n, c]) => row(n, c, "global")), ...Object.entries(proj).map(([n, c]) => row(n, c, "project"))];
  return { skills, agents, mcp };
}

// ---------- create / delete ----------
export async function createItem({ ws, kind, name, description, body, scope }) {
  const n = slug(name);
  if (!NAME_RE.test(n)) throw new Error("Use a short name with letters and numbers, for example: code-reviewer");
  if (!String(body || "").trim()) throw new Error("Write the instructions first.");
  if (scope !== "global" && !ws) throw new Error("Open a project folder first, or choose 'all projects'.");
  const desc = q(description || "");
  const text = `---\nname: ${n}\ndescription: ${desc}\n---\n\n${String(body).trim()}\n`;
  if (kind === "skill") {
    const dir = path.join(base(ws, scope), "skills", n);
    await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, "SKILL.md"), text, "utf8");
    return { name: n, path: path.join(dir, "SKILL.md") };
  }
  if (kind === "agent") {
    const dir = path.join(base(ws, scope), "agents");
    await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, n + ".md"), text, "utf8");
    return { name: n, path: path.join(dir, n + ".md") };
  }
  throw new Error("kind must be skill or agent");
}

export async function deleteItem({ ws, kind, name }) {
  const n = slug(name);
  if (kind === "mcp") {
    let removed = false;
    for (const p of [ws && path.join(ws, ".eta", "mcp.json"), globalMcpPath()].filter(Boolean)) {
      let cfg; try { cfg = JSON.parse(await fs.readFile(p, "utf8")); } catch { continue; }
      const key = cfg.mcpServers ? "mcpServers" : "servers"; if (!cfg[key] || !(name in cfg[key])) continue;
      delete cfg[key][name]; await fs.writeFile(p, JSON.stringify(cfg, null, 2), "utf8"); removed = true;
    }
    if (!removed) throw new Error("Tool not found.");
    return { ok: true };
  }
  const targets = kind === "skill"
    ? [path.join(home(), "skills", n), ws && path.join(ws, ".eta", "skills", n)]
    : [path.join(home(), "agents", n + ".md"), ws && path.join(ws, ".eta", "agents", n + ".md")];
  let removed = false;
  for (const t of targets.filter(Boolean)) if (existsSync(t)) { await fs.rm(t, { recursive: true, force: true }); removed = true; }
  if (!removed) throw new Error("Only items you added to Eta can be removed here. This one is built in, or it lives in a folder owned by another tool.");
  return { ok: true };
}

// ---------- fetch a source into a temp folder ----------
async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "follow", headers: { "user-agent": "eta-ide" } });
  if (!r.ok) throw new Error(`Could not download (${r.status}) ${url}`);
  const len = Number(r.headers.get("content-length") || 0); if (len > MAX_DOWNLOAD) throw new Error("That download is too big.");
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > MAX_DOWNLOAD) throw new Error("That download is too big.");
  return buf;
}
function unzipTo(buf, dest) {
  const zip = new AdmZip(buf); let total = 0, n = 0; const root = path.resolve(dest) + path.sep;
  for (const e of zip.getEntries()) {
    if (++n > MAX_FILES) throw new Error("That archive has too many files.");
    const out = path.resolve(dest, e.entryName);
    if (!out.startsWith(root)) continue; // never write outside the temp folder
    if (e.isDirectory) { continue; }
    total += e.header.size; if (total > MAX_UNZIPPED) throw new Error("That archive is too big when unpacked.");
    mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, e.getData());
  }
}

// returns { dir, hint } — hint is a sub-folder inside dir to look at first
async function fetchSource(source, tmp) {
  const src = String(source).trim().replace(/^"|"$/g, "");
  if (!/^https?:\/\//i.test(src)) { // local path
    if (!existsSync(src)) throw new Error("I can't find that folder or file: " + src);
    const st = statSync(src);
    if (st.isDirectory()) return { dir: src, local: true };
    if (/\.zip$/i.test(src)) { unzipTo(await fs.readFile(src), tmp); return { dir: tmp }; }
    await fs.copyFile(src, path.join(tmp, path.basename(src))); return { dir: tmp };
  }
  const u = new URL(src);
  const gh = u.hostname === "github.com" && u.pathname.split("/").filter(Boolean);
  if (gh && gh.length >= 2 && !(gh[2] === "blob")) {
    const [owner, repo0] = gh; const repo = repo0.replace(/\.git$/, "");
    let branch = gh[2] === "tree" ? gh[3] : "HEAD"; let sub = gh[2] === "tree" ? gh.slice(4).join("/") : "";
    const tryUrl = (b) => `https://codeload.github.com/${owner}/${repo}/zip/${b === "HEAD" ? "HEAD" : "refs/heads/" + b}`;
    let buf; try { buf = await download(tryUrl(branch)); } catch (e) { if (branch === "HEAD") throw e; sub = gh.slice(3).join("/"); buf = await download(tryUrl("HEAD")); }
    unzipTo(buf, tmp);
    const top = (await fs.readdir(tmp))[0]; const dir = path.join(tmp, top);
    return { dir: sub ? path.join(dir, ...sub.split("/")) : dir };
  }
  let raw = src;
  if (gh && gh[2] === "blob") raw = `https://raw.githubusercontent.com/${gh[0]}/${gh[1]}/${gh.slice(3).join("/")}`;
  const buf = await download(raw);
  if (/\.zip(\?|$)/i.test(raw) || (buf[0] === 0x50 && buf[1] === 0x4b)) { unzipTo(buf, tmp); return { dir: tmp }; }
  await fs.writeFile(path.join(tmp, slug(path.basename(u.pathname)) + ".md"), buf); return { dir: tmp };
}

// ---------- look inside a folder for skills, agents, tools ----------
async function walk(dir, depth, out) {
  if (depth > 7 || out.n > MAX_FILES) return;
  let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name); out.n++;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(p, depth + 1, out); } else out.files.push(p);
  }
}
async function scan(dir, fallbackName) {
  const out = { files: [], n: 0 }; await walk(dir, 0, out);
  const items = []; const skillDirs = [];
  for (const f of out.files) if (/^SKILL\.md$/i.test(path.basename(f))) {
    const sd = path.dirname(f); const { meta } = frontmatter(await fs.readFile(f, "utf8"));
    const isRoot = path.resolve(sd) === path.resolve(dir);
    const name = slug(isRoot ? (meta.name || fallbackName) : path.basename(sd));
    if (!NAME_RE.test(name)) continue;
    const inside = out.files.filter((x) => x.startsWith(sd + path.sep));
    const scripts = inside.filter((x) => SCRIPT_EXT.has(path.extname(x).toLowerCase())).map((x) => path.relative(sd, x));
    skillDirs.push(sd);
    items.push({ kind: "skill", name, description: (meta.description || "").slice(0, 300), files: inside.length, scripts, from: sd });
  }
  for (const f of out.files) {
    const bn = path.basename(f);
    if (/\.md$/i.test(bn) && path.basename(path.dirname(f)).toLowerCase() === "agents" && !skillDirs.some((s) => f.startsWith(s + path.sep))) {
      const raw = await fs.readFile(f, "utf8"); const { meta, body } = frontmatter(raw);
      const name = slug(meta.name || bn); if (!NAME_RE.test(name) || !body.trim()) continue;
      items.push({ kind: "agent", name, description: (meta.description || "").slice(0, 300), files: 1, scripts: [], from: f });
    }
    if (/^\.?mcp\.json$/i.test(bn)) {
      try {
        const c = JSON.parse(await fs.readFile(f, "utf8")); const servers = c.mcpServers || c.servers || {};
        for (const [name, cfg] of Object.entries(servers)) items.push(mcpItem(name, cfg));
      } catch {}
    }
  }
  // a lone markdown file (no SKILL.md anywhere): offer it as a skill or an agent
  if (!items.length) {
    const mds = out.files.filter((x) => /\.md$/i.test(x));
    if (mds.length === 1) {
      const raw = await fs.readFile(mds[0], "utf8"); const { meta, body } = frontmatter(raw);
      const name = slug(meta.name || path.basename(mds[0])); if (NAME_RE.test(name) && body.trim())
        items.push({ kind: "skill", name, description: (meta.description || "").slice(0, 300), files: 1, scripts: [], from: mds[0], single: true, canBeAgent: true });
    }
  }
  return items;
}
function mcpItem(name, cfg) {
  const isCmd = cfg && typeof cfg.command === "string";
  const isWeb = !isCmd && cfg && typeof cfg.url === "string" && /^https?:\/\//i.test(cfg.url);
  const ok = isCmd || isWeb;
  return { kind: "mcp", name: slug(name) || name, web: isWeb,
    description: ok ? "" : "I could not use this entry. It needs either a command or an http(s) address.",
    command: isCmd ? [cfg.command, ...(cfg.args || [])].join(" ") : String(cfg?.url || ""), cfg: ok ? cfg : null, unsupported: !ok, files: 0, scripts: [] };
}

// ---------- step 1: preview ----------
export async function previewImport({ source, text, kind }) {
  for (const [k, v] of stash) if (Date.now() - v.ts > 15 * 60000) { fs.rm(v.dir, { recursive: true, force: true }).catch(() => {}); stash.delete(k); }
  const id = randomBytes(6).toString("hex"); const tmp = path.join(os.tmpdir(), "eta-import-" + id);
  await fs.mkdir(tmp, { recursive: true });
  let items = [], dirRoot = tmp;
  try {
    if (text && String(text).trim()) {
      const t = String(text).trim();
      if (t.startsWith("{")) { // pasted MCP JSON (what most tool READMEs show)
        let c; try { c = JSON.parse(t); } catch { throw new Error("That looks like JSON, but it is not valid. Copy the whole block again."); }
        let servers = c.mcpServers || c.servers;
        if (!servers) servers = (c.command || c.url) ? { [c.name || "tool"]: c } : c;
        items = Object.entries(servers).filter(([, v]) => v && typeof v === "object").map(([n, v]) => mcpItem(n, v));
        if (!items.length) throw new Error("I could not find any tool in that JSON.");
      } else { // pasted SKILL.md / agent text
        const { meta, body } = frontmatter(t); const name = slug(meta.name);
        if (!NAME_RE.test(name)) throw new Error("Add a name at the top, like:\n---\nname: my-helper\ndescription: what it does\n---");
        if (!body.trim()) throw new Error("There are no instructions after the header.");
        const k = kind === "agent" ? "agent" : "skill";
        const f = path.join(tmp, k === "agent" ? "agents" : name, k === "agent" ? name + ".md" : "SKILL.md");
        await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, t, "utf8");
        items = [{ kind: k, name, description: (meta.description || "").slice(0, 300), files: 1, scripts: [], from: k === "agent" ? f : path.dirname(f) }];
      }
    } else {
      if (!source || !String(source).trim()) throw new Error("Paste a link, a folder path, or the text first.");
      const fetched = await fetchSource(source, tmp); dirRoot = fetched.dir;
      items = await scan(dirRoot, slug(path.basename(String(source).replace(/[\\/]+$/, "").replace(/\.git$/, ""))) || "imported");
      if (!items.length) throw new Error("I found no skills, agents or tools there. A skill is a folder with a SKILL.md file. An agent is a .md file in an agents folder.");
    }
  } catch (e) { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); throw e; }
  const seen = new Set(); items = items.filter((i) => { const k = i.kind + ":" + i.name; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 200);
  stash.set(id, { dir: tmp, items, ts: Date.now(), local: dirRoot !== tmp && !dirRoot.startsWith(tmp) });
  return { id, items: items.map(({ from, cfg, ...pub }) => pub) };
}

// ---------- step 2: commit the chosen ones ----------
export async function commitImport({ id, ws, scope, picks }) {
  const st = stash.get(id); if (!st) throw new Error("That preview expired. Paste it again.");
  const want = new Map((picks || []).map((p) => [p.kind + ":" + p.name, p])); const done = [];
  for (const it of st.items) {
    const pick = want.get(it.kind + ":" + it.name); if (!pick || it.unsupported) continue;
    if (it.kind === "mcp") {
      if (scope !== "global" && !ws) throw new Error("Open a project folder first, or choose 'all projects'.");
      const p = scope === "global" || !ws ? globalMcpPath() : path.join(ws, ".eta", "mcp.json"); let cfg = {}; try { cfg = JSON.parse(await fs.readFile(p, "utf8")); } catch {}
      const key = cfg.servers && !cfg.mcpServers ? "servers" : "mcpServers"; cfg[key] = cfg[key] || {};
      cfg[key][it.name] = it.cfg; await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(cfg, null, 2), "utf8");
      done.push({ kind: "mcp", name: it.name }); continue;
    }
    if (scope !== "global" && !ws) throw new Error("Open a project folder first, or choose 'all projects'.");
    const asAgent = it.kind === "agent" || (it.canBeAgent && pick.as === "agent");
    if (asAgent) {
      const dest = path.join(base(ws, scope), "agents"); await fs.mkdir(dest, { recursive: true });
      const src = it.single || it.kind === "agent" ? it.from : null; if (!src) continue;
      let raw = await fs.readFile(src, "utf8");
      if (!frontmatter(raw).meta.name) raw = `---\nname: ${it.name}\ndescription: ${q(it.description)}\n---\n\n${raw}`;
      await fs.writeFile(path.join(dest, it.name + ".md"), raw, "utf8"); done.push({ kind: "agent", name: it.name });
    } else {
      const dest = path.join(base(ws, scope), "skills", it.name); await fs.rm(dest, { recursive: true, force: true }); await fs.mkdir(dest, { recursive: true });
      if (it.single) { // single file: store as SKILL.md
        let raw = await fs.readFile(it.from, "utf8");
        if (!frontmatter(raw).meta.name) raw = `---\nname: ${it.name}\ndescription: ${q(it.description)}\n---\n\n${raw}`;
        await fs.writeFile(path.join(dest, "SKILL.md"), raw, "utf8");
      } else {
        await fs.cp(it.from, dest, { recursive: true, filter: (s) => !SKIP_DIRS.has(path.basename(s)) });
        const sk = path.join(dest, "SKILL.md"); // keep the folder name and the declared name equal
        let raw = await fs.readFile(sk, "utf8"); const fm = frontmatter(raw);
        if (fm.meta.name !== it.name) await fs.writeFile(sk, withName(raw, it.name, it.description), "utf8");
      }
      done.push({ kind: "skill", name: it.name });
    }
  }
  if (!done.length) throw new Error("Nothing was selected.");
  fs.rm(st.dir, { recursive: true, force: true }).catch(() => {}); stash.delete(id);
  return { added: done };
}

// ---------- test one tool: connect once, list what it offers ----------
export async function testItem({ ws, name }) {
  const cfg = (await loadMcpConfig(ws || ""))[name]; if (!cfg) throw new Error("Tool not found.");
  return await testMcpServer(name, cfg, ws);
}

// ---------- edit an item you added (the whole file, so nothing is lost) ----------
function itemPath(ws, kind, name) {
  const n = slug(name);
  const c = kind === "skill"
    ? [ws && path.join(ws, ".eta", "skills", n, "SKILL.md"), path.join(home(), "skills", n, "SKILL.md")]
    : [ws && path.join(ws, ".eta", "agents", n + ".md"), path.join(home(), "agents", n + ".md")];
  return c.filter(Boolean).find((p) => existsSync(p)) || null;
}
export async function readItem({ ws, kind, name }) {
  const p = itemPath(ws, kind, name); if (!p) throw new Error("Only items you added to Eta can be edited here.");
  return { text: await fs.readFile(p, "utf8") };
}
export async function writeItem({ ws, kind, name, text }) {
  const p = itemPath(ws, kind, name); if (!p) throw new Error("Only items you added to Eta can be edited here.");
  if (!String(text || "").trim()) throw new Error("The file cannot be empty.");
  await fs.writeFile(p, String(text), "utf8"); return { ok: true };
}
