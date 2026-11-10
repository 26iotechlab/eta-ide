// visualrag.mjs — PixelRAG-style visual search (2026-07-22): render a candidate page as a
// screenshot and rank it against a natural-language query using a LOCAL vision-language
// embedding model — no text-scraping, so tables/charts/diagrams that open_url's HTML-to-text
// path would mangle stay intact. SAME mechanism as imagelab.mjs's object detector: a small
// model pulled via transformers.js's pipeline() API (auto-download, disk-cached in .hf-cache,
// pure ONNX runtime — no cloud, no GPU driver required). CLIP is a DUAL encoder: an image and a
// text pipeline share one embedding space, so a screenshot and the words describing it land
// close together with no OCR/parsing step in between.
//
// Deliberately NO persistent FAISS-style index (PixelRAG's own headline feature is a pre-built
// 8.28M-page Wikipedia index) — Eta's usage pattern is a handful of candidate URLs per task, not
// a standing corpus, so an in-memory rank-and-return per call is the right scope; a real
// on-disk vector index would be premature complexity for a use case this size.
import * as path from "path";
import { fileURLToPath } from "url";
import { screenshotPage } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// LIVE-CAUGHT (2026-07-22): the generic pipeline("feature-extraction", ...) task name is NOT
// CLIP-aware — it does not resolve to the model's dedicated text tower and instead chases a
// combined "model_quantized.onnx" file that doesn't cleanly exist for this repo, leaving a
// dead partial download that never completes (confirmed: two separate stuck .tmp files, 19MB
// and 24MB, neither ever finishing). The vision side is fine as-is (pipeline("image-feature-
// extraction", ...) correctly resolves to vision_model_quantized.onnx and returns the real
// 512-dim CLIP-PROJECTED embedding, verified — not just any 512 numbers, but the same
// projection space text_embeds lands in). Fix: use CLIPTextModelWithProjection + AutoTokenizer
// directly for text, which resolves to the correct, separate text_model_quantized.onnx (64.5MB,
// verified downloads cleanly and produces a [1, 512] text_embeds tensor — the exact shape
// needed to be comparable to the vision side via cosine similarity).
let _imgEmbed = null, _txtModel = null, _tokenizer = null;
async function getImgEmbedder() {
  if (_imgEmbed) return _imgEmbed;
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(HERE, ".hf-cache"); // same cache dir imagelab.mjs already uses
  _imgEmbed = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32", { dtype: "q8" });
  return _imgEmbed;
}
async function getTextEmbedder() {
  if (_txtModel && _tokenizer) return { model: _txtModel, tokenizer: _tokenizer };
  const { AutoTokenizer, CLIPTextModelWithProjection, env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(HERE, ".hf-cache");
  _tokenizer = await AutoTokenizer.from_pretrained("Xenova/clip-vit-base-patch32");
  _txtModel = await CLIPTextModelWithProjection.from_pretrained("Xenova/clip-vit-base-patch32", { dtype: "q8" });
  return { model: _txtModel, tokenizer: _tokenizer };
}

export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export async function embedImageFile(absPath) {
  const img = await getImgEmbedder();
  return Array.from((await img(absPath)).data);
}
export async function embedQueryText(text) {
  const { model, tokenizer } = await getTextEmbedder();
  const inputs = await tokenizer([String(text)], { padding: true, truncation: true });
  const out = await model(inputs);
  return Array.from(out.text_embeds.data);
}

function slugForUrl(url) {
  return String(url).replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
}

// Screenshot each candidate URL (bounded to 6 — this is a per-task check, not a crawl), embed
// it, and rank by cosine similarity to the query's text embedding. A URL that fails to
// screenshot or embed is skipped (not fatal to the rest) and reported via `emit`.
export async function visualRank(root, query, urls, emit = () => {}) {
  const qVec = await embedQueryText(query);
  const results = [];
  for (const url of urls.slice(0, 6)) {
    const outRel = `.eta/visual-rag/${slugForUrl(url)}.png`;
    let shot;
    try { shot = await screenshotPage(root, url, outRel); }
    catch (e) { emit(`visual_search: couldn't screenshot ${url} — ${String(e?.message || e).slice(0, 120)}`); continue; }
    if (!shot.ok) { emit(`visual_search: couldn't screenshot ${url} — ${shot.error}`); continue; }
    try {
      const vec = await embedImageFile(path.resolve(root, outRel));
      results.push({ url, screenshot: outRel, score: cosineSim(qVec, vec) });
    } catch (e) { emit(`visual_search: couldn't embed ${url} — ${String(e?.message || e).slice(0, 120)}`); }
  }
  return results.sort((a, b) => b.score - a.score);
}
