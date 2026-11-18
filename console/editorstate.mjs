// D4 (2026-11-13): what the editor shows right now (open file, cursor, errors) is given to the agent as short context.
// The extension sends the state to POST /api/editor-state; the engine keeps only the newest one in memory and
// adds a small text block to a new task or question. Plain data work: no model, no network, no files.

const MAX_AGE_MS = 10 * 60 * 1000;
const L = { path: 300, msg: 200, errors: 10, open: 8 };
let state = null;

const str = (v, n) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").slice(0, n) : "");
const int = (v) => (Number.isInteger(v) && v >= 0 && v < 10_000_000 ? v : 0);
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Accepts anything; keeps only the safe, small parts. Returns the stored state.
export function setEditorState(raw, now = Date.now()) {
  const b = raw && typeof raw === "object" ? raw : {};
  const a = b.active && typeof b.active === "object" ? b.active : null;
  const problems = (Array.isArray(b.problems) ? b.problems : []).filter((p) => p && typeof p === "object")
    .map((p) => ({ path: str(p.path, L.path), line: int(p.line), severity: p.severity === "warning" ? "warning" : "error", message: str(p.message, L.msg) }))
    .filter((p) => p.path && p.message);
  state = {
    ws: str(b.ws, 400), at: now,
    active: a && str(a.path, L.path) ? { path: str(a.path, L.path), line: int(a.line), col: int(a.col) } : null,
    open: (Array.isArray(b.open) ? b.open : []).map((x) => str(x, L.path)).filter(Boolean).slice(0, L.open),
    // errors first, then warnings; the file being edited comes first inside each group
    problems: problems.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "error" ? -1 : 1)).slice(0, 40),
  };
  return state;
}
export function clearEditorState() { state = null; }

// The text block for a new task/question in folder `ws`; "" when there is nothing useful or the state is old or from another folder.
export function editorBlock(ws, now = Date.now()) {
  if (!state || !ws || norm(state.ws) !== norm(ws) || now - state.at > MAX_AGE_MS) return "";
  const errs = state.problems.filter((p) => p.severity === "error");
  const act = state.active;
  if (!act && !errs.length) return "";
  const lines = ["", "", "[What the editor shows right now — background only; the user's request above is what counts]"];
  if (act) lines.push(`Active file: ${act.path}${act.line ? `, cursor at line ${act.line}` : ""}`);
  if (state.open.length) lines.push(`Open files: ${state.open.join(", ")}`);
  if (errs.length) {
    const shown = errs.slice(0, L.errors);
    lines.push(`Errors the editor reports (${errs.length}):`);
    for (const e of shown) lines.push(`- ${e.path}${e.line ? ":" + e.line : ""} ${e.message}`);
    if (errs.length > shown.length) lines.push(`- … and ${errs.length - shown.length} more`);
  }
  return lines.join("\n");
}

export function editorSummary() { return state ? { at: state.at, active: state.active?.path || "", errors: state.problems.filter((p) => p.severity === "error").length } : null; }
