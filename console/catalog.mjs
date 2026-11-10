// Recommended developer tools (MCP servers). None is on by default: the user adds one with a click.
// Every entry here was started and listed its tools with the IDE's own MCP client (2026-11-09).
// Few tools is better for small local models, so this list is short on purpose.
import fs from "fs/promises";
import path from "path";
import { globalMcpPath, loadMcpFile, testMcpServer } from "./mcp.mjs";

export const TOOL_CATALOG = [
  { id: "docs-context7", name: "context7", label: "Library docs (Context7)", kind: "web",
    what: "Looks up current, correct documentation and code examples for any library. Stops the model from using old or invented functions.",
    needs: "Internet. No key (free use has a limit).", cfg: { url: "https://mcp.context7.com/mcp" }, tools: ["resolve-library-id", "query-docs"] },
  { id: "repo-deepwiki", name: "deepwiki", label: "Repository Q&A (DeepWiki)", kind: "web",
    what: "Ask questions about any public code repository and read its generated wiki. Good for learning an unknown open source project.",
    needs: "Internet. No key. Public repositories only.", cfg: { url: "https://mcp.deepwiki.com/mcp" }, tools: ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"] },
  { id: "docs-microsoft", name: "microsoft-learn", label: "Microsoft docs", kind: "web",
    what: "Searches the official Microsoft Learn docs and code samples (.NET, Azure, Windows, PowerShell, TypeScript and more).",
    needs: "Internet. No key.", cfg: { url: "https://learn.microsoft.com/api/mcp" }, tools: ["microsoft_docs_search", "microsoft_code_sample_search", "microsoft_docs_fetch"] },
  { id: "docs-cloudflare", name: "cloudflare-docs", label: "Cloudflare docs", kind: "web",
    what: "Searches the official Cloudflare documentation (Workers, Pages, D1, R2, and more).",
    needs: "Internet. No key.", cfg: { url: "https://docs.mcp.cloudflare.com/mcp" }, tools: ["search_cloudflare_documentation", "migrate_pages_to_workers_guide"] },
  { id: "browser-playwright", name: "playwright", label: "Real browser (Playwright)", kind: "local",
    what: "Opens a real browser to test your web page: click, type, read the page, check for errors. 25 actions.",
    needs: "Node.js on this PC. The first use may download a browser (a few hundred MB).", cfg: { command: "npx", args: ["-y", "@playwright/mcp@0.0.84", "--headless"] }, tools: ["browser_navigate", "browser_click", "browser_type", "browser_snapshot", "..."] },
  { id: "memory", name: "memory", label: "Memory between chats", kind: "local",
    what: "Lets the model save and find facts (people, decisions, project notes) and remember them in later chats.",
    needs: "Node.js on this PC.", cfg: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@2.1.0"] }, tools: ["create_entities", "search_nodes", "read_graph", "..."] },
  { id: "thinking", name: "sequential-thinking", label: "Step-by-step thinking", kind: "local",
    what: "Helps a model plan a hard problem in small steps and revise its plan. Useful for small models on big tasks.",
    needs: "Node.js on this PC.", cfg: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2.1.1"] }, tools: ["sequentialthinking"] },
];

const NAME_OK = new Set(TOOL_CATALOG.map((t) => t.name));

export async function listCatalog(ws) {
  const glob = await loadMcpFile(globalMcpPath());
  const proj = ws ? await loadMcpFile(path.join(ws, ".eta", "mcp.json")) : {};
  return TOOL_CATALOG.map((t) => ({ id: t.id, name: t.name, label: t.label, kind: t.kind, what: t.what, needs: t.needs,
    added: t.name in glob ? "global" : t.name in proj ? "project" : null }));
}

// Add one catalog tool. scope "global" = all projects (default). Never overwrites a tool the user already set up.
export async function addCatalogTool({ id, ws, scope, test }) {
  const t = TOOL_CATALOG.find((x) => x.id === id); if (!t) throw new Error("I do not know that tool.");
  if (scope === "project" && !ws) throw new Error("Open a project folder first, or choose 'all projects'.");
  const p = scope === "project" ? path.join(ws, ".eta", "mcp.json") : globalMcpPath();
  let cfg = {}; try { cfg = JSON.parse(await fs.readFile(p, "utf8")); } catch {}
  const key = cfg.servers && !cfg.mcpServers ? "servers" : "mcpServers"; cfg[key] = cfg[key] || {};
  if (cfg[key][t.name]) return { ok: true, already: true, name: t.name };
  if (test) { const r = await testMcpServer(t.name, t.cfg, ws || process.cwd()); if (!r.ok) throw new Error("It did not start: " + r.error); }
  cfg[key][t.name] = JSON.parse(JSON.stringify(t.cfg));
  await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(cfg, null, 2), "utf8");
  return { ok: true, name: t.name, scope: scope === "project" ? "project" : "global" };
}
export { NAME_OK };
