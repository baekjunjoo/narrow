import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { qualityReportRows, type CompletedQualityReport } from "./quality-report";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const FONT_SIZE = 10.5;
const LINE_HEIGHT = 16;

/**
 * Fetch only a bundled, same-origin app asset. No labels, metrics or audio are sent.
 * Supplying bytes separately also allows offline/unit testing without a network.
 */
export async function loadReportFont(): Promise<ArrayBuffer> {
  const url = new URL(`${import.meta.env.BASE_URL}fonts/NarravoReportKR-Regular.ttf`, window.location.href);
  if (url.origin !== window.location.origin) throw new Error("보고서 글꼴은 같은 앱에서만 불러올 수 있습니다.");
  const response = await fetch(url.href, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("한글 보고서 글꼴을 불러오지 못했습니다.");
  return response.arrayBuffer();
}

function printableText(value: string): string {
  // The PDF font intentionally has no shaping tables. Compose decomposed Hangul
  // (e.g. macOS filenames) before drawing; the CSV retains the original string.
  // Newlines stay as line breaks. Other controls are represented explicitly.
  return value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\p{Cc}\p{Cf}]/gu, ch => {
    if (ch === "\n") return ch;
    const cp = ch.codePointAt(0)!;
    return `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;
  });
}

/** Split without a length/line limit. Overlong unbroken strings wrap by code point. */
function wrap(text: string, font: PDFFont, widths: Map<string, number>): string[] {
  const lines: string[] = [];
  const maxWidth = PAGE_WIDTH - 2 * MARGIN;
  const charWidth = (char: string) => {
    let width = widths.get(char);
    if (width === undefined) {
      // Keep a conservative margin even if the font metrics change.
      width = Math.max(FONT_SIZE, font.widthOfTextAtSize(char, FONT_SIZE)) * 1.15;
      widths.set(char, width);
    }
    return width;
  };
  const pushChecked = (value: string) => {
    // Verify each full line against the available width.
    let remaining = Array.from(value);
    if (!remaining.length) { lines.push(""); return; }
    while (remaining.length) {
      let count = remaining.length;
      while (count > 1 && font.widthOfTextAtSize(remaining.slice(0, count).join(""), FONT_SIZE) > maxWidth) count--;
      lines.push(remaining.slice(0, count).join(""));
      remaining = remaining.slice(count);
    }
  };
  for (const paragraph of text.split("\n")) {
    let line = "";
    let width = 0;
    for (const char of paragraph) {
      const next = charWidth(char);
      if (line && width + next > maxWidth - 5) {
        pushChecked(line);
        line = "";
        width = 0;
      }
      line += char;
      width += next;
    }
    pushChecked(line);
  }
  return lines;
}

/** All bytes are generated in memory; the complete font is embedded, never subsetted. */
export async function createQualityPdf(input: CompletedQualityReport, fontBytes: ArrayBuffer | Uint8Array): Promise<Blob> {
  const rows = qualityReportRows(input); // validates completed state before creating any file
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setTitle("오디오 품질 점검 보고서");
  const font = await document.embedFont(fontBytes, { subset: false });
  const supported = new Set(font.getCharacterSet());
  const texts = [
    "오디오 품질 점검 보고서",
    "제어 문자는 [U+번호]로 표시합니다. 원본 값은 CSV에서 확인하세요.",
    ...rows.map(([name, value, extra]) => `${name}: ${value}${extra ? ` / ${extra}` : ""}`),
  ].map(printableText);
  for (const text of texts) {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (ch !== "\n" && !supported.has(cp)) {
        throw new Error(`PDF 글꼴이 U+${cp.toString(16).toUpperCase()} 문자를 지원하지 않아 누락 없이 저장할 수 없습니다. CSV를 이용해 주세요.`);
      }
    }
  }
  let page: PDFPage | undefined;
  let y = 0;
  const widths = new Map<string, number>();
  const nextPage = () => { page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = PAGE_HEIGHT - MARGIN; };
  nextPage();
  for (const text of texts) {
    for (const line of wrap(text, font, widths)) {
      if (y < MARGIN + LINE_HEIGHT) nextPage();
      if (line) page!.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0, 0, 0) });
      y -= LINE_HEIGHT;
    }
    y -= 3;
  }
  const bytes = await document.save();
  return new Blob([new Uint8Array(bytes).buffer], { type: "application/pdf" });
}
