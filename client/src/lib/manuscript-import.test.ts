import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";

const mock = vi.hoisted(() => ({
  pages: [] as string[],
  fail: false,
  destroys: 0,
}));
vi.mock("pdfjs-dist", () => ({
  PDFWorker: { create: () => ({ destroy: () => {} }) },
  getDocument: () => ({
    promise: mock.fail ? Promise.reject(new Error("invalid or encrypted")) : Promise.resolve({
      numPages: mock.pages.length,
      getPage: async (page: number) => ({
        streamTextContent: () => new ReadableStream({
          start(controller) {
            controller.enqueue({ items: [{ str: mock.pages[page - 1], hasEOL: false }] });
            controller.close();
          },
        }),
        cleanup: () => {},
      }),
    }),
    destroy: async () => { mock.destroys++; },
  }),
}));
import { crc32, extractManuscript } from "./manuscript-import";

const file = (name: string, content: BlobPart) => new File([content], name);
const zip = (xml: string) => zipSync({ "word/document.xml": strToU8(xml) });

describe("extractManuscript", () => {
  beforeEach(() => {
    mock.pages = [];
    mock.fail = false;
    mock.destroys = 0;
    vi.stubGlobal("Worker", class { terminate() {} });
    vi.stubGlobal("window", { location: { href: "http://localhost/" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("matches standard CRC32/ISO-HDLC vectors and the original bitwise algorithm", () => {
    const reference = (data: Uint8Array) => {
      let crc = 0xffffffff;
      for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    };
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(strToU8("123456789"))).toBe(0xcbf43926);
    const data = Uint8Array.from({ length: 65536 }, (_, index) => (index * 61 + (index >>> 7)) & 255);
    expect(crc32(data)).toBe(reference(data));
  });
  it("rejects a real CRC-corrupted stored DOCX body even if XML remains valid", async () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>';
    const archive = zipSync({ "word/document.xml": strToU8(xml) }, { level: 0 });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const offset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const index = xml.indexOf("hello");
    archive[offset + index] = "j".charCodeAt(0); // still valid XML, unchanged size, invalid checksum
    await expect(extractManuscript(file("corrupted.docx", archive))).rejects.toThrow(/손상.*암호화/);
  });
  it("rejects an incorrect CRC on an otherwise intact deflated DOCX body", async () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>valid body</w:t></w:r></w:p></w:body></w:document>';
    const archive = zip(xml);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let central = -1;
    for (let i = 0; i <= archive.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) { central = i; break; }
    expect(central).toBeGreaterThan(0);
    expect(view.getUint16(central + 10, true)).toBe(8);
    view.setUint32(central + 16, view.getUint32(central + 16, true) ^ 1, true);
    await expect(extractManuscript(file("corrupted-crc.docx", archive))).rejects.toThrow(/손상.*암호화/);
  });

  it("preserves every UTF-8 character, whitespace, line ending and BOM", async () => {
    const text = "\ufeff  한글 English\r\n\r\n끝\n";
    const result = await extractManuscript(file("원고.TxT", text));
    expect(result.text).toBe(text);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it("rejects invalid UTF-8, empty files, unsupported extensions, and files over 20 MiB", async () => {
    await expect(extractManuscript(file("bad.txt", new Uint8Array([0xc3, 0x28])))).rejects.toThrow(/UTF-8/);
    await expect(extractManuscript(file("empty.txt", " \r\n"))).rejects.toThrow(/텍스트가 없습니다/);
    await expect(extractManuscript(file("raw.rtf", "content"))).rejects.toThrow(/지원하지 않는/);
    const oversized = file("large.txt", "x");
    Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
    await expect(extractManuscript(oversized)).rejects.toThrow(/20MB/);
  });
  it("preserves PDF page order and explicitly identifies every page without text", async () => {
    mock.pages = ["First", "  ", "Third"];
    const result = await extractManuscript(file("book.pdf", "%PDF fake"));
    expect(result.text).toBe("First\n\n  \n\nThird");
    expect(result.warnings.join(" ")).toMatch(/OCR/);
    expect(result.warnings.join(" ")).toMatch(/표|배치/);
    expect(result.warnings.join(" ")).toMatch(/1쪽: 2쪽/);
    expect(mock.destroys).toBe(1);
  });
  it("rejects image-only and damaged PDFs without returning partial results", async () => {
    mock.pages = ["", "  "];
    await expect(extractManuscript(file("scan.pdf", "fake"))).rejects.toThrow(/OCR/);
    mock.fail = true;
    await expect(extractManuscript(file("bad.pdf", "fake"))).rejects.toThrow(/손상.*암호화/);
  });
  it("rejects excessive PDF page counts", async () => {
    mock.pages = Array(501).fill("x");
    await expect(extractManuscript(file("huge.pdf", "fake"))).rejects.toThrow(/500쪽/);
  });
  it("rejects broken, encrypted and dangerous DOCX documents", async () => {
    await expect(extractManuscript(file("bad.docx", "not a ZIP"))).rejects.toThrow(/손상.*암호화/);
    const dtd = zip('<!DOCTYPE a [<!ENTITY x "x">]><a/>');
    await expect(extractManuscript(file("dtd.docx", dtd))).rejects.toThrow(/손상.*암호화/);
    const encrypted = zip("<a/>");
    const view = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
    let central = -1;
    for (let i = 0; i < encrypted.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) { central = i; break; }
    expect(central).toBeGreaterThan(0);
    view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
    await expect(extractManuscript(file("encrypted.docx", encrypted))).rejects.toThrow(/손상.*암호화/);
  });
  it("rejects a DOCX XML compression bomb rather than truncating it", async () => {
    const large = zip("x".repeat(8 * 1024 * 1024 + 1));
    expect(large.length).toBeLessThan(20 * 1024 * 1024);
    await expect(extractManuscript(file("bomb.docx", large))).rejects.toThrow(/8MB/);
    // A dishonest central directory must not bypass the streaming output cap.
    const view = new DataView(large.buffer, large.byteOffset, large.byteLength);
    let central = -1;
    for (let i = 0; i < large.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) { central = i; break; }
    expect(central).toBeGreaterThan(0);
    view.setUint32(central + 24, 10, true);
    await expect(extractManuscript(file("forged-bomb.docx", large))).rejects.toThrow(/8MB/);
  });
});
