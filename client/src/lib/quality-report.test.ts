import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { QualityReport } from "./audio-quality";
import { createQualityCsv, csvCell, qualityReportFilename, qualityReportRows, type CompletedQualityReport } from "./quality-report";
import { createQualityPdf } from "./quality-report-pdf";

// PDF integrity checks require pdftotext, pdfinfo and pdffonts from Poppler.
const temporary = mkdtempSync(join(tmpdir(), "quality-report-test-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const font = readFileSync(resolve("client/public/fonts/NarravoReportKR-Regular.ttf"));
const report = (overrides: Partial<QualityReport> = {}): QualityReport => ({
  duration: 3456.125, channels: 2, sampleRate: 48000, peakDb: -0.54321,
  rmsDb: -18.321, silentRegions: [], issues: [], ...overrides,
});
const completed = (r = report(), label = "한글 낭독, 시험 \"A\""): CompletedQualityReport => ({ state: "done", label, report: r });

// A strict, small CSV parser to test quoted commas, doubled quotes and embedded CR/LF.
function parseCsv(text: string): string[][] {
  const result: string[][] = [], row: string[] = [];
  let cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cell); result.push([...row]); row.length = 0; cell = ""; i++; }
    else throw new Error(`Unexpected CSV byte ${c}`);
  }
  expect(quoted).toBe(false);
  return result;
}

describe("quality report CSV", () => {
  it("writes BOM, escapes quotes, comma and newlines, and blocks dangerous leading whitespace/control formulas", async () => {
    const label = ' \t=SUM("A1",1)\n둘째 줄';
    const blob = createQualityCsv(completed(report({ issues: [{ level: "warning", message: '\u0001  @A,"B"\r\n경고' }] }), label));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(blob.type).toContain("text/csv");
    const csv = new TextDecoder().decode(bytes);
    const rows = parseCsv(csv);
    expect(rows.find(r => r[0] === "음원 라벨")?.[1]).toBe(`'${label}`);
    expect(rows.find(r => r[0] === "경고 1")?.[1]).toBe(`'\u0001  @A,"B"\r\n경고`);
    expect(rows.find(r => r[0] === "표본 피크")?.[1]).toBe("'-0.54321 dBFS");
    expect(rows.every(r => r.length === 3)).toBe(true);
  });
  it.each(["=1", "+2", "-2", "@x", " \t=1", "\u0001  +2", "\u200b@x", "\rtext", "\ntext", "\ttext"])('protects dangerous prefix %j', value => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });
  it("marks null and empty lists explicitly, without pretending there are warnings", () => {
    const rows = qualityReportRows(completed(report({ peakDb: null, rmsDb: null }), ""));
    expect(rows).toContainEqual(["음원 라벨", "(빈 라벨)", ""]);
    expect(rows).toContainEqual(["표본 피크", "무음/측정 불가", ""]);
    expect(rows).toContainEqual(["전체 RMS", "무음/측정 불가", ""]);
    expect(rows).toContainEqual(["저음량/무음 의심 구간", "없음", ""]);
    expect(rows).toContainEqual(["경고", "없음", ""]);
    expect(rows).toContainEqual(["검사 안내", "없음", ""]);
  });
  it("rejects incomplete/failed or malformed reports", () => {
    for (const state of ["waiting", "running", "failed", "cancelled"]) {
      expect(() => createQualityCsv({ ...completed(), state } as unknown as CompletedQualityReport)).toThrow("완료된");
    }
    expect(() => createQualityCsv(completed(report({ duration: NaN })))).toThrow("완료된");
    expect(() => createQualityCsv(completed(report({ silentRegions: [{ start: 4, end: 3 }] })))).toThrow("완료된");
  });
  it("sanitizes traversal, controls, Windows devices and long filenames", () => {
    expect(qualityReportFilename("../../위험\\이름:\u0000*?", "csv")).not.toMatch(/[\\/:*?\u0000]/);
    expect(qualityReportFilename("CON", "pdf")).toBe("음원_CON_품질보고서.pdf");
    expect(qualityReportFilename("한".repeat(1000), "csv").length).toBeLessThan(90);
  });
});

