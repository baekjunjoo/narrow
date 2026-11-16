// Manuscripts are read exclusively from the selected File. No document URL,
// PDF action, annotation, image, or OOXML relationship is followed or rendered.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DOC_XML_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_UNITS = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_ZIP_ENTRIES = 5_000;
const PDF_TIMEOUT_MS = 30_000;

const SIZE_ERROR = "파일이 너무 큽니다. 파일 크기는 20MB 이하여야 합니다.";
const LIMIT_ERROR = "문서가 너무 복잡하거나 내용이 너무 많아 처리할 수 없습니다. PDF는 500쪽 이하, DOCX는 압축 항목 5,000개와 본문 XML 압축 해제 후 8MB 이하, 추출 텍스트는 10Mi 문자 이하여야 합니다.";
const PDF_ERROR = "PDF가 손상되었거나 암호화되어 열 수 없습니다.";
const DOCX_ERROR = "DOCX가 손상되었거나 암호화되어 열 수 없습니다.";
const EMPTY_ERROR = "추출할 텍스트가 없습니다. 내용이 있는 파일을 선택해 주세요.";
const EMPTY_MATH_ERROR = "추출할 본문 텍스트가 없습니다. DOCX 수식(OMML)은 추출하지 않으므로 원본을 확인해 주세요.";

class ImportLimitError extends Error {
  constructor(message = LIMIT_ERROR) { super(message); this.name = "ImportLimitError"; }
}

/** Extract locally without modifying any caller-owned editor state. */
export async function extractManuscript(file: File): Promise<{ text: string; warnings: string[] }> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!file.name.includes(".") || !["txt", "pdf", "docx"].includes(extension ?? "")) {
    throw new Error("지원하지 않는 파일 형식입니다. TXT, PDF 또는 DOCX 파일을 선택해 주세요.");
  }
  if (file.size > MAX_FILE_BYTES) throw new Error(SIZE_ERROR);
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error("파일을 읽을 수 없습니다. 파일을 다시 선택해 주세요.");
  }
  if (extension === "txt") {
    let text: string;
    try {
      // Preserve even an initial U+FEFF rather than changing the original text.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("UTF-8로 인코딩된 TXT 파일만 불러올 수 있습니다.");
    }
    if (!text.trim()) throw new Error(EMPTY_ERROR);
    return { text, warnings: ["UTF-8 텍스트를 원본 그대로 불러왔습니다."] };
  }
  return extension === "pdf" ? extractPdf(bytes) : extractDocx(bytes);
}

async function extractPdf(bytes: ArrayBuffer): Promise<{ text: string; warnings: string[] }> {
  let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
  let worker: import("pdfjs-dist").PDFWorker | undefined;
  let port: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const pdfjs = await import("pdfjs-dist");
    // Vite emits the worker as an application asset, respecting its configured
    // base URL (including GitHub Pages project subpaths). An explicit worker
    // prevents PDF.js from falling back to main-thread parsing.
    port = new Worker(pdfWorkerUrl, { type: "module" });
    worker = pdfjs.PDFWorker.create({ port });
    task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      worker,
      useWorkerFetch: false,
      // Built-in Adobe CMaps are local static assets, not document URLs. Vite's
      // base is essential when the application is hosted under a project path.
      cMapUrl: new URL(`${import.meta.env.BASE_URL}cmaps/`, window.location.href).href,
      cMapPacked: true,
      useWasm: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: true,
      verbosity: 0,
    });
    const currentTask = task;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        port?.terminate();
        reject(new ImportLimitError("PDF 처리 시간이 30초를 초과했습니다. 문서를 나누거나 더 간단한 파일을 선택해 주세요."));
        void currentTask.destroy().catch(() => {});
      }, PDF_TIMEOUT_MS);
    });
    return await Promise.race([readPdf(currentTask), deadline]);
  } catch (error) {
    if (error instanceof ImportLimitError) throw error;
    if (error instanceof Error && error.message === "PDF에서 텍스트를 추출하지 못했습니다. 빈 문서이거나 스캔·이미지 전용 PDF일 수 있으며 OCR은 지원하지 않습니다.") throw error;
    throw new Error(PDF_ERROR);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A terminated worker cannot answer the graceful close handshake.
    if (task && !timedOut) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        task.destroy().catch(() => {}),
        new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1000); }),
      ]);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    }
    worker?.destroy();
    port?.terminate();
  }
}

