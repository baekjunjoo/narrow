import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { strToU8, zipSync } from "fflate";
import fontUrl from "../../public/fonts/NarravoReportKR-Regular.ttf?url";
import koreanCidUrl from "./manuscript-import.browser-test.korean.pdf?url";
import mixedCidUrl from "./manuscript-import.browser-test.mixed.pdf?url";
import listDocxUrl from "./manuscript-import.browser-test.list.docx?url";
import hyphensDocxUrl from "./manuscript-import.browser-test.hyphens.docx?url";
import mathDocxUrl from "./manuscript-import.browser-test.math.docx?url";
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

// ReportLab-generated CIDFontType2 PDFs use UniKS-UCS2-H and have no ToUnicode map.
// They exercise a different PDF.js path than the embedded font generated above.
async function regressions() {
  const errors: string[] = [];
  const check = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const docx = (body: string, mathNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/math") => toFile(zipSync({ "word/document.xml": strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="${mathNamespace}"><w:body>${body}</w:body></w:document>`) }), "regression.docx");

  await check("Korean-only CID PDF", async () => {
    const result = await extractManuscript(toFile(new Uint8Array(await (await fetch(koreanCidUrl)).arrayBuffer()), "korean.pdf"));
    assert(result.text.includes("한글 원고 한국어 테스트"), `Korean text missing: ${result.text}`);
  });
  await check("Korean + English CID PDF", async () => {
    const result = await extractManuscript(toFile(new Uint8Array(await (await fetch(mixedCidUrl)).arrayBuffer()), "mixed-cid.pdf"));
    assert(result.text.includes("Introduction in English"), `English missing: ${result.text}`);
    assert(result.text.includes("한글 원고 English 한국어 테스트"), `Korean text missing: ${result.text}`);
  });
  await check("paragraph-property tabs and list warning", async () => {
    const doc = await extractManuscript(docx('<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:tabs><w:tab w:val="clear" w:pos="709"/><w:tab w:val="left" w:pos="709"/></w:tabs></w:pPr><w:r><w:t>첫 항목</w:t><w:tab/><w:t>본문 탭</w:t></w:r></w:p>'));
    assert(doc.text === "첫 항목\t본문 탭", `Property tab leaked into body: ${JSON.stringify(doc.text)}`);
    assert(doc.warnings.some(w => /목록/.test(w) && /번호|글머리/.test(w)), `Missing list numbering warning: ${doc.warnings}`);
  });
  await check("Word no-break and soft hyphens", async () => {
    const doc = await extractManuscript(docx('<w:p><w:r><w:t>한글</w:t><w:noBreakHyphen/><w:t>영어 co</w:t><w:softHyphen/><w:t>operate</w:t></w:r></w:p>'));
    assert(doc.text === "한글\u2011영어 co\u00adoperate", `Hyphens missing: ${JSON.stringify(doc.text)}`);
  });
  await check("LibreOffice DOCX reproductions", async () => {
    const read = async (url: string) => extractManuscript(toFile(new Uint8Array(await (await fetch(url)).arrayBuffer()), "actual.docx"));
    const list = await read(listDocxUrl);
    assert(list.text === "준비 목록\n첫 항목 English one\n둘째 항목 English two", `Real list text: ${JSON.stringify(list.text)}`);
    assert(list.warnings.some(w => /목록/.test(w) && /번호|글머리/.test(w)), `Real list missing warning: ${list.warnings}`);
    const damaged = new Uint8Array(await (await fetch(listDocxUrl)).arrayBuffer());
    const view = new DataView(damaged.buffer);
    let central = -1;
    for (let i = 0; i <= damaged.length - 46; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(damaged.subarray(i + 46, i + 46 + nameLength));
      if (name === "word/document.xml") { central = i; break; }
    }
    assert(central >= 0, "Real DOCX body not found");
    view.setUint32(central + 16, view.getUint32(central + 16, true) ^ 1, true);
    await mustReject(toFile(damaged, "damaged-real.docx"), /손상.*암호화/);
    const hyphens = await read(hyphensDocxUrl);
    assert(hyphens.text.startsWith("한글\u2011영어 co\u00adoperate\n"), `Real hyphens missing: ${JSON.stringify(hyphens.text)}`);
    const math = await read(mathDocxUrl);
    assert(math.text.startsWith("방정식  입니다.\n") && !math.text.includes("x + 1 = 2"), `Real OMML incorrectly represented: ${math.text}`);
    assert(math.warnings.some(w => /수식/.test(w) && /누락|추출하지/.test(w)), `Real OMML missing warning: ${math.warnings}`);
  });
  for (const namespace of ["http://schemas.openxmlformats.org/officeDocument/2006/math", "http://purl.oclc.org/ooxml/officeDocument/math"]) {
    await check(`OMML warning ${namespace}`, async () => {
      const formula = '<m:oMath><m:f><m:num><m:r><m:t>x</m:t></m:r></m:num><m:den><m:r><m:t>y</m:t></m:r></m:den></m:f></m:oMath>';
      const doc = await extractManuscript(docx(`<w:p><w:r><w:t>수식 앞</w:t></w:r>${formula}<w:r><w:t>수식 뒤</w:t></w:r></w:p>`, namespace));
      assert(doc.text === "수식 앞수식 뒤", `Complex formula was misrepresented: ${doc.text}`);
      assert(doc.warnings.some(w => /수식/.test(w) && /누락|추출하지/.test(w)), `Missing formula warning: ${doc.warnings}`);
      await mustReject(docx(`<w:p>${formula}</w:p>`, namespace), /수식/);
    });
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return "UniKS-UCS2-H Korean-only and mixed PDFs; real and synthetic DOCX property tabs, hyphens, list and complex OMML warnings";
}

Promise.allSettled([run(), regressions()]).then(results => {
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  window.__importTestResult = errors.length
    ? { ok: false, message: errors.map(result => String(result.reason)).join("\n") }
    : { ok: true, message: results.map(result => (result as PromiseFulfilledResult<string>).value).join("; ") };
});
