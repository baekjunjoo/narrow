import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { AudioLines, Info, LoaderCircle, Trash2 } from "lucide-react";
import { AudioQualityAnalyzer, type QualityReport } from "@/lib/audio-quality";
import { createQualityCsv, qualityReportFilename } from "@/lib/quality-report";
import "./QualityPanel.css";

type QualitySource = { id: "voice" | "mixed"; label: string; blob: Blob };
type Props = {
  sources: QualitySource[];
  otherBusy: boolean;
  onBusyChange: (busy: boolean) => void;
};
type ItemState = "waiting" | "running" | "done" | "failed" | "cancelled";
type QualityItem = {
  key: string;
  sourceId?: QualitySource["id"];
  label: string;
  blob: Blob;
  state: ItemState;
  message?: string;
  result?: QualityReport;
};
type ActiveJob = {
  key: string;
  blob: Blob;
  token: number;
  analyzer: AudioQualityAnalyzer | null;
};

const MAX_FILES = 25;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const SUPPORTED_EXTENSION = /\.(mp3|wav|flac)$/i;
const STATE_LABELS: Record<ItemState, string> = {
  waiting: "검사 대기",
  running: "검사 중",
  done: "검사 완료",
  failed: "검사 실패",
  cancelled: "취소됨",
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "확인 불가";
  const tenths = Math.round(seconds * 10);
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const wholeSeconds = Math.floor((tenths % 600) / 10);
  const fraction = tenths % 10;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${fraction}`;
}

function spokenTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "확인 불가";
  const tenths = Math.round(seconds * 10);
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const wholeSeconds = Math.floor((tenths % 600) / 10);
  const fraction = tenths % 10;
  return `${hours ? `${hours}시간 ` : ""}${minutes}분 ${wholeSeconds}${fraction ? `.${fraction}` : ""}초`;
}

function decibels(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "무음/측정 불가"
    : `${value.toFixed(1)} dBFS`;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "파일을 디코딩하거나 전체 음원을 확인하지 못했습니다. 파일과 브라우저를 확인해 주세요.";
}

function validReport(report: QualityReport): boolean {
  return (
    Number.isFinite(report.duration) &&
    report.duration > 0 &&
    Number.isFinite(report.channels) &&
    report.channels > 0 &&
    Number.isFinite(report.sampleRate) &&
    report.sampleRate > 0
  );
}

// A ref is detached before React removes the button, so this also covers
// asynchronous completion rather than only clicks on the button.
function FocusRestoringButton({
  onFocusedRemoval,
  ...props
}: ComponentPropsWithoutRef<"button"> & { onFocusedRemoval: () => void }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const setButtonRef = useCallback(
    (button: HTMLButtonElement | null) => {
      if (
        !button &&
        buttonRef.current &&
        document.activeElement === buttonRef.current
      ) {
        onFocusedRemoval();
      }
      buttonRef.current = button;
    },
    [onFocusedRemoval]
  );
  return <button {...props} ref={setButtonRef} />;
}

function ResultDetails({ report }: { report: QualityReport }) {
  const warnings = report.issues.filter(issue => issue.level === "warning");
  const notes = report.issues.filter(issue => issue.level === "info");
  return (
    <div className="quality-result">
      <p
        className={
          warnings.length
            ? "quality-verdict quality-verdict-warning"
            : "quality-verdict"
        }
      >
        {warnings.length
          ? `주의할 항목 ${warnings.length}개`
          : "주의할 항목 없음 (측정 범위 내)"}
      </p>
      <p className="quality-decoded">디코딩 및 검사 완료</p>
      <dl className="quality-metrics">
        <div>
          <dt>재생 길이</dt>
          <dd>
            <span aria-hidden="true">{formatTime(report.duration)}</span>
            <span className="quality-sr-only">
              {spokenTime(report.duration)}
            </span>
          </dd>
        </div>
        <div>
          <dt>채널</dt>
          <dd>{report.channels.toLocaleString()}개</dd>
        </div>
        <div>
          <dt>샘플레이트</dt>
          <dd>{report.sampleRate.toLocaleString()} Hz</dd>
        </div>
        <div>
          <dt>표본 피크</dt>
          <dd>{decibels(report.peakDb)}</dd>
        </div>
        <div>
          <dt>전체 RMS</dt>
          <dd>{decibels(report.rmsDb)}</dd>
        </div>
      </dl>
      {warnings.length > 0 && (
        <div className="quality-warning">
          <strong>주의</strong>
          <ul>
            {warnings.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <div className="quality-information">
          <strong>검사 안내</strong>
          <ul>
            {notes.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="quality-silence">
        <strong>긴 저음량/무음 의심 구간</strong>
        {report.silentRegions.length ? (
          <ul>
            {report.silentRegions.map((region, index) => (
              <li key={index}>
                <span aria-hidden="true">
                  {formatTime(region.start)} ~ {formatTime(region.end)}
                </span>
                <span className="quality-sr-only">
                  {`${spokenTime(region.start)}부터 ${spokenTime(region.end)}까지`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>측정된 의심 구간이 없습니다.</p>
        )}
      </div>
    </div>
  );
}

export default function QualityPanel({
  sources,
  otherBusy,
  onBusyChange,
}: Props) {
  const inputId = useId();
  const [items, setItems] = useState<QualityItem[]>([]);
  const [notice, setNotice] = useState("");
  const [events, setEvents] = useState<{ id: number; text: string }[]>([]);
  const [downloads, setDownloads] = useState<string[]>([]);
  const itemsRef = useRef<QualityItem[]>([]);
  const activeRef = useRef<ActiveJob | null>(null);
  const pendingDownloadsRef = useRef(new Set<string>());
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const generationRef = useRef(0);
  const nextFileRef = useRef(1);
  const nextEventRef = useRef(1);
  const mountedRef = useRef(true);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const restoreListFocusRef = useRef(false);
  const busyCallbackRef = useRef(onBusyChange);
  const otherBusyRef = useRef(otherBusy);
  busyCallbackRef.current = onBusyChange;
  otherBusyRef.current = otherBusy;
  const restoreFocusAfterRemoval = useCallback(() => {
    restoreListFocusRef.current = true;
  }, []);

  // The ref is authoritative so that asynchronous callbacks never see an old queue.
  const updateItems = (update: (current: QualityItem[]) => QualityItem[]) => {
    const previous = itemsRef.current;
    const next = update(previous);
    if (next === previous) return;
    itemsRef.current = next;
    if (mountedRef.current) setItems(next);
  };
  const announce = (text: string) => {
    if (!mountedRef.current) return;
    setEvents(current => [
      ...current.slice(-39),
      { id: nextEventRef.current++, text },
    ]);
  };
  const showNotice = (text: string) => {
    if (mountedRef.current) setNotice(text);
  };

  // Invalidate first: even a late resolve or progress callback cannot publish a result.
  const interrupt = () => {
    const active = activeRef.current;
    if (!active) return null;
    generationRef.current++;
    activeRef.current = null;
    try {
      active.analyzer?.dispose();
    } finally {
      busyCallbackRef.current(false);
    }
    return active;
  };

  useLayoutEffect(() => {
    mountedRef.current = true;
    // React Strict Mode can run the cleanup/setup pair without discarding state.
    setItems(current =>
      current === itemsRef.current ? current : itemsRef.current
    );
    return () => {
      mountedRef.current = false;
      const active = interrupt();
      if (active) {
        itemsRef.current = itemsRef.current.map(item =>
          item.key === active.key &&
          item.blob === active.blob &&
          item.state === "running"
            ? {
                ...item,
                state: "waiting",
                message: "검사가 중단되어 다시 대기합니다.",
              }
            : item
        );
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (
      restoreListFocusRef.current &&
      document.activeElement === document.body
    ) {
      listHeadingRef.current?.focus();
    }
    restoreListFocusRef.current = false;
  });

  // Reconcile by source ID AND blob identity, not by labels or the sources array identity.
  // Layout timing prevents a previously completed report flashing under a replacement.
  useLayoutEffect(() => {
    const active = activeRef.current;
    const activeSource =
      active &&
      itemsRef.current.find(item => item.key === active.key)?.sourceId;
    const activeSourceChanged =
      !!activeSource &&
      !sources.some(
        source => source.id === activeSource && source.blob === active?.blob
      );
    if (active && (activeSourceChanged || otherBusy)) {
      interrupt();
      if (activeSourceChanged) {
        announce("검사 중이던 제작 음원이 변경되어 이전 검사를 중단했습니다.");
      } else {
        updateItems(current =>
          current.map(item =>
            item.key === active.key &&
            item.blob === active.blob &&
            item.state === "running"
              ? {
                  ...item,
                  state: "waiting",
                  message: "다른 작업이 끝나면 자동으로 다시 검사합니다.",
                }
              : item
          )
        );
        announce(
          "다른 오디오 작업이 진행되어 검사를 중단했습니다. 작업이 끝나면 다시 검사합니다."
        );
      }
    }

    const current = itemsRef.current;
    const generated = sources.map(source => {
      const existing = current.find(item => item.sourceId === source.id);
      if (existing && existing.blob === source.blob) {
        return existing.label === source.label
          ? existing
          : { ...existing, label: source.label };
      }
      announce(`${source.label} 품질 검사를 예약했습니다.`);
      return {
        key: `source:${source.id}`,
        sourceId: source.id,
        label: source.label,
        blob: source.blob,
        state: "waiting" as const,
      };
    });
    const next = [...generated, ...current.filter(item => !item.sourceId)];
    if (
      next.length !== current.length ||
      next.some((item, index) => item !== current[index])
    ) {
      updateItems(() => next);
    }
  }, [sources, otherBusy]);

  useEffect(() => {
    if (!mountedRef.current || otherBusyRef.current || activeRef.current)
      return;
    const item = itemsRef.current.find(entry => entry.state === "waiting");
    if (!item) return;
    const token = ++generationRef.current;
    const job: ActiveJob = {
      key: item.key,
      blob: item.blob,
      token,
      analyzer: null,
    };
    activeRef.current = job;
    // Acquire the shared busy lock synchronously, before constructing or starting the analyzer.
    busyCallbackRef.current(true);
    updateItems(current =>
      current.map(entry =>
        entry.key === item.key && entry.blob === item.blob
          ? { ...entry, state: "running", message: "검사를 준비하고 있습니다." }
          : entry
      )
    );
    announce(`${item.label} 품질 검사를 시작합니다.`);

    const isCurrent = () =>
      mountedRef.current &&
      generationRef.current === token &&
      activeRef.current === job &&
      itemsRef.current.some(
        entry =>
          entry.key === item.key &&
          entry.blob === item.blob &&
          entry.state === "running"
      );

    void (async () => {
      let lastReport = "";
      let lastReportTime = 0;
      try {
        const analyzer = new AudioQualityAnalyzer();
        job.analyzer = analyzer;
        const result = await analyzer.analyze(item.blob, message => {
          if (!isCurrent() || !message || message === lastReport) return;
          const now = Date.now();
          if (lastReportTime && now - lastReportTime < 700) return;
          lastReport = message;
          lastReportTime = now;
          updateItems(current =>
            current.map(entry =>
              entry.key === item.key &&
              entry.blob === item.blob &&
              entry.state === "running"
                ? { ...entry, message }
                : entry
            )
          );
        });
        if (!isCurrent()) return;
        if (!validReport(result)) {
          throw new Error(
            "재생 길이, 채널 또는 샘플레이트를 확인할 수 없어 전체 음원을 검사하지 못했습니다."
          );
        }
        updateItems(current =>
          current.map(entry =>
            entry.key === item.key &&
            entry.blob === item.blob &&
            entry.state === "running"
              ? { ...entry, state: "done", message: undefined, result }
              : entry
          )
        );
        announce(`${item.label} 품질 검사가 완료되었습니다.`);
      } catch (error) {
        if (!isCurrent()) return;
        const message = errorText(error);
        updateItems(current =>
          current.map(entry =>
            entry.key === item.key &&
            entry.blob === item.blob &&
            entry.state === "running"
              ? { ...entry, state: "failed", message }
              : entry
          )
        );
        announce(`${item.label} 품질 검사 실패: ${message}`);
      } finally {
        if (activeRef.current === job && generationRef.current === token) {
          activeRef.current = null;
          try {
            job.analyzer?.dispose();
          } finally {
            busyCallbackRef.current(false);
          }
        }
      }
    })();
  }, [items, otherBusy]);

  const addFiles = (files: FileList | null) => {
    if (!files?.length || activeRef.current || otherBusyRef.current) return;
    const available =
      MAX_FILES - itemsRef.current.filter(item => !item.sourceId).length;
    const added: QualityItem[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      if (!SUPPORTED_EXTENSION.test(file.name)) {
        rejected.push(`${file.name}: 지원하지 않는 확장자`);
      } else if (file.size === 0) {
        rejected.push(`${file.name}: 빈 파일`);
      } else if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name}: 256 MiB 초과`);
      } else if (added.length >= available) {
        rejected.push(`${file.name}: 파일 수 제한`);
      } else {
        const number = nextFileRef.current++;
        added.push({
          key: `file:${number}`,
          label: `${file.name} (파일 ${number})`,
          blob: file,
          state: "waiting",
        });
      }
    }
    if (added.length) updateItems(current => [...current, ...added]);
    const message = `${added.length}개 파일을 추가해 순차 검사를 예약했습니다.${rejected.length ? ` 제외 ${rejected.length}개: ${rejected.join("; ")}.` : ""}`;
    showNotice(message);
    announce(message);
  };

  const cancelAll = () => {
    const active = interrupt();
    let cancelled = 0;
    updateItems(current =>
      current.map(item => {
        if (
          item.state !== "waiting" &&
          !(active && item.key === active.key && item.blob === active.blob)
        )
          return item;
        cancelled++;
        return {
          ...item,
          state: "cancelled",
          message: "검사가 취소되었습니다. 다시 검사할 수 있습니다.",
        };
      })
    );
    if (cancelled) {
      const message = `진행 중이거나 대기 중인 검사 ${cancelled}개를 취소했습니다. 완료된 보고서는 유지됩니다.`;
      showNotice(message);
      announce(message);
    }
  };

  const retry = (keys: string[]) => {
    if (otherBusyRef.current || activeRef.current) return;
    const selected = new Set(keys);
    let count = 0;
    updateItems(current =>
      current.map(item => {
        if (
          !selected.has(item.key) ||
          (item.state !== "failed" && item.state !== "cancelled")
        )
          return item;
        count++;
        return {
          ...item,
          state: "waiting",
          message: undefined,
          result: undefined,
        };
      })
    );
    if (count) {
      const message = `${count}개 항목의 검사를 다시 예약했습니다.`;
      showNotice(message);
      announce(message);
    }
  };

  const removeFile = (key: string, restoreFocus: boolean) => {
    const item = itemsRef.current.find(
      entry => entry.key === key && !entry.sourceId
    );
    if (!item) return;
    if (
      activeRef.current?.key === item.key &&
      activeRef.current.blob === item.blob
    )
      interrupt();
    restoreListFocusRef.current = restoreFocus;
    updateItems(current => current.filter(entry => entry !== item));
    const message = `${item.label} 항목을 목록에서 삭제했습니다. 원본 파일은 변경하지 않았습니다.`;
    showNotice(message);
    announce(message);
  };

  const downloadReport = async (item: QualityItem, format: "csv" | "pdf") => {
    const downloadKey = `${item.key}:${format}`;
    if (pendingDownloadsRef.current.has(downloadKey)) return;
    const isCurrent = () => mountedRef.current && itemsRef.current.some(entry =>
      entry.key === item.key && entry.blob === item.blob && entry.state === "done" &&
      entry.result === item.result && !!entry.result &&
      (!entry.sourceId || sourcesRef.current.some(source => source.id === entry.sourceId && source.blob === entry.blob))
    );
    if (!isCurrent() || item.state !== "done" || !item.result) {
      const message = "완료된 검사 결과만 내려받을 수 있습니다.";
      showNotice(message);
      announce(message);
      return;
    }
    pendingDownloadsRef.current.add(downloadKey);
    setDownloads(current => [...current, downloadKey]);
    const input = { state: "done" as const, label: item.label, report: item.result };
    announce(`${item.label} ${format.toUpperCase()} 보고서 생성을 시작합니다.`);
    try {
      let blob: Blob;
      if (format === "pdf") {
        const { createQualityPdf, loadReportFont } = await import("@/lib/quality-report-pdf");
        blob = await createQualityPdf(input, await loadReportFont());
      } else {
        blob = createQualityCsv(input);
      }
      if (!isCurrent()) {
        const message = "검사 결과가 변경되어 이전 보고서 다운로드를 취소했습니다.";
        showNotice(message);
        announce(message);
        return;
      }
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = qualityReportFilename(item.label, format);
        anchor.hidden = true;
        document.body.appendChild(anchor);
        try { anchor.click(); } finally { anchor.remove(); }
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
      // Retain the URL long enough for browsers to start reading the Blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const message = `${item.label} ${format.toUpperCase()} 보고서 다운로드를 시작했습니다. 브라우저의 저장 상태를 확인해 주세요.`;
      showNotice(message);
      announce(message);
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : "브라우저 또는 저장 공간을 확인해 주세요.";
      const message = `${item.label} ${format.toUpperCase()} 보고서를 만들거나 다운로드하지 못했습니다. ${detail}`;
      showNotice(message);
      announce(message);
    } finally {
      pendingDownloadsRef.current.delete(downloadKey);
      if (mountedRef.current) setDownloads(current => current.filter(key => key !== downloadKey));
    }
  };

  // During a source prop change, hide the old result even before reconciliation runs.
  const visibleItems = items.filter(
    item =>
      !item.sourceId ||
      sources.some(
        source => source.id === item.sourceId && source.blob === item.blob
      )
  );
  const waiting = visibleItems.filter(item => item.state === "waiting");
  const failed = visibleItems.filter(item => item.state === "failed");
  const cancelled = visibleItems.filter(item => item.state === "cancelled");
  const running = visibleItems.some(item => item.state === "running");
  const externalCount = visibleItems.filter(item => !item.sourceId).length;

  return (
    <section
      id="quality-panel"
      className="quality-panel"
      aria-labelledby={`${inputId}-heading`}
    >
      <div className="quality-header">
        <div>
          <div className="quality-kicker">AUDIO QUALITY CHECK</div>
          <h2 id={`${inputId}-heading`}>오디오 품질 점검</h2>
          <p>
            완성된 제작 음원은 자동으로, 가지고 있는 오디오는 파일을 선택해
            하나씩 검사합니다.
          </p>
        </div>
        <span className="quality-header-icon" aria-hidden="true">
          <AudioLines size={21} />
        </span>
      </div>

      <div className="quality-notice">
        <Info size={18} aria-hidden="true" />
        <div>
          <strong>참고용 점검입니다</strong>
          <ul>
            <li>
              표본 피크와 전체 RMS는 표준 LUFS나 true peak 측정·인증이 아닙니다.
            </li>
            <li>
              원고와 대조한 누락·발음, 배경음과 낭독의 적절한 균형은 검사하지
              못합니다. 최종 결과를 반드시 직접 들어 주세요.
            </li>
            <li>
              음원을 자동 수정하거나 재인코딩하지 않습니다. 파일은 외부로
              업로드하지 않고 기기에서 검사합니다.
            </li>
            <li>
              탭을 닫거나 새로고침하면 목록과 보고서가 사라집니다. 기기와
              브라우저의 메모리 한계로 검사에 실패할 수 있습니다.
            </li>
            <li id={`${inputId}-report-help`}>
              보고서는 기기에서 생성하며 검사 결과를 서버로 보내지 않습니다.
              PDF 태그와 읽기 순서는 검증하지 않아 PDF 접근성을 보장하지
              않습니다. CSV를 대안으로 이용해 주세요. CSV의 수식 실행 방지를
              위해 일부 값 앞에 작은따옴표가 추가될 수 있습니다.
            </li>
          </ul>
        </div>
      </div>

      <div className="quality-file-field">
        <label htmlFor={inputId}>기존 오디오 파일 선택</label>
        <input
          id={inputId}
          type="file"
          multiple
          accept=".mp3,.wav,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/flac,audio/x-flac"
          disabled={running || otherBusy || externalCount >= MAX_FILES}
          aria-describedby={`${inputId}-file-help`}
          onChange={event => {
            addFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <p id={`${inputId}-file-help`}>
          MP3·WAV·FLAC, 최대 {MAX_FILES}개, 파일당 256 MiB. 실제 형식이나
          브라우저 지원 여부에 따라 검사가 실패할 수 있습니다. 현재{" "}
          {externalCount}/{MAX_FILES}개.
        </p>
      </div>
      {otherBusy && (
        <p className="quality-inline-note">
          다른 오디오 작업이 진행 중입니다. 파일 추가와 재시도는 종료 후
          가능하며, 예약된 검사는 자동으로 시작합니다.
        </p>
      )}
      <div className="quality-actions">
        {(running || waiting.length > 0) && (
          <FocusRestoringButton
            type="button"
            className="quality-stop"
            onClick={cancelAll}
            onFocusedRemoval={restoreFocusAfterRemoval}
          >
            검사 및 대기 취소
          </FocusRestoringButton>
        )}
        <button
          type="button"
          className="quality-secondary"
          disabled={running || otherBusy || failed.length === 0}
          onClick={() => retry(failed.map(item => item.key))}
        >
          실패 항목 다시 검사
        </button>
        <button
          type="button"
          className="quality-secondary"
          disabled={running || otherBusy || cancelled.length === 0}
          onClick={() => retry(cancelled.map(item => item.key))}
        >
          취소 항목 다시 검사
        </button>
      </div>
      {notice && <p className="quality-action-notice">{notice}</p>}
      <div
        className="quality-sr-only"
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
      >
        {events.map(event => (
          <p key={event.id}>{event.text}</p>
        ))}
      </div>

      <div className="quality-list-heading">
        <h3 ref={listHeadingRef} tabIndex={-1}>
          검사 목록
        </h3>
        <p>
          대기 {waiting.length}개 · 완료{" "}
          {visibleItems.filter(item => item.state === "done").length}개 · 실패{" "}
          {failed.length}개 · 취소 {cancelled.length}개
        </p>
      </div>
      {!visibleItems.length ? (
        <div className="quality-empty">
          제작 음원이 완성되거나 파일을 선택하면 검사 결과가 이곳에 표시됩니다.
        </div>
      ) : (
        <ul className="quality-list">
          {visibleItems.map(item => (
            <li key={item.key} className="quality-item">
              <div className="quality-item-top">
                <div className="quality-item-name">
                  <strong>{item.label}</strong>
                  <span>
                    {item.sourceId
                      ? "제작 음원 · 자동 점검"
                      : "선택한 원본 파일"}
                  </span>
                </div>
                <span className={`quality-badge quality-badge-${item.state}`}>
                  {item.state === "running" && (
                    <LoaderCircle
                      className="quality-spin"
                      size={14}
                      aria-hidden="true"
                    />
                  )}
                  {STATE_LABELS[item.state]}
                </span>
              </div>
              {item.message && (
                <p
                  className={
                    item.state === "failed"
                      ? "quality-error"
                      : "quality-item-message"
                  }
                >
                  {item.state === "failed" ? "실패 이유: " : ""}
                  {item.message}
                </p>
              )}
              {item.state === "done" && item.result && <ResultDetails report={item.result} />}
              <div className="quality-item-actions">
                {item.state === "done" && item.result && (["csv", "pdf"] as const).map(format => (
                  <FocusRestoringButton
                    key={format}
                    type="button"
                    className="quality-secondary"
                    aria-label={`${item.label} ${format.toUpperCase()} 품질 보고서 다운로드`}
                    aria-describedby={`${inputId}-report-help`}
                    aria-disabled={downloads.includes(`${item.key}:${format}`)}
                    onClick={() => { void downloadReport(item, format); }}
                    onFocusedRemoval={restoreFocusAfterRemoval}
                  >
                    {format.toUpperCase()} 다운로드
                  </FocusRestoringButton>
                ))}
                {(item.state === "failed" || item.state === "cancelled") && (
                  <FocusRestoringButton
                    type="button"
                    className="quality-secondary"
                    disabled={running || otherBusy}
                    onClick={() => retry([item.key])}
                    onFocusedRemoval={restoreFocusAfterRemoval}
                    aria-label={`${item.label} 다시 검사`}
                  >
                    다시 검사
                  </FocusRestoringButton>
                )}
                {!item.sourceId && (
                  <button
                    type="button"
                    className="quality-remove"
                    onClick={event =>
                      removeFile(
                        item.key,
                        document.activeElement === event.currentTarget
                      )
                    }
                    aria-label={`${item.label} 목록에서 삭제`}
                  >
                    <Trash2 size={15} aria-hidden="true" /> 삭제
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="quality-privacy">
        <strong>내 기기에서 점검</strong> · 원본을 변경하거나 서버에 전송하지
        않습니다. 검사 결과는 청취 검수를 대신하지 않습니다.
        {" "}<a href={`${import.meta.env.BASE_URL}licenses/QUALITY_REPORT_NOTICE.md`}>보고서 글꼴과 소프트웨어 이용 조건</a>
      </p>
      <p className="quality-privacy">
        <a href={`${import.meta.env.BASE_URL}accessibility/screen-reader-tests.zip`} download>VoiceOver·TalkBack 점검 스크립트 다운로드 (ZIP)</a> · 실제 기기에서 별도로 실행하고 발화와 탐색을 직접 확인해야 합니다.
      </p>
    </section>
  );
}
