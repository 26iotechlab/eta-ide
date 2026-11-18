// Packed model format (2026-11-14): colibriPack / packedReady and the Host's "remove the GGUF only after the packed copy started".
// Uses a FAKE "coli import" (a small node script), so no model and no engine are needed.
import fs from "fs"; import os from "os"; import path from "path";
let pass = 0, fail = 0; const ok = (c, name, got) => { if (c) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name + (got !== undefined ? " (got " + JSON.stringify(got) + ")" : "")); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-pack-"));
process.env.ETA_MODELS_DIR = path.join(root, "models");
const { colibriPack, packedReady, PACKED_MARK } = await import("./colibri.mjs");
const { Host, CATALOG } = await import("./host.mjs");
const fake = path.join(root, "fake-coli.mjs");
fs.writeFileSync(fake, `import fs from "fs"; import path from "path";
const a = process.argv.slice(2); const out = a[a.indexOf("--out") + 1]; const src = a[a.length - 1];
if (process.env.FAKE_FAIL) { process.stderr.write("boom"); process.exit(3); }
fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "config.json"), "{}");
fs.writeFileSync(path.join(out, "model.colibri.gguf"), Buffer.alloc(1234));
fs.writeFileSync(path.join(out, "gguf.json"), JSON.stringify({ gguf: "model.colibri.gguf", mode: "copy", source: src }));`);
const c = { python: { cmd: process.execPath, pre: [fake] }, dir: root };
const src = path.join(root, "src.gguf"); fs.writeFileSync(src, Buffer.alloc(2000));

console.log("== colibriPack ==");
const out = path.join(root, "p1");
let r = await colibriPack(c, src, out);
ok(r.ok === true, "pack succeeds", r);
ok(packedReady(out), "packed folder is ready");
ok(!fs.existsSync(out + ".tmp"), "no temporary folder left behind");
const mk = JSON.parse(fs.readFileSync(path.join(out, PACKED_MARK), "utf8"));
ok(mk.bytes === 1234 && mk.file === "model.colibri.gguf", "marker records the packed file and its size", mk);
fs.writeFileSync(path.join(out, "model.colibri.gguf"), Buffer.alloc(10));
ok(!packedReady(out), "a packed file with the wrong size is NOT ready");

process.env.FAKE_FAIL = "1";
const out2 = path.join(root, "p2"); fs.mkdirSync(out2); fs.writeFileSync(path.join(out2, "keep.txt"), "old");
r = await colibriPack(c, src, out2);
ok(r.ok === false && /exit 3|boom|gguf.json/.test(r.error), "a failing import reports an error, never throws", r);
ok(fs.existsSync(path.join(out2, "keep.txt")) && !fs.existsSync(out2 + ".tmp"), "a failing import leaves the old folder untouched and no temp folder");
ok(!packedReady(out2), "failed pack is not ready");
delete process.env.FAKE_FAIL;
ok(!packedReady(path.join(root, "nothing-here")), "missing folder is not ready (no crash)");

console.log("== Host: installed file and removing the GGUF ==");
const host = new Host({ stateFile: path.join(root, "host.json"), getHw: async () => ({ ramGB: 8 }), isBusy: () => false, onState: () => {} });
await host.init();
const m = CATALOG.find((x) => x.id === "moe35");
const dir = host.dirFor(m); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "model.gguf"), Buffer.alloc(500));
fs.writeFileSync(path.join(root, "outside.gguf"), Buffer.alloc(5));
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ files: [{ name: "model.gguf", size: 500 }, { name: "../outside.gguf", size: 5 }] }));
ok((await host.installedFile(m)) === null || true, "setup done");
await host._dropDownloadedGguf(m);
ok(fs.existsSync(path.join(dir, "model.gguf")), "GGUF is KEPT while no packed copy is ready");
r = await colibriPack(c, path.join(dir, "model.gguf"), host.packedDir(m));
ok(r.ok && packedReady(host.packedDir(m)), "packed copy made in the model folder");
await host._dropDownloadedGguf(m);
ok(!fs.existsSync(path.join(dir, "model.gguf")) && !fs.existsSync(path.join(dir, "manifest.json")), "after the packed copy is ready: GGUF and manifest removed");
ok(fs.existsSync(path.join(root, "outside.gguf")), "a manifest entry pointing OUTSIDE the model folder is never deleted");
ok((await host.installedFile(m)) === host.packedDir(m), "the model still counts as installed (packed copy)", await host.installedFile(m));
ok(await host.installed(m), "installed() is true without the GGUF");
fs.rmSync(path.join(host.packedDir(m), PACKED_MARK));
ok((await host.installedFile(m)) === null, "broken packed copy and no GGUF: not installed (download again)");

fs.rmSync(root, { recursive: true, force: true });
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(), 100);
