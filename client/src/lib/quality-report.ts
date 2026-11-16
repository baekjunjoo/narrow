import type { QualityReport } from "./audio-quality";

export interface CompletedQualityReport {
  state: "done";
  label: string;
  report: QualityReport;
}

export type ReportRow = [string, string, string];

/** Keep the independent limitations even if a test or future analyzer returns no issues. */
export const REPORT_LIMITATIONS = [
  "참고용 검사이며 결과를 직접 청취해야 합니다. 원고 대조에 의한 누락과 발음, 배경음 비율이나 적합성은 판별하지 못합니다.",
  "표본 피크는 true peak가 아니며, 가중하지 않은 전체 RMS는 LUFS가 아닙니다. 표준 인증이나 완전한 무결성 검증이 아닙니다.",
  "저음량 구간은 전체 채널 100ms 창의 RMS가 -55 dBFS 미만인 상태가 3초 이상 지속될 때 표시합니다. 경계는 약 0.1초 단위이며 마지막 창은 더 짧을 수 있습니다.",
  "무음 의심 구간은 검사기에서 최대 1000개만 보관하며, 초과 시 경고합니다. 보관된 구간을 모두 기록합니다.",
  "전체 RMS -35 dBFS 미만, 표본 피크 -1 dBFS 이상, 0 dBFS 초과 및 동일 채널 디지털 상한 또는 하한 3회 연속은 주의 기준입니다. 클리핑 확정 판정은 아닙니다.",
  "구간별 음량 차이는 완전한 5초 구간 중 전체 채널 RMS -45 dBFS 이상인 구간이 2개 이상이고 최대와 최소 차이가 12 dB 이상일 때 경고하는 실험적 기준입니다.",
  "PDF의 태그와 읽기 순서는 검증하지 않았으므로 PDF 접근성은 보장하지 않습니다. 텍스트 추출 시 연속 공백이 합쳐질 수 있습니다. 원본 값은 CSV를 이용해 주세요.",
];

function assertCompleted(input: CompletedQualityReport): void {
  const r = input?.report;
  if (
    input?.state !== "done" || typeof input.label !== "string" || !r ||
    !Number.isFinite(r.duration) || r.duration <= 0 ||
    !Number.isInteger(r.channels) || r.channels <= 0 ||
    !Number.isFinite(r.sampleRate) || r.sampleRate <= 0 ||
    (r.peakDb !== null && !Number.isFinite(r.peakDb)) ||
    (r.rmsDb !== null && !Number.isFinite(r.rmsDb)) ||
    !Array.isArray(r.silentRegions) || !Array.isArray(r.issues) ||
    r.silentRegions.some(region => !region || !Number.isFinite(region.start) || !Number.isFinite(region.end) || region.start < 0 || region.end < region.start) ||
    r.issues.some(issue => !issue || (issue.level !== "warning" && issue.level !== "info") || typeof issue.message !== "string")
  ) throw new Error("완료된 유효한 검사 결과만 보고서로 저장할 수 있습니다.");
}

/** A common, non-lossy representation shared by CSV and PDF. */
export function qualityReportRows(input: CompletedQualityReport): ReportRow[] {
  assertCompleted(input);
  const r = input.report;
  const db = (value: number | null) => value === null ? "무음/측정 불가" : `${value} dBFS`;
  const rows: ReportRow[] = [
    ["검사 상태", "검사 완료 (디코딩 및 검사 완료)", ""],
    ["음원 라벨", input.label || "(빈 라벨)", ""],
    ["재생 길이", `${r.duration}초`, ""],
    ["채널", `${r.channels}개`, ""],
    ["샘플레이트", `${r.sampleRate} Hz`, ""],
    ["표본 피크", db(r.peakDb), ""],
    ["전체 RMS", db(r.rmsDb), ""],
    ["저음량/무음 의심 구간 수", String(r.silentRegions.length), ""],
  ];
  if (r.silentRegions.length === 0) rows.push(["저음량/무음 의심 구간", "없음", ""]);
  r.silentRegions.forEach((region, index) => rows.push([
    `저음량/무음 의심 구간 ${index + 1}`,
    `시작 ${region.start}초`,
    `종료 ${region.end}초`,
  ]));
  const warnings = r.issues.filter(issue => issue.level === "warning");
  const notes = r.issues.filter(issue => issue.level === "info");
  rows.push(["경고 수", String(warnings.length), ""]);
  if (!warnings.length) rows.push(["경고", "없음", ""]);
  warnings.forEach((issue, index) => rows.push([`경고 ${index + 1}`, issue.message || "(빈 내용)", ""]));
  rows.push(["검사 안내 수", String(notes.length), ""]);
  if (!notes.length) rows.push(["검사 안내", "없음", ""]);
  notes.forEach((issue, index) => rows.push([`검사 안내 ${index + 1}`, issue.message || "(빈 내용)", ""]));
  REPORT_LIMITATIONS.forEach((limit, index) => rows.push([`검사 기준 및 한계 ${index + 1}`, limit, ""]));
  return rows;
}

/** Apply before RFC 4180 escaping; formula prefixes may follow invisible/control characters. */
export function csvCell(value: string): string {
  const dangerous = /^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@]/u.test(value) || /^[\t\r\n]/.test(value);
  const safe = dangerous ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function createQualityCsv(input: CompletedQualityReport): Blob {
  const rows: ReportRow[] = [["항목", "값", "보조 값"], ...qualityReportRows(input)];
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
}

/** Avoid path traversal, control/bidi characters, reserved device names and overlong names. */
export function qualityReportFilename(label: string, extension: "csv" | "pdf"): string {
  let safe = label.normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "_")
    .replace(/^\s+|[\s.]+$/gu, "")
    .replace(/^\.+/u, "_");
  safe = Array.from(safe).slice(0, 70).join("").replace(/[\s.]+$/u, "");
  if (!safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(safe)) safe = `음원_${safe}`;
  return `${safe || "음원"}_품질보고서.${extension}`;
}
