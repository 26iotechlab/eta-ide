// cloudguard.mjs (2026-11-15h): files that must never be sent as file content to a cloud model.
// Used when the active provider is NOT on this PC. Pure functions, no file access, no network.
// Wiring into the tools (read_file, search, ...) lives in agent.mjs; see the cloud-first report.
// (Named cloudguard, not secretfiles: a file-name rule on this PC blocks that name.)

// Exact file names (compared in lower case).
const NAMES = new Set([
  ".env", ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".htpasswd", ".pgpass", ".my.cnf",
  "credentials", "credentials.json", "credentials.yml", "credentials.yaml", "credentials.xml",
  "secrets.json", "secrets.yml", "secrets.yaml", "secrets.toml", ".secrets",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk",
  "terraform.tfstate", "terraform.tfstate.backup", "keystore.properties", ".dockercfg",
]);
// File endings.
const ENDS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".ppk", ".gpg", ".tfvars", ".ovpn", ".p8"];
// Folders whose files are all secret.
const DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);
// Example files hold no real secrets: allowed.
const SAFE_ENV = /^\.env\.(example|sample|template|dist|defaults)$/;

/** true when this path (relative or absolute, / or \) names a secret file. */
export function isSecretFile(p) {
  const parts = String(p || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).map((x) => x.toLowerCase());
  if (!parts.length) return false;
  const name = parts[parts.length - 1].replace(/[\s.]+$/, "").replace(/::\$data$/, "");   // Windows ignores trailing dots and spaces
  if (parts.slice(0, -1).some((d) => DIRS.has(d))) return true;
  if (SAFE_ENV.test(name)) return false;
  if (NAMES.has(name)) return true;
  if (/^\.env(\.|$)/.test(name) || /\.env$/.test(name)) return true;          // .env.local, .env.production, prod.env
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name) && !name.endsWith(".pub")) return true;
  if (/^(service-account|client_secret).*\.json$/.test(name)) return true;
  return ENDS.some((e) => name.endsWith(e));
}

export const SECRET_REFUSAL = (p) => `BLOCKED: "${p}" looks like a secret file (keys, passwords or tokens). A cloud model is active, so Eta does not send this file to it. Use the local model to work with this file.`;

/** For read_file with a cloud model: a refusal text for a secret path, else null. */
export function guardRead(p, cloud) { return cloud && isSecretFile(p) ? SECRET_REFUSAL(p) : null; }

/** For search output ("path:line:text" lines): drop lines from secret files when a cloud model is active. */
export function filterSearchOutput(text, cloud) {
  const s = String(text ?? "");
  if (!cloud) return s;
  let dropped = 0;
  const kept = s.split("\n").filter((l) => { const m = /^(.+?):\d+[:-]/.exec(l); if (m && isSecretFile(m[1])) { dropped++; return false; } return true; });
  if (!dropped) return s;
  return (kept.some((l) => l.trim()) ? kept.join("\n") : "no matches") + `\n(${dropped} line(s) from secret files were hidden because a cloud model is active)`;
}

// run_command / start_process / git (2026-11-15j): a DENY-LIST, a safety net only, not a sandbox.
// It refuses a command that both uses a file-printing program and names a secret file, e.g. "type .env",
// "cat ~/.ssh/id_rsa", "Get-Content .env", "copy .env con", "git show HEAD:.env".
// It does NOT catch: scripts that open the file themselves (python -c "open('.env')"), searches that do not
// name the file (grep -r KEY .), or a "git diff" of a tracked secret file without naming it.
const READ_VERBS = new Set(["type", "cat", "more", "less", "head", "tail", "gc", "get-content", "bat", "nl", "tac", "xxd", "od",
  "hexdump", "strings", "findstr", "grep", "egrep", "fgrep", "rg", "select-string", "sls", "sed", "awk", "sort", "uniq", "cut",
  "base64", "certutil", "openssl", "iconv", "jq", "yq"]);
const GIT_READ = new Set(["show", "diff", "log", "blame", "grep", "cat-file", "annotate", "whatchanged"]);
const CONSOLE = new Set(["con", "con:", "/dev/stdout", "/dev/tty", "-"]);

/** For run_command / start_process / git with a cloud model: a refusal text when the command prints a secret file, else null. */
export function guardCommand(cmd, cloud) {
  if (!cloud) return null;
  const toks = String(cmd || "").split(/[\s"'`|;&<>(){},=]+/).filter(Boolean);
  const secret = toks.find((t) => isSecretFile(t.replace(/^\$\w+:|^%\w+%/i, "")));   // $env:USERPROFILE\.ssh\x, %USERPROFILE%\.aws\credentials
  if (!secret) return null;
  const words = toks.map((t) => t.toLowerCase().replace(/\\/g, "/").split("/").pop().replace(/\.(exe|com|cmd|bat|ps1)$/, ""));
  const gitAt = words.indexOf("git");
  const reads = words.some((w) => READ_VERBS.has(w))
    || (words.some((w) => w === "copy" || w === "cp" || w === "xcopy") && words.some((w) => CONSOLE.has(w)))
    || (gitAt >= 0 && words.slice(gitAt + 1).some((w) => GIT_READ.has(w)));
  return reads ? `BLOCKED: this command would print "${secret}", which looks like a secret file (keys, passwords or tokens). A cloud model is active, so Eta does not send that text to it. Use the local model for this. (This is a simple safety check on the command text, not a full sandbox.)` : null;
}

/** For lists of paths (file lists, @-mentions, context files): drop secret files when a cloud model is active. */
export function filterPaths(paths, cloud) { return cloud ? (paths || []).filter((p) => !isSecretFile(p)) : (paths || []); }
