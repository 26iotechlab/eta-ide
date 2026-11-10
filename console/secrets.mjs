// Secure-at-rest storage for cloud API keys. Instead of writing the key in
// plaintext in config.json, we encrypt it so someone reading the file can't lift
// your key. Dependency-free, best-effort per platform:
//   • Windows → DPAPI (user-scoped) via PowerShell — only THIS user on THIS machine
//     can decrypt. The real "OS keychain" story on Windows.
//   • Fallback → AES-256-GCM with a 0600-permission key file (much better than
//     plaintext, though not keychain-grade).
// Every value is tagged so decrypt knows which scheme produced it; legacy plaintext
// keys from older configs still load (and get re-encrypted on the next save).
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

const run = promisify(execFile);
const DPAPI = "dpapi:", AES = "aes:", PLAIN = "plain:";

async function dpapiEncrypt(plain) {
  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $env:ETA_SEC -AsPlainText -Force)"],
    { env: { ...process.env, ETA_SEC: plain }, windowsHide: true });
  return DPAPI + stdout.trim();
}
async function dpapiDecrypt(token) {
  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "$ss=ConvertTo-SecureString -String $env:ETA_ENC; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)"],
    { env: { ...process.env, ETA_ENC: token.slice(DPAPI.length) }, windowsHide: true });
  return stdout.replace(/\r?\n$/, "");
}

async function localKey() {
  const p = path.join(os.homedir(), ".eta-ide", ".secretkey");
  try { return Buffer.from((await fsp.readFile(p, "utf8")).trim(), "hex"); }
  catch {
    const k = crypto.randomBytes(32);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, k.toString("hex"), { mode: 0o600 });
    try { await fsp.chmod(p, 0o600); } catch {}
    return k;
  }
}
async function aesEncrypt(plain) {
  const key = await localKey(), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return AES + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
async function aesDecrypt(token) {
  const key = await localKey(), raw = Buffer.from(token.slice(AES.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

export async function encryptSecret(plain) {
  if (!plain) return "";
  if (process.platform === "win32") { try { return await dpapiEncrypt(plain); } catch { /* fall through */ } }
  try { return await aesEncrypt(plain); } catch { return PLAIN + Buffer.from(plain, "utf8").toString("base64"); }
}
export async function decryptSecret(token) {
  if (!token) return "";
  try {
    if (token.startsWith(DPAPI)) return await dpapiDecrypt(token);
    if (token.startsWith(AES)) return await aesDecrypt(token);
    if (token.startsWith(PLAIN)) return Buffer.from(token.slice(PLAIN.length), "base64").toString("utf8");
    return token; // legacy plaintext key from an older config — accepted, re-encrypted on next save
  } catch { return ""; }
}
