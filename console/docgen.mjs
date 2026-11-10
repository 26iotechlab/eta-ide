// ---- READERS: extract text/data from existing .docx / .xlsx (input side) ----
// Uses adm-zip (bundled) to open the OOXML package, then targeted regex on the XML.
import AdmZip from "adm-zip";
const _unent = (s) => String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
export function readDocx(buf) {
  const zip = new AdmZip(buf);
  const xmlEntry = zip.getEntry("word/document.xml");
  if (!xmlEntry) throw new Error("not a valid .docx (no word/document.xml)");
  const xml = zip.readAsText(xmlEntry);
  // each <w:p> is a paragraph; text lives in <w:t>…</w:t>
  const paras = xml.split(/<w:p[ >]/).slice(1).map((p) => {
    const t = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => _unent(m[1])).join("");
    return t;
  });
  return paras.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function readXlsx(buf) {
  const zip = new AdmZip(buf);
  const sheetEntry = zip.getEntry("xl/worksheets/sheet1.xml") || zip.getEntries().find((e) => /xl\/worksheets\/.*\.xml$/.test(e.entryName));
  if (!sheetEntry) throw new Error("not a valid .xlsx (no worksheet)");
  const sharedEntry = zip.getEntry("xl/sharedStrings.xml");
  const shared = sharedEntry ? [...zip.readAsText(sharedEntry).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => _unent([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""))) : [];
  const xml = zip.readAsText(sheetEntry);
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1], inner = cm[2];
      const t = (attrs.match(/\bt="([^"]*)"/) || [])[1];
      let val = "";
      if (t === "s") { const idx = (inner.match(/<v>(\d+)<\/v>/) || [])[1]; val = shared[+idx] || ""; }
      else if (t === "inlineStr" || t === "str") { val = _unent([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")) || _unent((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || ""); }
      else { val = _unent((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || ""); }
      cells.push(val);
    }
    rows.push(cells);
  }
  return rows;
}

// PDF text extraction (input side, for e.g. doc_to_skill) — pdfjs-dist's "legacy" build runs
// headless in plain Node (no DOM/canvas needed for text-layer extraction). Returns one string
// per page; a scanned/image-only PDF page returns "" (no OCR fallback here — analyze_image
// already does OCR for images; a future upgrade could screenshot+OCR blank pages if needed).
export async function readPdf(buf) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str || "").join(" ").replace(/\s+/g, " ").trim());
  }
  return pages;
}

// EPUB text extraction — an EPUB is a zip of XHTML "spine" items in reading order, pointed to
// by an OPF manifest (itself found via META-INF/container.xml). Same hand-rolled zip+regex
// approach as readDocx/readXlsx above, no XML/EPUB library needed. Returns one string per
// spine item (each is USUALLY one chapter, which conveniently gives doc_to_skill real chapter
// boundaries for free — unlike PDF/DOCX, which need heuristic splitting).
export function readEpub(buf) {
  const zip = new AdmZip(buf);
  const containerEntry = zip.getEntry("META-INF/container.xml");
  if (!containerEntry) throw new Error("not a valid .epub (no META-INF/container.xml)");
  const containerXml = zip.readAsText(containerEntry);
  const opfPath = (containerXml.match(/full-path="([^"]+)"/) || [])[1];
  if (!opfPath) throw new Error("not a valid .epub (no OPF path in container.xml)");
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error("not a valid .epub (OPF file missing)");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opfXml = zip.readAsText(opfEntry);
  const manifest = new Map();
  for (const m of opfXml.matchAll(/<item\b([^>]*)\/?>/g)) {
    const id = (m[1].match(/\bid="([^"]+)"/) || [])[1];
    const href = (m[1].match(/\bhref="([^"]+)"/) || [])[1];
    if (id && href) manifest.set(id, href);
  }
  const spine = [...opfXml.matchAll(/<itemref\b([^>]*)\/?>/g)]
    .map((m) => (m[1].match(/\bidref="([^"]+)"/) || [])[1]).filter(Boolean);
  const chapters = [];
  for (const id of spine) {
    const href = manifest.get(id);
    if (!href) continue;
    const entry = zip.getEntry(opfDir + href);
    if (!entry) continue;
    const xhtml = zip.readAsText(entry);
    const text = _unent(xhtml.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ").trim();
    if (text) chapters.push(text);
  }
  return chapters;
}

// docgen.mjs — create real Office documents (.docx, .xlsx) with ZERO dependencies.
// Office Open XML files are just ZIP archives of XML parts, so we hand-roll a tiny
// STORE-method ZIP writer (no compression, no deflate lib needed). Keeps the engine
// self-contained — no node_modules required, works the same in dev and the fork.

// ---- minimal stored-ZIP writer (CRC32 + local/central headers + EOCD) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zipStore(entries) {
  const local = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // time, date (arbitrary valid)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, eocd]);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- DOCX: text/markdown-lite -> Word document ----
// Supports: # H1, ## H2, ### H3, "- " bullets, blank lines, plain paragraphs.
export function buildDocx(text) {
  const runProps = (bold, size) => `<w:rPr>${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""}</w:rPr>`;
  const para = (content, bold = false, size = 0, bullet = false) => {
    const pPr = bullet ? `<w:pPr><w:ind w:left="360"/></w:pPr>` : "";
    return `<w:p>${pPr}<w:r>${runProps(bold, size)}<w:t xml:space="preserve">${xml(content)}</w:t></w:r></w:p>`;
  };
  const body = String(text).replace(/\r\n/g, "\n").split("\n").map((line) => {
    const l = line.trimEnd();
    if (/^###\s+/.test(l)) return para(l.replace(/^###\s+/, ""), true, 24);
    if (/^##\s+/.test(l)) return para(l.replace(/^##\s+/, ""), true, 28);
    if (/^#\s+/.test(l)) return para(l.replace(/^#\s+/, ""), true, 36);
    if (/^[-*]\s+/.test(l)) return para("• " + l.replace(/^[-*]\s+/, ""), false, 0, true);
    if (!l) return `<w:p/>`;
    return para(l);
  }).join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zipStore([
    { name: "[Content_Types].xml", data: ct },
    { name: "_rels/.rels", data: rels },
    { name: "word/document.xml", data: doc },
  ]);
}

// ---- XLSX: rows (array of arrays) -> spreadsheet ----
export function colName(n) { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
export function csvToRows(csv) {
  const rows = []; let row = [], field = "", q = false;
  const s = String(csv).replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
export function buildXlsx(rows) {
  const sheetRows = rows.map((cells, r) => {
    const cs = cells.map((val, c) => {
      const ref = colName(c) + (r + 1);
      const num = val !== "" && val != null && !isNaN(val) && isFinite(Number(val));
      return num
        ? `<c r="${ref}"><v>${Number(val)}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(val)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cs}</row>`;
  }).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zipStore([
    { name: "[Content_Types].xml", data: ct },
    { name: "_rels/.rels", data: rels },
    { name: "xl/workbook.xml", data: wb },
    { name: "xl/_rels/workbook.xml.rels", data: wbRels },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}
