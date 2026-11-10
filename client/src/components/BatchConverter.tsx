import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  AudioLines,
  FileArchive,
  Info,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import { AudioConverter, type AudioFormat } from "@/lib/audio-converter";
import { makeZip, partitionZipEntries, type ZipEntry } from "@/lib/batch-zip";
import "./BatchConverter.css";

type BatchResult = {
  blob: Blob;
  url: string;
  name: string;
  warnings: string[];
  inputChannels: number;
  outputChannels: number;
  inputSampleRate: number;
  outputSampleRate: number;
};
type BatchItem = {
  id: number;
  file: File;
  state: "waiting" | "running" | "done" | "failed";
  message?: string;
  cancelled?: boolean;
  result?: BatchResult;
};
type ReadyZip = { url: string; groupIndex: number; name: string };
type Props = { otherBusy: boolean; onBusyChange: (running: boolean) => void };

const RESULT_LIMIT = 256 * 1024 * 1024;
const SUPPORTED_EXTENSION = /\.(mp3|wav|flac)$/i;
const stateLabel: Record<BatchItem["state"], string> = {
  waiting: "대기",
  running: "진행 중",
  done: "완료",
  failed: "실패",
};

function sizeText(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function resultBytes(items: BatchItem[]): number {
  return items.reduce((sum, item) => sum + (item.result?.blob.size ?? 0), 0);
}

function nameKey(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

// Shorten on UTF-8 character boundaries so downloaded names work across filesystems.
function shortenName(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const length = encoder.encode(char).length;
    if (bytes + length > maxBytes) break;
    result += char;
    bytes += length;
  }
  return result;
}

function outputName(
  file: File,
  format: AudioFormat,
  items: BatchItem[]
): string {
  const decoded = new TextDecoder().decode(
    new TextEncoder().encode(file.name.normalize("NFKC"))
  );
  let base = decoded
    .replace(SUPPORTED_EXTENSION, "")
    .replace(
      /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f\ufeff<>:"/\\|?*\u2044\u2215]/g,
      "_"
    )
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/u, "")
    .trim();
  base = shortenName(base, 160).replace(/[.\s]+$/u, "") || "오디오";
  // A separate suffix prevents a same-format result from having the input name.
  base += "_변환";
  const used = new Set<string>();
  for (const item of items) {
    used.add(nameKey(item.file.name));
    if (item.result) used.add(nameKey(item.result.name));
  }
  let candidate = `${base}.${format}`;
  let n = 2;
  while (used.has(nameKey(candidate))) candidate = `${base} (${n++}).${format}`;
  return candidate;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "파일을 변환하지 못했습니다. 파일과 브라우저 상태를 확인해 주세요.";
}

