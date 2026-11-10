// Non-LLM image analysis: deterministic pixel statistics (jimp, pure JS) + OCR
// (tesseract.js, WASM). Turns a pasted image into a dense TEXT report that a
// text-only model (Eta) can reason about — no vision model, no GPU, no cloud.
//
//   pixels  -> size, dark/light theme, dominant colors, where the content sits
//   OCR     -> every readable string (error dialogs, code, UI labels)
import * as path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

// webp support (Google image downloads are frequently .webp): decode with
// @jsquash/webp directly — its lazy wasm load uses fetch() (browser-first),
// which fails in Node, so we init the decoder with wasm bytes read from disk
// and build the Jimp image from the raw bitmap ourselves.
let _webpDecode = null;
async function decodeWebp(buf) {
  if (!_webpDecode) {
    const mod = await import("@jsquash/webp/decode.js");
    const { readFile } = await import("fs/promises");
    const { createRequire } = await import("module");
    const req = createRequire(import.meta.url);
    const wasmPath = req.resolve("@jsquash/webp/decode.js").replace(/decode\.js$/, "") + "codec/dec/webp_dec.wasm";
    await mod.init(await WebAssembly.compile(await readFile(wasmPath)));
    _webpDecode = mod.default;
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const d = await _webpDecode(ab); // { data, width, height }
  return Jimp.fromBitmap({ data: Buffer.from(d.data), width: d.width, height: d.height });
}
const isWebp = (buf) => buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- OCR worker (lazy singleton; traineddata cached on disk after first run) ----
let _worker = null;
async function getWorker() {
  if (_worker) return _worker;
  const { createWorker } = await import("tesseract.js");
  _worker = await createWorker("eng", 1, { cachePath: path.join(HERE, ".ocr-cache"), errorHandler: () => {} });
  return _worker;
}

const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

// ---- object detection (DETR via transformers.js — small vision net, NOT an LLM;
// q8 on CPU ~3s/image, model disk-cached in .hf-cache) ----
let _detector = null;
async function getDetector() {
  if (_detector) return _detector;
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = path.join(HERE, ".hf-cache");
  _detector = await pipeline("object-detection", "Xenova/detr-resnet-50", { dtype: "q8" });
  return _detector;
}
async function detectObjects(img) {
  // uniform input for the detector: temp PNG on disk
  const { writeFile, unlink } = await import("fs/promises");
  const os = await import("os");
  const tmp = path.join(os.tmpdir(), "eta-det-" + Date.now() + ".png");
  await writeFile(tmp, await img.clone().getBuffer("image/png"));
  try {
    const detector = await getDetector();
    const out = await detector(tmp, { threshold: 0.6 });
    const W = img.bitmap.width, H = img.bitmap.height;
    const items = out.slice(0, 12).map((o) => {
      const b = o.box; const cx = (b.xmin + b.xmax) / 2 / W, cy = (b.ymin + b.ymax) / 2 / H;
      const area = ((b.xmax - b.xmin) * (b.ymax - b.ymin)) / (W * H);
      const posX = cx < 0.34 ? "left" : cx > 0.66 ? "right" : "center";
      const posY = cy < 0.34 ? "top" : cy > 0.66 ? "bottom" : "middle";
      return { label: o.label, score: Math.round(o.score * 100), size: area > 0.15 ? "large" : area > 0.04 ? "medium" : "small", pos: `${posY}-${posX}` };
    });
    const counts = {};
    for (const it of items) counts[it.label] = (counts[it.label] || 0) + 1;
    return { items, counts };
  } finally { try { await unlink(tmp); } catch {} }
}

export async function analyzeImage(buf) {
  const img = isWebp(buf) ? await decodeWebp(buf) : await Jimp.read(buf);
  const { width, height } = img.bitmap;

  // work on a downscaled copy for speed
  const small = img.clone();
  if (width > 400) small.resize({ w: 400 });
  const W = small.bitmap.width, H = small.bitmap.height, D = small.bitmap.data;

  // luminance stats + color buckets (quantize to 48-step cube) + 3x3 content map
  const buckets = new Map();
  const cells = Array.from({ length: 9 }, () => ({ n: 0, sum: 0, sq: 0 }));
  let lumSum = 0, n = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * 4, r = D[i], g = D[i + 1], b = D[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumSum += lum; n++;
    const q = `${Math.round(r / 48) * 48},${Math.round(g / 48) * 48},${Math.round(b / 48) * 48}`;
    buckets.set(q, (buckets.get(q) || 0) + 1);
    const cell = cells[Math.min(2, Math.floor(y / (H / 3))) * 3 + Math.min(2, Math.floor(x / (W / 3)))];
    cell.n++; cell.sum += lum; cell.sq += lum * lum;
  }
  const meanLum = lumSum / Math.max(1, n);
  const colors = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, c]) => { const [r, g, b] = k.split(",").map(Number); return `${hex(Math.min(255, r), Math.min(255, g), Math.min(255, b))} (${Math.round((c / n) * 100)}%)`; });
  const CELL_NAMES = ["top-left", "top-center", "top-right", "mid-left", "center", "mid-right", "bottom-left", "bottom-center", "bottom-right"];
  const busy = cells.map((c, i) => ({ i, sd: Math.sqrt(Math.max(0, c.sq / Math.max(1, c.n) - (c.sum / Math.max(1, c.n)) ** 2)) }))
    .filter((c) => c.sd > 12).map((c) => CELL_NAMES[c.i]);

  // OCR (downscale very large images first; tolerate failure)
  let text = "", conf = 0;
  try {
    let ocrBuf = isWebp(buf) ? await img.clone().getBuffer("image/png") : buf;
    if (width > 1800) ocrBuf = await img.clone().resize({ w: 1600 }).getBuffer("image/png");
    const worker = await getWorker();
    let { data } = await worker.recognize(ocrBuf);
    text = (data.text || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000);
    conf = Math.round(data.confidence || 0);
    // second-chance pass for tiny/low-contrast text: upscale + grayscale + contrast
    if (text.length < 12 || conf < 45) {
      const prep = img.clone().greyscale().contrast(0.45);
      if (width < 1400) prep.resize({ w: Math.min(2400, width * 3) });
      const r2 = await worker.recognize(await prep.getBuffer("image/png"));
      const t2 = (r2.data.text || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000);
      if (t2.length > text.length + 8) { text = t2; conf = Math.round(r2.data.confidence || 0); }
    }
  } catch (e) { text = ""; conf = 0; }
  // photos yield low-confidence garbage fragments — keep only lines with real
  // alphanumeric content, and drop the lot when it's still just noise
  text = text.split("\n").filter((l) => (l.match(/[a-zA-Z0-9]/g) || []).length >= 3).join("\n").trim();
  if (conf < 55 && text.replace(/[^a-zA-Z0-9]/g, "").length < 12) text = "";

  // ---- EXIF metadata (photos carry camera/GPS/date — a VLM can't even see this) ----
  let exifLine = "";
  try {
    const exifr = (await import("exifr")).default;
    const ex = await exifr.parse(buf, { pick: ["Make", "Model", "DateTimeOriginal", "latitude", "longitude"] });
    if (ex && (ex.Make || ex.latitude || ex.DateTimeOriginal)) {
      const bits = [];
      if (ex.Make || ex.Model) bits.push(`camera: ${[ex.Make, ex.Model].filter(Boolean).join(" ")}`);
      if (ex.DateTimeOriginal) bits.push(`taken: ${new Date(ex.DateTimeOriginal).toISOString().slice(0, 10)}`);
      if (typeof ex.latitude === "number") bits.push(`GPS: ${ex.latitude.toFixed(4)}, ${ex.longitude.toFixed(4)}`);
      exifLine = bits.join(" · ");
    }
  } catch {}

  // ---- QR code decoding (deterministic) ----
  let qrText = "";
  try {
    const jsQR = (await import("jsqr")).default;
    const qi = img.bitmap.width > 1200 ? img.clone().resize({ w: 1000 }) : img;
    const q = jsQR(new Uint8ClampedArray(qi.bitmap.data), qi.bitmap.width, qi.bitmap.height);
    if (q?.data) qrText = q.data.slice(0, 500);
  } catch {}

  // ---- object detection router: run the vision net only on photo-like images
  // (screenshots are dominated by one flat color and full of text — skip) ----
  const topShare = buckets.size ? [...buckets.values()].sort((a, b) => b - a)[0] / n : 1;
  let objects = null;
  if (topShare < 0.55 || (!text && !qrText) || exifLine) {
    try { objects = await detectObjects(img); } catch { objects = null; }
  }

  let objLines = "";
  if (objects && objects.items.length) {
    const summary = Object.entries(objects.counts).map(([l, c]) => `${c} × ${l}`).join(", ");
    const detail = objects.items.slice(0, 8).map((o) => `  ${o.label} (${o.score}%, ${o.size}, ${o.pos})`).join("\n");
    objLines = `- OBJECTS DETECTED (DETR neural net): ${summary}\n${detail}\n`;
  } else if (objects) {
    objLines = `- no common objects detected (80-class detector)\n`;
  }
  const report =
    `IMAGE ANALYSIS (specialist models + deterministic CV — no LLM):\n` +
    `- ${width}x${height}px, ${meanLum < 90 ? "dark" : meanLum > 165 ? "light" : "mid-tone"} theme (mean luminance ${Math.round((meanLum / 255) * 100)}%)\n` +
    `- dominant colors: ${colors.join(", ")}\n` +
    `- visual content concentrated: ${busy.length ? busy.join(", ") : "evenly / sparse"}\n` +
    (exifLine ? `- PHOTO METADATA (EXIF): ${exifLine}\n` : "") +
    (qrText ? `- QR CODE DECODED: "${qrText}"\n` : "") +
    objLines +
    (text ? `- TEXT FOUND VIA OCR (confidence ${conf}%):\n"""\n${text}\n"""` : `- no readable text detected`);
  return { width, height, meanLum, colors, busy, text, conf, exif: exifLine, qr: qrText, objects, report };
}

export async function closeImageLab() { try { if (_worker) await _worker.terminate(); } catch {} _worker = null; }