async function readPdf(task: import("pdfjs-dist").PDFDocumentLoadingTask): Promise<{ text: string; warnings: string[] }> {
  const pdf = await task.promise;
  if (pdf.numPages > MAX_PDF_PAGES) throw new ImportLimitError();
  const pages: string[] = [];
  const emptyPages: number[] = [];
  let total = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    try {
      const reader = page.streamTextContent({ disableNormalization: true }).getReader();
      const pieces: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const item of value.items) {
          if (!("str" in item)) continue;
          total += item.str.length + (item.hasEOL ? 1 : 0);
          if (total > MAX_TEXT_UNITS) {
            void reader.cancel().catch(() => {});
            throw new ImportLimitError();
          }
          pieces.push(item.str);
          if (item.hasEOL) pieces.push("\n");
        }
      }
      const text = pieces.join("");
      if (!text.trim()) emptyPages.push(pageNumber);
      pages.push(text);
    } finally {
      page.cleanup();
    }
  }
  const text = pages.join("\n\n");
  if (!text.trim()) throw new Error("PDF에서 텍스트를 추출하지 못했습니다. 빈 문서이거나 스캔·이미지 전용 PDF일 수 있으며 OCR은 지원하지 않습니다.");
  const warnings = [
    `PDF ${pdf.numPages}쪽을 페이지 순서대로 추출했습니다. OCR을 지원하지 않아 스캔·이미지의 글자는 추출되지 않습니다.`,
    "그림은 텍스트로 대체하지 않으며 표나 복잡한 배치의 읽기 순서가 원본과 다를 수 있습니다.",
    "PDF의 글꼴이나 문자표에 따라 일부 글자가 누락되거나 다르게 추출될 수 있습니다.",
    "PDF 내부 압축 데이터의 메모리 사용량은 미리 제한할 수 없어 매우 복잡한 파일은 브라우저가 느려지거나 중단될 수 있습니다.",
  ];
  if (emptyPages.length) {
    warnings.push(`텍스트가 추출되지 않은 페이지 ${emptyPages.length}쪽: ${emptyPages.join(", ")}쪽. 빈 페이지 또는 스캔·이미지 페이지일 수 있으므로 원본을 확인해 주세요.`);
  }
  return { text, warnings };
}

// CRC-32/ISO-HDLC (the checksum used in ZIP central directories).
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Only the document body is inflated. Other ZIP entries (images, relationships,
// embedded content) are never unpacked or interpreted. ZIP64/multi-disk archives
// are intentionally unsupported under these resource limits.
async function readDocxBody(bytes: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const fits = (offset: number, length: number) => offset >= 0 && length >= 0 && offset + length <= bytes.length;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(i) === 0x06054b50 && fits(i, 22) && i + 22 + u16(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== u16(end + 10)) throw new Error(DOCX_ERROR);
  const count = u16(end + 10);
  if (count > MAX_ZIP_ENTRIES) throw new ImportLimitError();
  const directorySize = u32(end + 12), directoryOffset = u32(end + 16);
  if (directoryOffset + directorySize !== end) throw new Error(DOCX_ERROR);
  let offset = directoryOffset;
  let body: { flags: number; method: number; crc: number; compressed: number; uncompressed: number; local: number; name: Uint8Array } | undefined;
  for (let i = 0; i < count; i++) {
    if (!fits(offset, 46) || u32(offset) !== 0x02014b50) throw new Error(DOCX_ERROR);
    const nameLength = u16(offset + 28), extraLength = u16(offset + 30), commentLength = u16(offset + 32);
    const length = 46 + nameLength + extraLength + commentLength;
    if (!fits(offset, length) || offset + length > end) throw new Error(DOCX_ERROR);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength);
    // The ASCII path is required by OOXML, so no filename decoder is needed.
    if (name.length === 17 && name.every((c, n) => c === "word/document.xml".charCodeAt(n))) {
      if (body) throw new Error(DOCX_ERROR);
      body = { flags: u16(offset + 8), method: u16(offset + 10), crc: u32(offset + 16), compressed: u32(offset + 20), uncompressed: u32(offset + 24), local: u32(offset + 42), name };
    }
    offset += length;
  }
  if (offset !== end || !body || (body.flags & 1) || ![0, 8].includes(body.method)) throw new Error(DOCX_ERROR);
  if (body.uncompressed > MAX_DOC_XML_BYTES) throw new ImportLimitError();
  const local = body.local;
  if (!fits(local, 30) || u32(local) !== 0x04034b50 || u16(local + 6) !== body.flags || u16(local + 8) !== body.method) throw new Error(DOCX_ERROR);
  const localNameLength = u16(local + 26), localExtraLength = u16(local + 28);
  const dataOffset = local + 30 + localNameLength + localExtraLength;
  if (!fits(local + 30, localNameLength + localExtraLength) || localNameLength !== body.name.length || !body.name.every((c, i) => bytes[local + 30 + i] === c) || !fits(dataOffset, body.compressed) || dataOffset + body.compressed > directoryOffset) throw new Error(DOCX_ERROR);
  const compressed = bytes.subarray(dataOffset, dataOffset + body.compressed);
  let result: Uint8Array;
  if (body.method === 0) {
    if (compressed.length !== body.uncompressed) throw new Error(DOCX_ERROR);
    result = compressed;
  } else {
    const { Inflate } = await import("fflate");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const stream = new Inflate(chunk => {
      size += chunk.length;
      if (size > MAX_DOC_XML_BYTES || size > body!.uncompressed) throw new ImportLimitError();
      chunks.push(chunk);
    });
    // Small input chunks limit transient output even when ZIP size fields lie.
    const step = 4096;
    if (!compressed.length) throw new Error(DOCX_ERROR);
    for (let start = 0; start < compressed.length; start += step) {
      stream.push(compressed.subarray(start, start + step), start + step >= compressed.length);
    }
    if (size !== body.uncompressed) throw new Error(DOCX_ERROR);
    result = new Uint8Array(size);
    let cursor = 0;
    for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
  }
  // Verify integrity even for stored entries and streams that otherwise decode.
  if (crc32(result) !== body.crc) throw new Error(DOCX_ERROR);
  return result;
}