export default function BatchConverter({ otherBusy, onBusyChange }: Props) {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [format, setFormat] = useState<AudioFormat>("mp3");
  const [running, setRunning] = useState(false);
  const [zipBuilding, setZipBuilding] = useState<number | null>(null);
  const [readyZip, setReadyZip] = useState<ReadyZip | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [fileAnnouncements, setFileAnnouncements] = useState<{ id: number; text: string }[]>([]);
  const itemsRef = useRef<BatchItem[]>([]);
  const nextId = useRef(1);
  const mounted = useRef(true);
  const operation = useRef(0);
  const active = useRef<"convert" | "zip" | null>(null);
  const engine = useRef<AudioConverter | null>(null);
  const zipAbort = useRef<AbortController | null>(null);
  const readyZipRef = useRef<ReadyZip | null>(null);
  const downloadUrls = useRef(new Set<string>());
  const downloadTimers = useRef(new Set<number>());
  const busyCallback = useRef(onBusyChange);
  const nextAnnouncement = useRef(0);
  const zipDownloadLink = useRef<HTMLAnchorElement | null>(null);
  const returnZipFocus = useRef(false);
  busyCallback.current = onBusyChange;

  // Keep the authoritative queue in a ref: callbacks and cancel handlers must not
  // depend on a render having committed a previous async state update.
  const updateItems = (update: (current: BatchItem[]) => BatchItem[]) => {
    const next = update(itemsRef.current);
    itemsRef.current = next;
    if (mounted.current) setItems(next);
  };
  const say = (message: string) => {
    if (mounted.current) setAnnouncement(message);
  };
  const announceFile = (message: string) => {
    if (mounted.current) setFileAnnouncements(current => [...current.slice(-19), { id: nextAnnouncement.current++, text: message }]);
  };
  const clearReadyZip = () => {
    if (readyZipRef.current) URL.revokeObjectURL(readyZipRef.current.url);
    readyZipRef.current = null;
    if (mounted.current) setReadyZip(null);
  };

  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      // A download click cannot tell us whether the user actually saved the file.
      if (itemsRef.current.length || active.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const pageHide = (event: PageTransitionEvent) => {
      // beforeunload might be cancelled, so only stop work after navigation is
      // actually happening. A bfcache restore may keep the queue and results.
      operation.current++;
      zipAbort.current?.abort();
      zipAbort.current = null;
      engine.current?.dispose();
      engine.current = null;
      if (active.current) {
        active.current = null;
        if (event.persisted) {
          updateItems(current =>
            current.map(item =>
              item.state === "running"
                ? {
                    ...item,
                    state: "waiting",
                    cancelled: true,
                    message:
                      "페이지를 떠나 변환이 중단되었습니다. 다시 대기합니다.",
                  }
                : item
            )
          );
          setRunning(false);
          setZipBuilding(null);
          say("페이지를 떠나 작업을 중단했습니다. 다시 실행해 주세요.");
        }
        busyCallback.current(false);
      }
      if (!event.persisted) {
        for (const item of itemsRef.current)
          if (item.result) URL.revokeObjectURL(item.result.url);
        if (readyZipRef.current) URL.revokeObjectURL(readyZipRef.current.url);
        readyZipRef.current = null;
        for (const timer of downloadTimers.current) window.clearTimeout(timer);
        for (const url of downloadUrls.current) URL.revokeObjectURL(url);
        downloadTimers.current.clear();
        downloadUrls.current.clear();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
      mounted.current = false;
      operation.current++;
      zipAbort.current?.abort();
      zipAbort.current = null;
      engine.current?.dispose();
      engine.current = null;
      for (const item of itemsRef.current)
        if (item.result) URL.revokeObjectURL(item.result.url);
      if (readyZipRef.current) URL.revokeObjectURL(readyZipRef.current.url);
      readyZipRef.current = null;
      for (const timer of downloadTimers.current) window.clearTimeout(timer);
      for (const url of downloadUrls.current) URL.revokeObjectURL(url);
      downloadTimers.current.clear();
      downloadUrls.current.clear();
      if (active.current) {
        active.current = null;
        busyCallback.current(false);
      }
    };
  }, []);

  useEffect(() => {
    if (readyZip && returnZipFocus.current && document.activeElement === document.body) {
      zipDownloadLink.current?.focus();
    }
    if (readyZip) returnZipFocus.current = false;
  }, [readyZip]);

  const addFiles = (files: FileList | null) => {
    if (active.current || !files?.length) return;
    const selected = Array.from(files);
    const accepted = selected.filter(file =>
      SUPPORTED_EXTENSION.test(file.name)
    );
    const rejected = selected.length - accepted.length;
    if (accepted.length) {
      clearReadyZip();
      updateItems(current => [
        ...current,
        ...accepted.map(file => ({
          id: nextId.current++,
          file,
          state: "waiting" as const,
        })),
      ]);
    }
    say(
      `${accepted.length}개 파일을 추가했습니다.${rejected ? ` 지원하지 않는 확장자 ${rejected}개는 제외했습니다.` : ""}`
    );
  };

  const removeItem = (id: number) => {
    if (active.current) return;
    const item = itemsRef.current.find(entry => entry.id === id);
    if (!item) return;
    if (item.result && !window.confirm(`${item.result.name} 결과를 삭제할까요? 다운로드하지 않았다면 결과가 사라집니다.`)) return;
    clearReadyZip();
    if (item.result) URL.revokeObjectURL(item.result.url);
    updateItems(current => current.filter(entry => entry.id !== id));
    say("항목을 목록에서 삭제했습니다.");
  };

  const removeCompleted = () => {
    if (active.current) return;
    const completed = itemsRef.current.filter(item => item.result);
    if (!completed.length) return;
    if (!window.confirm(`완료된 결과 ${completed.length}개를 목록에서 삭제할까요? 다운로드하지 않은 결과는 사라집니다.`)) return;
    clearReadyZip();
    for (const item of completed) URL.revokeObjectURL(item.result!.url);
    updateItems(current => current.filter(item => !item.result));
    say(`완료된 결과 ${completed.length}개를 목록에서 삭제했습니다.`);
  };

  const runQueue = async (which: "waiting" | "failed") => {
    if (active.current || otherBusy) return;
    if (resultBytes(itemsRef.current) >= RESULT_LIMIT) {
      say(
        "결과가 256 MiB 이상입니다. 필요한 결과를 저장한 뒤 목록에서 삭제하고 다시 실행해 주세요."
      );
      return;
    }
    const targets = itemsRef.current
      .filter(item => item.state === which)
      .map(item => item.id);
    if (!targets.length) return;
    clearReadyZip();
    // Capture the format and target IDs once for this entire run.
    const runFormat = format;
    const token = ++operation.current;
    active.current = "convert";
    setRunning(true);
    busyCallback.current(true);
    say(
      which === "failed"
        ? "실패한 항목을 다시 변환합니다."
        : "오디오 변환을 시작합니다."
    );
    let succeeded = 0;
    let failed = 0;
    let stoppedForMemory = false;
    try {
      for (const id of targets) {
        if (!mounted.current || operation.current !== token) return;
        if (resultBytes(itemsRef.current) >= RESULT_LIMIT) {
          stoppedForMemory = true;
          break;
        }
        const item = itemsRef.current.find(entry => entry.id === id);
        if (!item) continue;
        announceFile(`${item.file.name} 변환을 시작합니다.`);
        updateItems(current =>
          current.map(entry =>
            entry.id === id
              ? {
                  ...entry,
                  state: "running",
                  message: "변환을 준비하고 있습니다.",
                  cancelled: false,
                }
              : entry
          )
        );
        let converter: AudioConverter | null = null;
        let lastReport = "";
        let lastReportTime = 0;
        try {
          converter = new AudioConverter();
          engine.current = converter;
          const result = await converter.convert(
            item.file,
            runFormat,
            message => {
              if (
                !mounted.current ||
                operation.current !== token ||
                active.current !== "convert"
              )
                return;
              // Progress is visual only; the live region announces major transitions.
              const now = Date.now();
              if (
                !message ||
                message === lastReport ||
                (lastReportTime && now - lastReportTime < 700)
              )
                return;
              lastReport = message;
              lastReportTime = now;
              updateItems(current =>
                current.map(entry =>
                  entry.id === id && entry.state === "running"
                    ? { ...entry, message }
                    : entry
                )
              );
            }
          );
          if (!mounted.current || operation.current !== token) return;
          const name = outputName(item.file, runFormat, itemsRef.current);
          const url = URL.createObjectURL(result.blob);
          updateItems(current =>
            current.map(entry =>
              entry.id === id
                ? {
                    ...entry,
                    state: "done",
                    message: undefined,
                    result: { ...result, name, url },
                  }
                : entry
            )
          );
          succeeded++;
          announceFile(`${item.file.name} 변환이 완료되었습니다.`);
        } catch (error) {
          if (!mounted.current || operation.current !== token) return;
          failed++;
          announceFile(`${item.file.name} 변환 실패: ${errorText(error)}`);
          updateItems(current =>
            current.map(entry =>
              entry.id === id
                ? { ...entry, state: "failed", message: errorText(error) }
                : entry
            )
          );
        } finally {
          if (converter && engine.current === converter) {
            converter.dispose();
            engine.current = null;
          }
        }
      }
    } finally {
      if (mounted.current && operation.current === token) {
        active.current = null;
        setRunning(false);
        busyCallback.current(false);
        if (stoppedForMemory) {
          say(
            "완료 결과가 256 MiB 이상이라 다음 파일 전에 멈췄습니다. 필요한 결과를 저장한 뒤 삭제하고 이어서 실행해 주세요."
          );
        } else {
          say(
            `변환이 끝났습니다. 완료 ${succeeded}개, 실패 ${failed}개입니다.`
          );
        }
      }
    }
  };

  const stop = () => {
    if (active.current !== "convert") return;
    operation.current++;
    engine.current?.dispose();
    engine.current = null;
    active.current = null;
    updateItems(current =>
      current.map(item =>
        item.state === "running"
          ? {
              ...item,
              state: "waiting",
              cancelled: true,
              message: "변환을 취소해 다시 대기합니다.",
            }
          : item
      )
    );
    setRunning(false);
    busyCallback.current(false);
    say("변환을 중단했습니다. 현재 파일과 나머지 목록은 유지됩니다.");
  };

  const completedEntries = useMemo<ZipEntry[]>(
    () =>
      items.flatMap(item =>
        item.result ? [{ name: item.result.name, blob: item.result.blob }] : []
      ),
    [items]
  );
  const zipGroups = useMemo(
    () => partitionZipEntries(completedEntries),
    [completedEntries]
  );
  const totalBytes = resultBytes(items);
  const atLimit = totalBytes >= RESULT_LIMIT;
  const waitingCount = items.filter(item => item.state === "waiting").length;
  const failedCount = items.filter(item => item.state === "failed").length;
  const doneCount = completedEntries.length;
  const locked = running || zipBuilding !== null;

  const prepareZip = async (groupIndex: number) => {
    if (active.current || otherBusy) return;
    const entries = itemsRef.current.flatMap(item =>
      item.result ? [{ name: item.result.name, blob: item.result.blob }] : []
    );
    const group = partitionZipEntries(entries).groups[groupIndex];
    if (!group?.length) return;
    clearReadyZip();
    const token = ++operation.current;
    const controller = new AbortController();
    zipAbort.current = controller;
    active.current = "zip";
    setZipBuilding(groupIndex);
    busyCallback.current(true);
    say(`ZIP 묶음 ${groupIndex + 1}을 준비하고 있습니다.`);
    try {
      const blob = await makeZip(group, controller.signal);
      if (!mounted.current || token !== operation.current) return;
      const prepared = {
        url: URL.createObjectURL(blob),
        groupIndex,
        name: `변환된_오디오_${groupIndex + 1}.zip`,
      };
      readyZipRef.current = prepared;
      setReadyZip(prepared);
      say(
        `ZIP 묶음 ${groupIndex + 1}이 준비되었습니다. 다운로드 링크를 눌러 주세요.`
      );
    } catch (error) {
      if (mounted.current && token === operation.current) {
        returnZipFocus.current = false;
        say(error instanceof DOMException && error.name === "AbortError"
          ? "ZIP 준비를 취소했습니다. 완료된 오디오 파일은 그대로 남아 있습니다."
          : `ZIP을 준비하지 못했습니다. ${errorText(error)}`);
      }
    } finally {
      if (mounted.current && token === operation.current) {
        zipAbort.current = null;
        active.current = null;
        setZipBuilding(null);
        busyCallback.current(false);
      }
    }
  };

  const cancelZip = () => {
    if (active.current !== "zip") return;
    zipAbort.current?.abort();
    say("ZIP 준비를 중단하고 있습니다.");
  };

  const consumeZipLink = () => {
    const ready = readyZipRef.current;
    if (!ready) return;
    // Let the browser start the navigation before releasing the temporary URL.
    readyZipRef.current = null;
    setReadyZip(null);
    downloadUrls.current.add(ready.url);
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(ready.url);
      downloadUrls.current.delete(ready.url);
      downloadTimers.current.delete(timer);
    }, 5_000);
    downloadTimers.current.add(timer);
    say(
      "브라우저에 ZIP 다운로드를 요청했습니다. 저장 여부는 브라우저에서 확인해 주세요."
    );
  };

  return (
    <section
      id="batch-converter"
      className="batch-converter"
      aria-labelledby="batch-heading"
    >
      <div className="batch-header">
        <div>
          <div className="batch-kicker">AUDIO FORMAT CONVERTER</div>
          <h2 id="batch-heading">오디오 파일 일괄 변환</h2>
          <p>
            이미 만들어진 오디오를 내 기기에서 MP3, WAV 또는 FLAC으로 바꿔요.
            텍스트 음성 제작과는 별개의 기능입니다.
          </p>
        </div>
        <span className="batch-header-icon" aria-hidden="true">
          <AudioLines size={21} />
        </span>
      </div>

      <div className="batch-notice">
        <Info size={18} aria-hidden="true" />
        <div>
          <strong>변환 전 확인해 주세요</strong>
          <ul>
            <li>
              MP3·FLAC과 PCM 방식의 WAV(16비트·24비트·32비트 부동소수점)를
              지원하며 M4A·M4B는 지원하지 않습니다. 실제 오디오 형식과 코덱은
              변환할 때 검사합니다.
            </li>
            <li>
              손실 파일을 다시 인코딩하거나 같은 확장자로 변환하면 음질이 나빠질
              수 있습니다. WAV·FLAC으로 바꿔도 이미 손실된 음질은 복구되지
              않습니다.
            </li>
            <li>
              WAV·FLAC 결과는 24비트로 저장합니다. 24비트보다 높은 정밀도의
              원본은 일부 정밀도가 줄어들 수 있습니다.
            </li>
            <li>
              커버, 태그, 장과 책갈피가 사라질 수 있으니 원본 파일을 꼭 보관해
              주세요. 앱은 원본 파일에 직접 쓰지 않습니다. 다운로드할 때는 원본과
              다른 이름이나 폴더를 선택하고 브라우저의 덮어쓰기 경고를 확인하세요.
            </li>
            <li>
              결과 한 파일은 최대 128 MiB입니다. 완료 결과가 256 MiB 이상이면
              다음 파일 전에 멈춥니다. 휴대폰에서는 메모리 부족이 더 빨리 발생할
              수 있어요.
            </li>
            <li>
              변환 중에는 이 탭을 열어 두세요. 탭을 닫거나 새로고침하면 입력과
              결과가 사라지고 백그라운드 작업은 계속되지 않습니다.
            </li>
          </ul>
        </div>
      </div>

      <div className="batch-controls">
        <div className="batch-field batch-file-field">
          <label htmlFor="batch-files">오디오 파일 선택</label>
          <input
            id="batch-files"
            type="file"
            multiple
            accept=".mp3,.wav,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/flac,audio/x-flac"
            disabled={locked}
            onChange={event => {
              addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <p>
            파일을 여러 번 추가할 수 있습니다. 확장자가 같아도 명시적으로
            재변환할 수 있어요.
          </p>
        </div>
        <div className="batch-field batch-format-field">
          <label htmlFor="batch-format">결과 형식</label>
          <select
            id="batch-format"
            value={format}
            disabled={locked}
            onChange={event => setFormat(event.target.value as AudioFormat)}
          >
            <option value="mp3">MP3 · 192 kbps</option>
            <option value="wav">WAV · 24비트</option>
            <option value="flac">FLAC · 24비트</option>
          </select>
          <p>한 번 실행하는 동안 모든 파일에 같은 형식이 적용됩니다.</p>
        </div>
      </div>

      <div className="batch-actions">
        <button
          className="batch-primary"
          type="button"
          onClick={() => void runQueue("waiting")}
          disabled={locked || otherBusy || !waitingCount || atLimit}
        >
          {running ? (
            <>
              <LoaderCircle
                size={17}
                className="batch-spin"
                aria-hidden="true"
              />{" "}
              변환 중
            </>
          ) : (
            <>대기 항목 변환 시작</>
          )}
        </button>
        <button
          className="batch-secondary"
          type="button"
          onClick={() => void runQueue("failed")}
          disabled={locked || otherBusy || !failedCount || atLimit}
        >
          실패한 항목 다시 시도
        </button>
        {running && (
          <button className="batch-stop" type="button" onClick={stop}>
            변환 중단
          </button>
        )}
      </div>
      {otherBusy && (
        <p className="batch-inline-note">
          다른 오디오 작업이 진행 중입니다. 작업이 끝난 뒤 변환이나 ZIP 준비를
          시작해 주세요.
        </p>
      )}
      {waitingCount > 0 && failedCount > 0 && (
        <p className="batch-inline-note">
          다시 시도는 실패한 항목만 처리합니다. 대기 항목은 별도로 변환을 시작해
          주세요.
        </p>
      )}
      {atLimit && (
        <p className="batch-memory-note">
          완료 결과가 256 MiB 이상입니다. 필요한 결과를 먼저 저장하고, 저장
          여부를 확인한 뒤 완료 항목을 삭제하면 이어서 실행할 수 있습니다.
        </p>
      )}
      <p className="batch-live" role="status" aria-atomic="true">
        {announcement}
      </p>
      <div className="batch-sr-only" aria-live="polite" aria-relevant="additions" aria-atomic="false">
        {fileAnnouncements.map(entry => <p key={entry.id}>{entry.text}</p>)}
      </div>

      <div className="batch-list-heading">
        <div>
          <h3>작업 목록</h3>
          <p>
            전체 {items.length}개 · 대기 {waitingCount}개 · 완료 {doneCount}개 ·
            실패 {failedCount}개
          </p>
        </div>
        <span>완료 결과 {sizeText(totalBytes)} / 256 MiB</span>
      </div>
      {doneCount > 0 && (
        <button className="batch-remove" type="button" disabled={locked} onClick={removeCompleted}>
          <Trash2 size={15} aria-hidden="true" /> 완료 항목 모두 삭제
        </button>
      )}
      {!items.length ? (
        <div className="batch-empty">
          변환할 오디오 파일을 선택하면 이곳에 표시됩니다.
        </div>
      ) : (
        <ul className="batch-list">
          {items.map(item => (
            <li className="batch-item" key={item.id}>
              <div className="batch-item-top">
                <div className="batch-file-info">
                  <strong className="batch-file-name">{item.file.name}</strong>
                  <span>원본 {sizeText(item.file.size)}</span>
                </div>
                <span className={`batch-badge batch-badge-${item.state}`}>
                  {stateLabel[item.state]}
                  {item.cancelled && item.state === "waiting"
                    ? " · 취소됨"
                    : ""}
                </span>
              </div>
              {item.message && (
                <p
                  className={
                    item.state === "failed"
                      ? "batch-error"
                      : "batch-item-message"
                  }
                >
                  {item.state === "failed" ? "실패 이유: " : ""}
                  {item.message}
                </p>
              )}
              {item.result && (
                <div className="batch-result">
                  <p>
                    결과: <strong>{item.result.name}</strong> ·{" "}
                    {sizeText(item.result.blob.size)}
                  </p>
                  <p>
                    채널 {item.result.inputChannels} →{" "}
                    {item.result.outputChannels} · 샘플레이트{" "}
                    {item.result.inputSampleRate.toLocaleString()} →{" "}
                    {item.result.outputSampleRate.toLocaleString()} Hz
                  </p>
                  {item.result.warnings.map((warning, index) => (
                    <p
                      className="batch-result-warning"
                      key={`${index}-${warning}`}
                    >
                      안내: {warning}
                    </p>
                  ))}
                </div>
              )}
              <div className="batch-item-actions">
                {item.result && (
                  <a
                    className="batch-download"
                    href={item.result.url}
                    download={item.result.name}
                    aria-label={`${item.result.name} 개별 다운로드`}
                  >
                    <ArrowDownToLine size={16} aria-hidden="true" /> 개별
                    다운로드
                  </a>
                )}
                <button
                  className="batch-remove"
                  type="button"
                  disabled={locked}
                  onClick={() => removeItem(item.id)}
                  aria-label={`${item.file.name} 목록에서 삭제`}
                >
                  <Trash2 size={15} aria-hidden="true" /> 삭제
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {doneCount > 0 && (
        <div className="batch-zip-section">
          <h3>
            <FileArchive size={18} aria-hidden="true" /> 완료 파일 ZIP으로 받기
          </h3>
          <p>
            완료된 파일만 포함합니다. 대기·실패·취소된 파일은 포함되지 않습니다.
            ZIP은 헤더를 포함해 묶음당 최대 100 MiB이며, 버튼을 누르면 그때
            준비합니다.
          </p>
          <div className="batch-zip-list">
            {zipGroups.groups.map((group, index) => (
              <div className="batch-zip-group" key={index}>
                <div className="batch-zip-group-head">
                  <strong>
                    묶음 {index + 1} <span>· {group.length}개</span>
                  </strong>
                  {readyZip?.groupIndex === index ? (
                    <a
                      ref={zipDownloadLink}
                      className="batch-download"
                      href={readyZip.url}
                      download={readyZip.name}
                      onClick={consumeZipLink}
                    >
                      <ArrowDownToLine size={16} aria-hidden="true" /> ZIP
                      다운로드
                    </a>
                  ) : (
                    <button
                      className="batch-secondary"
                      type="button"
                      disabled={locked || otherBusy}
                      onClick={event => {
                        returnZipFocus.current = document.activeElement === event.currentTarget;
                        void prepareZip(index);
                      }}
                    >
                      {zipBuilding === index
                        ? "ZIP 준비 중"
                        : `묶음 ${index + 1} ZIP 준비`}
                    </button>
                  )}
                </div>
                <details>
                  <summary>포함 파일 보기</summary>
                  <ul>
                    {group.map(entry => (
                      <li key={entry.name}>
                        {entry.name} · {sizeText(entry.blob.size)}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            ))}
          </div>
          {zipBuilding !== null && (
            <button className="batch-stop" type="button" onClick={cancelZip}>ZIP 준비 취소</button>
          )}
          {zipGroups.tooLarge.length > 0 && (
            <div className="batch-large-notice">
              <strong>ZIP에 넣을 수 없는 큰 파일</strong>
              <p>
                파일 자체가 100 MiB를 넘거나 ZIP 헤더까지 포함하면 100 MiB를
                넘는 파일입니다. 위 작업 목록에서 각각 다운로드해 주세요.
              </p>
              <ul>
                {zipGroups.tooLarge.map(entry => (
                  <li key={entry.name}>
                    {entry.name} · {sizeText(entry.blob.size)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <p className="batch-privacy">
        <strong>내 기기에서 처리</strong> · 원본과 결과를 업로드하거나 자동
        저장하지 않습니다. 다운로드를 누른 뒤에는 실제 저장 여부를 브라우저에서
        확인해 주세요.
      </p>
    </section>
  );
}
