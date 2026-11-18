// facts.mjs - measured facts about THIS PC and THIS run, taken fresh at the start of each run
// (never remembered between runs: a user can install pytest between two runs).
// Rule 3 (measured world): plan decisions read these facts instead of assuming.
import { execFile } from "node:child_process";

// async on purpose: the engine server must never freeze while Python starts
function tryPy(args) {
  return new Promise((resolve) => {
    try { execFile("python", args, { timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim())); } catch { resolve(null); }
  });
}

export async function measureFacts({ numCtx = 0, autoApprove = false, run = tryPy } = {}) {
  const [ver, pt] = await Promise.all([Promise.resolve(run(["--version"])), Promise.resolve(run(["-c", "import pytest;print(1)"]))]);
  const python = !!ver;
  const pytest = python && pt === "1";
  return {
    python, pythonVersion: python ? ver.replace(/^Python\s*/i, "") : "",
    pytest,
    window: Number(numCtx) || 0,
    personPresent: !autoApprove,   // approvals mean someone is watching; auto-approve means nobody may be
    at: new Date().toISOString(),
  };
}

export function factsLine(f) {
  return `PC facts: python ${f.python ? f.pythonVersion : "NOT FOUND"}, pytest ${f.pytest ? "yes" : "no"}, model window ${f.window || "unknown"} tokens, ${f.personPresent ? "you approve edits" : "edits are auto-approved"}`;
}

// Which plan decisions the facts change (pure, tested):
export function factsWarnings(f, task = "") {
  const w = [];
  const wantsPy = /\.py\b|\bpython\b|\bpytest\b|\bunittest\b/i.test(String(task));
  if (wantsPy && !f.python) w.push("Python was not found on this PC, so Python code cannot be run or tested here. Install Python, or I can only write the files.");
  if (f.window && f.window < 4096) w.push(`The model window is only ${f.window} tokens, so long files will be read in small pieces.`);
  return w;
}
