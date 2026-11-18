// Test E2 (2026-11-13): every downloaded model file is checked against its SHA-256 fingerprint from Hugging Face.
// Uses temp files and a fake Hugging Face on 127.0.0.1 only. No internet, no model program, no GPU.
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-hash-"));
process.env.ETA_MODELS_DIR = path.join(tmp, "models");
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const FILE = Buffer.alloc(2_000_000); for (let i = 0; i < FILE.length; i++) FILE[i] = (i * 31) & 255;
let listing = []; let fileGets = 0;
const hf = http.createServer((req, res) => {
  if (req.url.startsWith("/api/models/")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ siblings: listing })); }
  fileGets++;
  const m = /bytes=(\d+)-/i.exec(String(req.headers.range || "")); const from = m ? +m[1] : 0; const body = FILE.subarray(from);
  res.writeHead(m ? 206 : 200, { "content-length": body.length, "content-type": "application/octet-stream" }); res.end(body);
});
await new Promise((r) => hf.listen(0, "127.0.0.1", r));
process.env.ETA_HF_BASE = "http://127.0.0.1:" + hf.address().port;

const { Host, pickFiles, sha256File, verifyDownload } = await import("./host.mjs");

try {
  console.log("== sha256File ==");
  const small = path.join(tmp, "small.bin"); const sb = Buffer.from("hello eta ide, fingerprint test");
  fs.writeFileSync(small, sb);
  ok((await sha256File(small)) === sha(sb), "small file: same as Node crypto");
  const big = path.join(tmp, "big.bin"); const bb = crypto.randomBytes(20 * 1024 * 1024); fs.writeFileSync(big, bb);
  let calls = 0, lastDone = 0, lastAll = 0;
  const bh = await sha256File(big, (d, a) => { calls++; lastDone = d; lastAll = a; });
  ok(bh === sha(bb), "20 MB file read in pieces: same as Node crypto");
  ok(calls > 1 && lastDone === bb.length && lastAll === bb.length, "progress is reported in several steps up to the full size", { calls, lastDone, lastAll });

  console.log("== verifyDownload ==");
  let v = await verifyDownload(small, sha(sb)); ok(v.ok === true && !v.skipped, "match: ok", v);
  v = await verifyDownload(small, sha(sb).toUpperCase()); ok(v.ok === true, "match with upper case fingerprint: ok", v);
  v = await verifyDownload(small, "0".repeat(64)); ok(v.ok === false && v.actual === sha(sb) && v.expected === "0".repeat(64), "mismatch: not ok, with actual and expected", v);
  v = await verifyDownload(small, undefined); ok(v.ok === true && v.skipped === true, "no fingerprint: skipped, not failed", v);
  v = await verifyDownload(small, ""); ok(v.ok === true && v.skipped === true, "empty fingerprint: skipped", v);

  console.log("== pickFiles keeps the fingerprint ==");
  const H1 = "A".repeat(64), H2 = "b".repeat(64), H3 = "c".repeat(64);
  let p = pickFiles([{ rfilename: "a-Q4_K_M.gguf", size: 5, lfs: { sha256: H1, size: 5 } }, { rfilename: "a-Q4_K_S.gguf", size: 1 }], "Q4_K_M");
  ok(p.length === 1 && p[0].name === "a-Q4_K_M.gguf" && p[0].size === 5 && p[0].sha256 === H1.toLowerCase(), "single file: name, size and lower case sha256", p);
  p = pickFiles([{ rfilename: "a-Q6_K_L-00002-of-00002.gguf", size: 2, lfs: { sha256: H3 } }, { rfilename: "a-Q6_K_L-00001-of-00002.gguf", size: 1, lfs: { sha256: H2 } }], "Q6_K_L");
  ok(p.length === 2 && p[0].name.includes("00001") && p[0].sha256 === H2 && p[1].sha256 === H3 && p[1].size === 2, "sharded files: each keeps its own sha256, in order", p);
  p = pickFiles([{ rfilename: "a-Q4_K_M.gguf", size: 7 }], "Q4_K_M");
  ok(p.length === 1 && p[0].name === "a-Q4_K_M.gguf" && p[0].size === 7 && p[0].sha256 === undefined, "no lfs data: sha256 is undefined, name and size still there", p);

  console.log("== download() against a fake Hugging Face ==");
  const host = new Host({ stateFile: path.join(tmp, "host.json"), getHw: async () => null, isBusy: () => false, onState: (s) => states.push(s.message) });
  const states = [];
  const mk = (id) => ({ id, label: "Test " + id, repo: "x/tiny-GGUF", quant: "Q4_K_M", sizeGB: 0.002, totalB: 1, activeB: 1 });
  const dirOf = (id) => path.join(process.env.ETA_MODELS_DIR, id);
  const mf = (id) => JSON.parse(fs.readFileSync(path.join(dirOf(id), "manifest.json"), "utf8"));

  // 1. right fingerprint
  listing = [{ rfilename: "tiny-Q4_K_M.gguf", size: FILE.length, lfs: { sha256: sha(FILE), size: FILE.length } }];
  await host.download(mk("good"));
  let man = mf("good");
  ok(man.files[0].verified === true && man.files[0].sha256 === sha(FILE) && man.files[0].size === FILE.length, "right fingerprint: manifest says verified, with sha256", man);
  ok(states.some((s) => /^Checking the file…/.test(s)), "status showed 'Checking the file…' while hashing");
  ok(await host.installed(mk("good")), "installed() is true after a checked download");

  // 2. wrong fingerprint
  listing = [{ rfilename: "tiny-Q4_K_M.gguf", size: FILE.length, lfs: { sha256: "f".repeat(64) } }];
  let err = null; try { await host.download(mk("bad")); } catch (e) { err = e; }
  const leftover = fs.existsSync(dirOf("bad")) ? fs.readdirSync(dirOf("bad")) : [];
  ok(err && host.s.status === "error" && host.s.error === "The downloaded file does not match the fingerprint from Hugging Face. It was deleted. Press Resume to download it again.", "wrong fingerprint: error with the exact message", host.s.error);
  ok(!leftover.includes("tiny-Q4_K_M.gguf") && !leftover.some((f) => f.endsWith(".part")) && !leftover.includes("manifest.json"), "wrong fingerprint: bad file and .part deleted, no manifest", leftover);
  ok(!(await host.installed(mk("bad"))), "wrong fingerprint: not installed");

  // 3. no fingerprint from the API
  listing = [{ rfilename: "tiny-Q4_K_M.gguf", size: FILE.length }];
  await host.download(mk("nohash"));
  man = mf("nohash");
  ok(host.s.status !== "error" && man.files[0].verified === false && !("sha256" in man.files[0]), "no fingerprint: download still works, manifest says verified false", man);
  ok(await host.installed(mk("nohash")), "installed() still true for a verified false entry (size check only)");

  // 4. resume: a complete file already on disk is checked too
  listing = [{ rfilename: "tiny-Q4_K_M.gguf", size: FILE.length, lfs: { sha256: sha(FILE) } }];
  fs.rmSync(path.join(dirOf("good"), "manifest.json")); const before = fileGets; states.length = 0;
  await host.download(mk("good"));
  ok(fileGets === before && mf("good").files[0].verified === true && states.some((s) => /^Checking the file…/.test(s)), "resume: complete good file is checked, not downloaded again", { gets: fileGets - before });
  const corrupt = Buffer.from(FILE); corrupt[12345] ^= 1; fs.writeFileSync(path.join(dirOf("good"), "tiny-Q4_K_M.gguf"), corrupt);
  fs.rmSync(path.join(dirOf("good"), "manifest.json"));
  err = null; try { await host.download(mk("good")); } catch (e) { err = e; }
  ok(err && host.s.status === "error" && !fs.existsSync(path.join(dirOf("good"), "tiny-Q4_K_M.gguf")), "resume: a complete file with the right size but wrong bytes is found and deleted", host.s.error);
  // after the error, Resume downloads it again and the check passes
  await host.download(mk("good"));
  ok(mf("good").files[0].verified === true && host.s.status !== "error", "Resume after the error: downloaded again and checked");

  // 5. sharded model: every shard is checked
  const A = FILE.subarray(0, 1_000_000), B = FILE.subarray(1_000_000);
  listing = [{ rfilename: "s-Q4_K_M-00001-of-00002.gguf", size: A.length, lfs: { sha256: sha(A) } }, { rfilename: "s-Q4_K_M-00002-of-00002.gguf", size: B.length, lfs: { sha256: sha(B) } }];
  fs.mkdirSync(dirOf("shard"), { recursive: true }); fs.writeFileSync(path.join(dirOf("shard"), "s-Q4_K_M-00001-of-00002.gguf"), A); fs.writeFileSync(path.join(dirOf("shard"), "s-Q4_K_M-00002-of-00002.gguf"), B);
  await host.download(mk("shard")); man = mf("shard");
  ok(man.files.length === 2 && man.files.every((f) => f.verified === true), "sharded: both shards checked", man);
  fs.writeFileSync(path.join(dirOf("shard"), "s-Q4_K_M-00002-of-00002.gguf"), Buffer.alloc(B.length)); fs.rmSync(path.join(dirOf("shard"), "manifest.json"));
  err = null; try { await host.download(mk("shard")); } catch (e) { err = e; }
  ok(err && !fs.existsSync(path.join(dirOf("shard"), "s-Q4_K_M-00002-of-00002.gguf")) && fs.existsSync(path.join(dirOf("shard"), "s-Q4_K_M-00001-of-00002.gguf")), "sharded: only the bad shard is deleted");
  host.shutdown?.();
} catch (e) { fail++; console.log("  FAIL  test crashed: " + (e.stack || e)); }
hf.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