describe("quality report PDF", () => {
  it("refuses unsupported glyphs rather than silently losing report content", async () => {
    await expect(createQualityPdf(completed(report(), "한글😀"), font)).rejects.toThrow(/U\+1F600.*CSV/);
  });
  it("embeds searchable Korean and retains every row, value and limit across pages", async () => {
    const warning = "긴경고시작" + "경고내용을확인하세요".repeat(280) + "긴경고끝";
    const spacedWarning = "3초 이상 지속된 저음량 또는 무음 의심 구간이 있습니다. 의도된 휴지나 배경음일 수 있으니 청취해 확인해 주세요.";
    const r = report({
      silentRegions: Array.from({ length: 1000 }, (_, i) => ({ start: i * 3.25, end: i * 3.25 + 3 })),
      issues: [{ level: "warning", message: warning }, { level: "warning", message: spacedWarning }, { level: "info", message: "추가 검사 안내" }],
    });
    const blob = await createQualityPdf(completed(r), font);
    expect(blob.type).toBe("application/pdf");
    const path = join(temporary, "long.pdf");
    writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
    const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const compact = text.replace(/\s/g, "");
    const expected = [
      "오디오 품질 점검 보고서",
      "제어 문자는 [U+번호]로 표시합니다. 원본 값은 CSV에서 확인하세요.",
      ...qualityReportRows(completed(r)).map(([name, value, extra]) => `${name}: ${value}${extra ? ` / ${extra}` : ""}`),
    ].join("").replace(/\s/g, "");
    // Ignore line/page wrapping only: compare all row names, values and extra
    // fields in order, not just substrings that might appear elsewhere.
    expect(compact).toBe(expected);
    expect(compact).toContain("한글낭독,시험\"A\"");
    expect(compact).toContain("긴경고시작");
    expect(compact).toContain("긴경고끝");
    expect(compact).toContain(warning);
    for (const [, value] of qualityReportRows(completed(r))) expect(compact).toContain(value.replace(/\s/g, ""));
    for (let i = 1; i <= 1000; i++) expect(compact).toContain(`저음량/무음의심구간${i}:시작${(i - 1) * 3.25}초/종료${(i - 1) * 3.25 + 3}초`);
    const info = execFileSync("pdfinfo", [path], { encoding: "utf8" });
    expect(Number(info.match(/Pages:\s+(\d+)/)?.[1])).toBeGreaterThan(1);
    const fonts = execFileSync("pdffonts", [path], { encoding: "utf8" });
    expect(fonts).toMatch(/NarravoReportKR.*yes\s+no\s+yes/);
  }, 120_000);
  it("preserves explicit blank/null values in extracted PDF text", async () => {
    const blob = await createQualityPdf(completed(report({ peakDb: null, rmsDb: null }), ""), font);
    const path = join(temporary, "empty.pdf"); writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
    const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" }).replace(/\s/g, "");
    expect(text).toContain("음원라벨:(빈라벨)");
    expect(text.match(/무음\/측정불가/g)).toHaveLength(2);
    expect(text).toContain("저음량/무음의심구간:없음");
    expect(text).toContain("경고:없음");
  }, 60_000);
  it("composes NFC and NFD Korean labels, preserves mixed numbers, and leaves CSV original", async () => {
    const original = "한글 파일 낭독";
    const messages = [
      "한글 A -55 3초 -1 0 dBFS B 한글",
      "0 B -1 3초 -55 A English 한글",
      "하이픈 A-B A‑B",
      "ASCII one two  three   four",
      "Space A B A\u00a0B",
      "한글 파일 낭독".normalize("NFD"),
    ];
    const r = report({ issues: messages.map(message => ({ level: "warning" as const, message })) });
    for (const [i, label] of [original, original.normalize("NFD")].entries()) {
      const input = completed(r, label);
      const csv = await createQualityCsv(input).text();
      expect(parseCsv(csv.replace(/^\uFEFF/, "")).find(row => row[0] === "음원 라벨")?.[1]).toBe(label);
      expect(parseCsv(csv.replace(/^\uFEFF/, "")).find(row => row[0] === "경고 4")?.[1]).toBe(messages[3]);
      const blob = await createQualityPdf(input, font);
      const path = join(temporary, `unicode-${i}.pdf`);
      writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
      const text = execFileSync("pdftotext", ["-raw", path, "-"], { encoding: "utf8" });
      expect(text).toContain(`음원 라벨: ${original}`);
      // PDF extractors may collapse repeated spaces or replace non-breaking spaces.
      for (const message of messages) expect(text.replace(/\s/g, "")).toContain(message.normalize("NFC").replace(/\s/g, ""));
      expect(text).not.toContain(original.normalize("NFD"));
    }
  }, 120_000);
});
