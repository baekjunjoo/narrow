import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { strToU8, zipSync } from "fflate";
import fontUrl from "../../public/fonts/NarravoReportKR-Regular.ttf?url";
import { extractManuscript } from "./manuscript-import";

declare global { interface Window { __importTestResult?: { ok: boolean; message: string }; __pdfExecuted?: boolean } }
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const mustReject = async (f: File, expected: RegExp) => {
  try { await extractManuscript(f); } catch (error) {
    assert(error instanceof Error && expected.test(error.message), `Unexpected error for ${f.name}: ${String(error)}`);
    return;
  }
  throw new Error(`${f.name} unexpectedly succeeded`);
};
const toFile = (bytes: Uint8Array, name: string) => new File([new Uint8Array(bytes)], name);

async function run() {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await (await fetch(fontUrl)).arrayBuffer(), { subset: true });
  const firstPage = pdf.addPage([500, 500]);
  firstPage.drawText("첫째 페이지 Hello", { x: 40, y: 400, font, size: 14 });
  const link = pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 100, 100], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://attacker.invalid/pdf-link") } }));
  firstPage.node.set(PDFName.of("Annots"), pdf.context.obj([link]));
  const imageBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XchUAAAAASUVORK5CYII="), char => char.charCodeAt(0));
  const image = await pdf.embedPng(imageBytes);
  pdf.addPage([500, 500]).drawImage(image, { x: 0, y: 0, width: 100, height: 100 }); // Image-only page.
  pdf.addPage([500, 500]).drawText("셋째 페이지 World", { x: 40, y: 400, font, size: 14 });
  pdf.addJavaScript("malicious", "globalThis.__pdfExecuted = true;");
  const result = await extractManuscript(toFile(await pdf.save(), "mixed.pdf"));
  assert(result.text.includes("첫째 페이지 Hello"), `Korean/English first page missing: ${result.text}`);
  assert(result.text.includes("셋째 페이지 World"), `Korean/English third page missing: ${result.text}`);
  assert(result.text.indexOf("첫째") < result.text.indexOf("셋째"), "PDF page order wrong");
  assert(result.warnings.some(w => /1쪽: 2쪽/.test(w)), `Missing blank-page warning: ${result.warnings}`);
  assert(result.warnings.some(w => /OCR/.test(w)) && result.warnings.some(w => /표.*배치/.test(w)), "Missing PDF limitations");
  assert(!window.__pdfExecuted, "PDF JavaScript was executed");

  const blank = await PDFDocument.create();
  blank.addPage([100, 100]);
  await mustReject(toFile(await blank.save(), "blank.pdf"), /OCR/);
  await mustReject(toFile(strToU8("%PDF-1.7 broken"), "broken.pdf"), /손상.*암호화/);

  const encryptedPdf = "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGQ1MTZlOTU0YzA+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8YTgxN2MwMzIxY2ViOTJjMDQ3MDkyMDc2MTA0NjJkZjViZWIwMzJjYzBhYTQ4YTY3MGY5YWVmNTM3NTk2MzdkNj4KL1UgPDIyOWI4ZWJjYTUzMTFkZWYzZjhiNzM4MzQ1MzExZTdmMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IDwzNTM5NjMzMjMwNjI2MjYxNjU2MzM4MzI2NTMxNjIzNTYzMzYzMzYzNjE2MjY1NjYzNTYxNjY2MTY1NjYzMTMxPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK";
  await mustReject(toFile(Uint8Array.from(atob(encryptedPdf), char => char.charCodeAt(0)), "encrypted.pdf"), /손상.*암호화/);

  const longText = "후속 문장 long text ".repeat(1200);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
  <w:p><w:r><w:t>첫 문장. 한글 &amp; English!</w:t><w:tab/><w:t>두 번째</w:t><w:br/><w:t>줄</w:t></w:r><w:drawing><w:t>DO NOT EXTRACT</w:t></w:drawing></w:p>
  <w:p/><w:p><w:hyperlink r:id="rId1"><w:r><w:t>Link text</w:t></w:r></w:hyperlink></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>cell 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  <w:p><w:r><w:t xml:space="preserve">${longText}</w:t></w:r></w:p></w:body></w:document>`;
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="https://attacker.invalid/secret" TargetMode="External"/></Relationships>';
  const docx = zipSync({ "word/document.xml": strToU8(xml), "word/_rels/document.xml.rels": strToU8(rels), "word/media/image1.bin": new Uint8Array(1024 * 1024) });
  const doc = await extractManuscript(toFile(docx, "book.DOCX"));
  const expected = `첫 문장. 한글 & English!\t두 번째\n줄\n\nLink text\ncell 1\ncell 2\n${longText}`;
  assert(doc.text === expected, `DOCX text changed/truncated: ${doc.text.slice(0, 100)}`);
  assert(doc.warnings.some(w => /그림.*표.*서식/.test(w)), "Missing DOCX warning");
  const empty = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>') });
  await mustReject(toFile(empty, "empty.docx"), /텍스트가 없습니다/);
  assert(!window.__pdfExecuted, "PDF JavaScript executed after extraction");
  return "Korean/English PDF with image-only page, JavaScript and external link; encrypted, damaged and empty PDFs; full DOCX text, tables, external link and empty document";
}
run().then(message => { window.__importTestResult = { ok: true, message }; }).catch(error => { window.__importTestResult = { ok: false, message: error instanceof Error ? error.stack || error.message : String(error) }; });