const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const MATH_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/math",
  "http://purl.oclc.org/ooxml/officeDocument/math",
]);

async function extractDocx(bytes: ArrayBuffer): Promise<{ text: string; warnings: string[] }> {
  try {
    const xmlBytes = await readDocxBody(new Uint8Array(bytes));
    let encoding = "utf-8";
    if (xmlBytes[0] === 0xff && xmlBytes[1] === 0xfe) encoding = "utf-16le";
    else if (xmlBytes[0] === 0xfe && xmlBytes[1] === 0xff) encoding = "utf-16be";
    else if (xmlBytes[0] === 0x3c && xmlBytes[1] === 0 && xmlBytes[2] === 0x3f && xmlBytes[3] === 0) encoding = "utf-16le";
    else if (xmlBytes[0] === 0 && xmlBytes[1] === 0x3c && xmlBytes[2] === 0 && xmlBytes[3] === 0x3f) encoding = "utf-16be";
    const xml = new TextDecoder(encoding, { fatal: true }).decode(xmlBytes);
    // Reject DTDs entirely, including internal entities/expansion and external references.
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error(DOCX_ERROR);
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (document.getElementsByTagName("parsererror").length) throw new Error(DOCX_ERROR);
    const root = document.documentElement;
    if (!root || root.localName !== "document" || !WORD_NAMESPACES.has(root.namespaceURI ?? "")) throw new Error(DOCX_ERROR);
    const bodies = Array.from(root.children).filter(element => element.localName === "body" && WORD_NAMESPACES.has(element.namespaceURI ?? ""));
    if (bodies.length !== 1) throw new Error(DOCX_ERROR);
    const paragraphs: string[] = [];
    let total = 0;
    let hasMath = false;
    const skip = new Set(["drawing", "pict", "object", "del", "moveFrom", "pPr"]);
    const visit = (element: Element, paragraph?: string[]) => {
      const isWord = WORD_NAMESPACES.has(element.namespaceURI ?? "");
      const name = element.localName;
      if (isWord && skip.has(name)) return;
      if (MATH_NAMESPACES.has(element.namespaceURI ?? "") && (name === "oMath" || name === "oMathPara")) {
        // Linearizing OMML as ordinary text can change the mathematical meaning.
        hasMath = true;
        return;
      }
      if (isWord && name === "p") {
        const pieces: string[] = [];
        for (const child of Array.from(element.children)) visit(child, pieces);
        paragraphs.push(pieces.join(""));
        return;
      }
      if (paragraph && isWord) {
        if (name === "t") {
          const text = element.textContent ?? "";
          total += text.length;
          if (total > MAX_TEXT_UNITS) throw new ImportLimitError();
          paragraph.push(text);
          return;
        }
        // These are run content only; e.g. w:pPr/w:tabs/w:tab defines a tab stop.
        const parent = element.parentElement;
        if (parent && WORD_NAMESPACES.has(parent.namespaceURI ?? "") && parent.localName === "r") {
          if (name === "tab") { paragraph.push("\t"); return; }
          if (name === "br" || name === "cr") { paragraph.push("\n"); return; }
          if (name === "noBreakHyphen") { paragraph.push("\u2011"); return; }
          if (name === "softHyphen") { paragraph.push("\u00ad"); return; }
        }
      }
      for (const child of Array.from(element.children)) visit(child, paragraph);
    };
    visit(bodies[0]);
    const text = paragraphs.join("\n");
    if (!text.trim()) throw new Error(hasMath ? EMPTY_MATH_ERROR : EMPTY_ERROR);
    const warnings = [
      "DOCX 본문의 단락과 문자를 추출했습니다. 머리글·바닥글·각주, 그림과 표 또는 복잡한 서식은 누락되거나 원본과 다르게 표시될 수 있습니다.",
      "목록의 자동 번호와 글머리표는 추출되지 않거나 원본과 다를 수 있습니다. 원본을 확인해 주세요.",
    ];
    if (hasMath) warnings.push("DOCX 수식(OMML)은 추출하지 않아 누락됩니다. 원본 수식을 확인해 주세요.");
    return { text, warnings };
  } catch (error) {
    if (error instanceof ImportLimitError || (error instanceof Error && (error.message === EMPTY_ERROR || error.message === EMPTY_MATH_ERROR))) throw error;
    throw new Error(DOCX_ERROR);
  }
}
