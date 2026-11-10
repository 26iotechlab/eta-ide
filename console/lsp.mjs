// Engine-side client for the LSP bridge that the eta-agent EXTENSION hosts.
// The strategic core of Eta's language-intelligence layer: the extension answers
// these calls using VS Code's OWN language APIs (executeDefinitionProvider,
// getDiagnostics, executeHoverProvider, executeReferenceProvider), so the agent
// gets REAL type errors / definitions / references to verify against — without us
// writing an LSP client from scratch (VS Code already runs the servers).
//
// When Eta runs standalone (no fork, so no ETA_LSP_BRIDGE), every call degrades to
// null and the agent silently falls back to its existing parse/run verification.
const bridge = () => (process.env.ETA_LSP_BRIDGE || "").replace(/\/+$/, "");
export function lspAvailable() { return !!bridge(); }

async function call(op, payload, timeoutMs = 6000) {
  const base = bridge(); if (!base) return null;
  try {
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const r = await fetch(base + "/lsp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, ...payload }), signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Real diagnostics for a file → [{severity,message,line,character,source,code}] or
// null when the bridge is unavailable (distinct from [] = "checked, no problems").
export async function diagnostics(pathRel, timeoutMs = 7000) {
  const r = await call("diagnostics", { path: pathRel }, timeoutMs);
  return r ? (r.diagnostics || []) : null;
}
// Symbol-oriented (LLM-friendly: pass an identifier NAME, not a column). The bridge
// locates the symbol in the file, then runs the corresponding VS Code provider.
export async function definition(pathRel, symbol, line) { const r = await call("definition", { path: pathRel, symbol, line }); return r ? (r.locations || []) : null; }
export async function references(pathRel, symbol, line) { const r = await call("references", { path: pathRel, symbol, line }); return r ? (r.locations || []) : null; }
export async function hover(pathRel, symbol, line) { const r = await call("hover", { path: pathRel, symbol, line }); return r ? (r.hover || "") : null; }
// Project-wide safe rename via the language server (a real refactor). Applies the
// edit across every file and saves. Returns {ok, files, edits, changedFiles} or null.
export async function rename(pathRel, symbol, newName, line) { return await call("rename", { path: pathRel, symbol, newName, line }, 15000); }

export const errorsOnly = (diags) => (diags || []).filter((d) => d.severity === "error");
export function fmtDiagnostics(diags, cap = 12) {
  if (!diags || !diags.length) return "";
  const lines = diags.slice(0, cap).map((d) => `  ${d.severity} [line ${d.line}] ${d.message}${d.source ? " (" + d.source + ")" : ""}`);
  if (diags.length > cap) lines.push(`  …and ${diags.length - cap} more`);
  return lines.join("\n");
}
