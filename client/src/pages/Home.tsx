import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, CircleHelp,
  FileText, Headphones, Info, LoaderCircle, Pause, Play, Sparkles, Upload, Volume2,
} from "lucide-react";
import { TtsEngine } from "@/lib/tts-engine";
import { hasPendingSoundscapeWork, mixSoundscape, waitForSoundscapeIdle, type Cue, type MixOptions } from "@/lib/soundscape";
import { extractManuscript } from "@/lib/manuscript-import";
import BatchConverter from "@/components/BatchConverter";
import QualityPanel from "@/components/QualityPanel";

type Language = "ko" | "en";
type PresetId = "narration" | "balanced" | "immersive";
type Result = {
  url: string; blob: Blob; cues: Cue[]; duration: number; title: string; voice: string;
  lang: Language; text: string; speed: number; mixUrl?: string; mixBlob?: Blob;
  events?: { label: string; time: number }[]; warnings?: string[]; mixOptions?: MixOptions;
  mixPending?: boolean; mixUnavailableReason?: string;
};

const presets: { id: PresetId; name: string; speed: number; musicVolume: number }[] = [
  { id: "narration", name: "낭독 집중", speed: 0.90, musicVolume: 0.2 },
  { id: "balanced", name: "균형", speed: 0.95, musicVolume: 0.5 },
  { id: "immersive", name: "장면 몰입", speed: 1.00, musicVolume: 0.7 },
];

const voices = [
  { id: "F1", name: "여성 01", color: "lavender" },
  { id: "F2", name: "여성 02", color: "rose" },
  { id: "F3", name: "여성 03", color: "peach" },
  { id: "F4", name: "여성 04", color: "blue" },
  { id: "F5", name: "여성 05", color: "green" },
  { id: "M1", name: "남성 01", color: "blue" },
  { id: "M2", name: "남성 02", color: "green" },
  { id: "M3", name: "남성 03", color: "peach" },
  { id: "M4", name: "남성 04", color: "lavender" },
  { id: "M5", name: "남성 05", color: "rose" },
];

const example: Record<Language, string> = {
  ko: "해가 저문 뒤, 작은 도서관에는 빗소리만 남았습니다.\n\n창가에 앉은 나는 오래된 책을 천천히 펼쳤습니다. 책장 사이에서 마른 잎 하나가 조용히 미끄러져 나왔습니다.\n\n누군가 이곳에서 보냈을 따뜻한 오후를 떠올리며, 나는 한동안 그 잎을 바라보았습니다.",
  en: "After sunset, only the sound of rain remained in the little library.\n\nSitting by the window, I slowly opened an old book. A dry leaf slipped quietly from between its pages.\n\nI watched it for a while, imagining the warm afternoon someone had once spent there.",
};

function formatTime(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export default function Home() {
  // A previous Home may have unmounted while Web Audio was still working.
  const initialSoundscapeWait = useRef(hasPendingSoundscapeWork());
  const [lang, setLang] = useState<Language>("ko");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("나의 오디오북");
  const [voice, setVoice] = useState("F1");
  const [speed, setSpeed] = useState(0.95);
  const [selectedPreset, setSelectedPreset] = useState<PresetId | null>("balanced");
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(initialSoundscapeWait.current);
  const [waitingForSoundscape, setWaitingForSoundscape] = useState(initialSoundscapeWait.current);
  const [batchBusy, setBatchBusy] = useState(false);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [status, setStatus] = useState(initialSoundscapeWait.current ? "이전 음향 처리가 마무리될 때까지 기다리고 있어요" : "");
  const [progress, setProgress] = useState<number | undefined>();
  const [error, setError] = useState("");
  const [fileNotice, setFileNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [music, setMusic] = useState(true);
  const [effects, setEffects] = useState(true);
  const [spatial, setSpatial] = useState(true);
  const [musicVolume, setMusicVolume] = useState(0.5);
  const [effectsVolume, setEffectsVolume] = useState(0.5);
  const [playVersion, setPlayVersion] = useState<"mixed" | "voice">("voice");
  // Async mix completions must use the latest user choice, not the render that started the mix.
  const playVersionRef = useRef<"mixed" | "voice">("voice");
  const fileReadRevision = useRef(0);
  const activeFileRead = useRef<number | null>(null);
  const mounted = useRef(true);
  const engine = useRef<TtsEngine | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const resultAudio = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const generatedUrl = useRef<string | null>(null);
  const mixedUrl = useRef<string | null>(null);
  const operation = useRef(0);
  const mixAbort = useRef<AbortController | null>(null);
  const selectedVoice = voices.find(item => item.id === voice)!;
  const resultIsOutdated = result && (result.text !== text.trim() || result.title !== (title.trim() || "나의 오디오북") || result.voice !== voice || result.lang !== lang || result.speed !== speed);
  const currentMix: MixOptions = { music, effects, musicVolume, effectsVolume, spatial };
  const settingsChanged = result?.mixOptions && JSON.stringify(result.mixOptions) !== JSON.stringify(currentMix);
  const mixComponents = [
    result?.mixOptions?.music && result.mixOptions.musicVolume > 0 ? "배경 음악" : "",
    result?.mixOptions?.effects && result.mixOptions.effectsVolume > 0 && result.events?.length ? "장면 효과음" : "",
  ].filter(Boolean);
  // A settings-only render must not make the quality panel re-inspect the same blobs.
  const qualitySources = useMemo<{ id: "voice" | "mixed"; label: string; blob: Blob }[]>(() => {
    const sources: { id: "voice" | "mixed"; label: string; blob: Blob }[] = [];
    if (result?.blob) sources.push({ id: "voice", label: "낭독만", blob: result.blob });
    if (result?.mixUrl && result.mixBlob) sources.push({ id: "mixed", label: "음향 포함", blob: result.mixBlob });
    return sources;
  }, [result?.blob, result?.mixBlob, result?.mixUrl]);

  const stopResultAudio = () => {
    const audio = resultAudio.current;
    if (!audio) return;
    audio.pause();
    // An unloaded player can reject a seek; replacing its source still starts at zero.
    try { audio.currentTime = 0; } catch { /* no loaded timeline */ }
  };

  const updatePlayVersion = (next: "mixed" | "voice") => {
    playVersionRef.current = next;
    setPlayVersion(next);
  };

  const selectPlayVersion = (next: "mixed" | "voice") => {
    if (next === playVersionRef.current || (next === "mixed" && !result?.mixUrl)) return;
    stopResultAudio();
    updatePlayVersion(next);
  };

  const invalidateFileRead = () => {
    fileReadRevision.current++;
    if (activeFileRead.current !== null) setFileNotice("원고나 제목이 바뀌어 읽고 있는 파일의 결과를 적용하지 않습니다. 파일 읽기가 끝나기를 기다려 주세요.");
  };

  const stopPreview = () => {
    previewAudio.current?.pause();
    previewAudio.current = null;
    setPlayingPreview(null);
  };

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      fileReadRevision.current++;
    };
  }, []);

  useEffect(() => {
    const id = operation.current;
    if (initialSoundscapeWait.current) {
      void waitForSoundscapeIdle().then(() => {
        if (operation.current !== id) return;
        setWaitingForSoundscape(false);
        setBusy(false);
        setStatus("");
      });
    }
    return () => {
      operation.current++;
      mixAbort.current?.abort();
      engine.current?.dispose();
      previewAudio.current?.pause();
      resultAudio.current?.pause();
      if (generatedUrl.current) URL.revokeObjectURL(generatedUrl.current);
      if (mixedUrl.current) URL.revokeObjectURL(mixedUrl.current);
    };
  }, []);

  const changeLanguage = (next: Language) => {
    stopPreview();
    setLang(next);
  };

  const applyPreset = (preset: typeof presets[number]) => {
    setSpeed(preset.speed);
    setMusicVolume(preset.musicVolume);
    setSelectedPreset(preset.id);
  };

  const playPreview = async (id: string) => {
    setError("");
    if (playingPreview === id) {
      stopPreview();
      return;
    }
    stopPreview();
    resultAudio.current?.pause();
    const audio = new Audio(`${import.meta.env.BASE_URL}voice-previews/${lang}/${id}.mp3`);
    previewAudio.current = audio;
    audio.onended = () => { if (previewAudio.current === audio) stopPreview(); };
    audio.onerror = () => { if (previewAudio.current === audio) { stopPreview(); setError("목소리 미리보기를 불러오지 못했습니다. 다시 시도해 주세요."); } };
    try {
      await audio.play();
      if (previewAudio.current === audio && !audio.paused) setPlayingPreview(id);
    } catch {
      if (previewAudio.current === audio) {
        stopPreview();
        setError("목소리 미리보기를 재생하지 못했습니다. 브라우저의 소리 설정을 확인해 주세요.");
      }
    }
  };

  const loadFile = async (file?: File) => {
    if (!file) return;
    if (activeFileRead.current !== null) return;
    if ((text.trim() || (title.trim() && title !== "나의 오디오북")) && !window.confirm("파일을 불러오면 현재 원고와 제목이 바뀝니다. 계속할까요?")) {
      setFileError("");
      setFileNotice("파일 불러오기를 취소했습니다. 기존 원고는 그대로 남아 있습니다.");
      return;
    }
    const revision = ++fileReadRevision.current;
    activeFileRead.current = revision;
    setFileLoading(true);
    setFileError("");
    setFileNotice("파일에서 원고를 읽고 있습니다. 읽기가 끝날 때까지 제작을 기다려 주세요.");
    const isCurrentRead = () => mounted.current && fileReadRevision.current === revision;
    const announceDiscard = () => {
      if (mounted.current && activeFileRead.current === revision) setFileNotice("원고나 작업이 변경되어 이전 파일 불러오기를 건너뛰었습니다.");
    };
    try {
      const { text: content, warnings } = await extractManuscript(file);
      if (!isCurrentRead()) { announceDiscard(); return; }
      setText(content);
      setTitle(file.name.replace(/\.(txt|pdf|docx)$/i, "").slice(0, 100) || "나의 오디오북");
      const limitNotice = content.length > 10000 ? " 원고가 10,000자를 넘습니다. 내용은 자르지 않았으며, 제작할 때 장이나 단락별로 나눠 주세요." : "";
      setFileNotice(`원고 ${content.length.toLocaleString()}자를 불러왔습니다.${limitNotice}${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
    } catch (fileReadError) {
      if (!isCurrentRead()) { announceDiscard(); return; }
      setFileNotice("기존 원고는 변경되지 않았습니다.");
      setFileError(fileReadError instanceof Error ? fileReadError.message : "파일을 읽지 못했습니다. 파일을 확인한 뒤 다시 시도해 주세요.");
    } finally {
      if (activeFileRead.current === revision) {
        activeFileRead.current = null;
        if (mounted.current) setFileLoading(false);
      }
    }
  };

  const generate = async () => {
    if (busy || fileLoading || activeFileRead.current !== null) return;
    if (batchBusy) { setError("일괄 변환 또는 ZIP 준비가 끝난 뒤 제작을 시작해 주세요."); return; }
    if (qualityBusy) { setError("오디오 품질 검사가 끝난 뒤 제작을 시작해 주세요."); return; }
    if (!text.trim()) { setError("먼저 읽을 원고를 입력해 주세요."); return; }
    if (text.length > 10000) { setError("안정적인 제작을 위해 원고를 10,000자 이하로 나눠 입력해 주세요."); return; }
    fileReadRevision.current++;
    const id = ++operation.current;
    setBusy(true);
    setError("");
    setProgress(undefined);
    setStatus("음성 제작을 준비하고 있어요.");
    stopPreview();
    try {
      if (!engine.current) engine.current = new TtsEngine();
      const output = await engine.current.generate({ text: text.trim(), lang, voice, speed }, (message, percent) => {
        if (operation.current === id) { setStatus(message); setProgress(percent); }
      });
      if (operation.current !== id) return;
      const url = URL.createObjectURL(output.blob);
      stopResultAudio();
      if (generatedUrl.current) URL.revokeObjectURL(generatedUrl.current);
      if (mixedUrl.current) URL.revokeObjectURL(mixedUrl.current);
      mixedUrl.current = null;
      generatedUrl.current = url;
      const willMix = currentMix.music || currentMix.effects;
      const draft: Result = {
        url, blob: output.blob, cues: output.cues, duration: output.duration,
        title: title.trim() || "나의 오디오북", voice, lang, text: text.trim(), speed,
        mixPending: willMix,
        mixUnavailableReason: willMix ? "음향을 처리하는 중이라 현재는 낭독만 사용할 수 있습니다." : "배경 음악과 효과음이 꺼져 있어 낭독만 만들었습니다.",
        mixOptions: willMix ? undefined : currentMix,
      };
      setResult(draft);
      updatePlayVersion("voice");
      if (willMix) {
        setStatus("장면 단서를 찾고 배경음을 준비하고 있어요.");
        setProgress(undefined);
        try {
          const aborter = new AbortController();
          mixAbort.current = aborter;
          const mixed = await mixSoundscape(output.blob, output.cues, currentMix, message => {
            if (operation.current === id) setStatus(message);
          }, aborter.signal);
          if (operation.current !== id) return;
          const hasSound = (currentMix.music && currentMix.musicVolume > 0) || (currentMix.effects && currentMix.effectsVolume > 0 && mixed.events.length > 0);
          const mixUrl = hasSound ? URL.createObjectURL(mixed.blob) : undefined;
          mixedUrl.current = mixUrl ?? null;
          setResult({ ...draft, mixUrl, mixBlob: mixUrl ? mixed.blob : undefined, mixPending: false, mixUnavailableReason: mixUrl ? undefined : "추가된 배경 음악이나 효과음이 없어 낭독만 만들었습니다.", events: mixed.events, warnings: mixed.warnings, mixOptions: currentMix });
        } catch (mixError) {
          if (operation.current !== id) return;
          setResult({ ...draft, mixPending: false, mixUnavailableReason: "음향 처리에 실패해 낭독만 사용할 수 있습니다. 음향 설정을 다시 적용해 보세요." });
          setError(`음향을 넣지 못했습니다. 낭독만 파일은 아래에서 다운로드할 수 있습니다. ${mixError instanceof Error ? mixError.message : "다시 시도해 주세요."}`);
          setStatus("낭독이 완료되었지만 음향을 적용하지 못했습니다.");
          setProgress(100);
          return;
        }
      }
      setStatus("음성 제작이 완료되었어요.");
      setProgress(100);
    } catch (err) {
      if (operation.current !== id) return;
      const message = err instanceof Error ? err.message : "음성을 만들지 못했습니다. 다시 시도해 주세요.";
      if (message === "음성 생성이 취소되었습니다.") {
        setError("");
        setStatus("제작을 취소했습니다. 입력한 원고는 그대로 남아 있어요.");
      } else {
        setError(message);
        setStatus("");
      }
      setProgress(undefined);
    } finally {
      if (operation.current === id) { mixAbort.current = null; setBusy(false); }
    }
  };

  const cancel = () => {
    if (waitingForSoundscape) return;
    const id = ++operation.current;
    mixAbort.current?.abort();
    mixAbort.current = null;
    engine.current?.dispose();
    engine.current = null;
    setResult(previous => previous?.mixPending
      ? { ...previous, mixPending: false, mixUnavailableReason: "음향 처리를 취소해 낭독만 사용할 수 있습니다. 음향 설정을 다시 적용할 수 있어요." }
      : previous);
    setProgress(undefined);
    setError("");
    if (!hasPendingSoundscapeWork()) {
      setBusy(false);
      setStatus("제작을 취소했습니다. 입력한 원고는 그대로 남아 있어요.");
      return;
    }
    setBusy(true);
    setWaitingForSoundscape(true);
    setStatus("이전 음향 처리가 마무리될 때까지 기다리고 있어요");
    void waitForSoundscapeIdle().then(() => {
      if (operation.current !== id) return;
      setWaitingForSoundscape(false);
      setBusy(false);
      setStatus("제작을 취소했습니다. 입력한 원고는 그대로 남아 있어요.");
    });
  };

  const remix = async () => {
    if (!result || busy || batchBusy || qualityBusy || fileLoading || activeFileRead.current !== null) return;
    const id = ++operation.current;
    setError("");
    if (!currentMix.music && !currentMix.effects) {
      if (playVersionRef.current === "mixed") {
        stopResultAudio();
        updatePlayVersion("voice");
      }
      if (mixedUrl.current) URL.revokeObjectURL(mixedUrl.current);
      mixedUrl.current = null;
      setResult({ ...result, mixUrl: undefined, mixBlob: undefined, mixPending: false, mixUnavailableReason: "배경 음악과 효과음이 꺼져 있어 낭독만 사용할 수 있습니다.", events: [], warnings: [], mixOptions: currentMix });
      return;
    }
    setBusy(true);
    if (!result.mixUrl) setResult({ ...result, mixPending: true, mixUnavailableReason: "음향을 처리하는 중이라 현재는 낭독만 사용할 수 있습니다." });
    setProgress(undefined);
    setStatus("기존 낭독에 음향을 다시 적용하고 있어요.");
    try {
      const aborter = new AbortController();
      mixAbort.current = aborter;
      const mixed = await mixSoundscape(result.blob, result.cues, currentMix, message => {
        if (operation.current === id) setStatus(message);
      }, aborter.signal);
      if (operation.current !== id) return;
      const hasSound = (currentMix.music && currentMix.musicVolume > 0) || (currentMix.effects && currentMix.effectsVolume > 0 && mixed.events.length > 0);
      const mixUrl = hasSound ? URL.createObjectURL(mixed.blob) : undefined;
      // Only the old mixed file is being replaced; never interrupt the voice file.
      const audio = resultAudio.current;
      if (playVersionRef.current === "mixed" && mixedUrl.current && audio?.src === mixedUrl.current && !audio.paused) stopResultAudio();
      if (!mixUrl && playVersionRef.current === "mixed") updatePlayVersion("voice");
      if (mixedUrl.current) URL.revokeObjectURL(mixedUrl.current);
      mixedUrl.current = mixUrl ?? null;
      setResult({ ...result, mixUrl, mixBlob: mixUrl ? mixed.blob : undefined, mixPending: false, mixUnavailableReason: mixUrl ? undefined : "추가된 배경 음악이나 효과음이 없어 낭독만 사용할 수 있습니다.", events: mixed.events, warnings: mixed.warnings, mixOptions: currentMix });
      setStatus("음향을 다시 적용했어요.");
    } catch (mixError) {
      if (operation.current !== id) return;
      if (!result.mixUrl) setResult({ ...result, mixPending: false, mixUnavailableReason: "음향 처리에 실패해 낭독만 사용할 수 있습니다. 음향 설정을 다시 적용해 보세요." });
      setError(`음향을 적용하지 못했습니다. ${result.mixUrl ? "이전 음향 포함 버전과 낭독만 버전은 그대로 남아 있습니다." : "기존 낭독은 그대로 남아 있습니다."} ${mixError instanceof Error ? mixError.message : "다시 시도해 주세요."}`);
    } finally {
      if (operation.current === id) { mixAbort.current = null; setBusy(false); }
    }
  };

  const safeName = (result?.title || "audiobook").replace(/[\\/:*?"<>|]+/g, "_");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="텍타일오디오 홈">
          <span className="brand-mark"><AudioLines size={23} strokeWidth={2.4} /></span>
          <span className="brand-word">텍타일오디오<span>.</span><small>오디오북 제작실</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <div className="side-link active"><AudioLines size={17} /> <span>오디오 제작</span><span className="side-dot" /></div>
        <div className="sidebar-bottom">
          <div className="side-help-icon"><Headphones size={18} /></div>
          <div><strong>나만의 목소리 작업실</strong><p>이야기가 소리가 되는 곳</p></div>
        </div>
        <div className="side-version">텍타일오디오 <span> / </span> BETA</div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">워크스페이스 <span>/</span> <strong>오디오 제작</strong></div>
          <div className="top-right"><span className="local-pill"><span /> 내 기기에서 생성</span><span className="beta-pill">BETA</span></div>
        </header>

        <div className="workspace">
          <div className="page-intro">
            <div><div className="eyebrow"><span /> AUDIOBOOK STUDIO</div><h1>원고에 목소리를 더하다<span>.</span></h1><p>당신의 이야기를 듣는 경험으로 만들어 보세요.</p></div>
            <div className="intro-decoration" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
          </div>

          <div className="steps" aria-label="제작 과정"><span><b>01</b> 원고 입력</span><i /><span><b>02</b> 목소리 선택</span><i /><span><b>03</b> 제작 및 다운로드</span></div>
          <p className="batch-shortcut">이미 완성된 오디오가 있으신가요? <a href="#batch-converter">여러 파일 형식 한꺼번에 변환하기 <ArrowRight size={14} aria-hidden="true" /></a></p>

          <div className="workspace-grid">
            <div className="left-column">
              <section className="panel manuscript-panel">
                <div className="panel-header"><div><div className="section-kicker">YOUR MANUSCRIPT</div><h2><span className="section-number">01</span> 원고 입력</h2><p>텍스트를 직접 입력하거나 파일을 불러오세요.</p></div><div className="header-icon"><FileText size={19} /></div></div>
                <label className="field-label" htmlFor="book-title">제목 <span>파일명으로 사용돼요</span></label>
                <input id="book-title" name="secret_book_title" className="title-input" value={title} onChange={event => { invalidateFileRead(); setTitle(event.target.value); }} maxLength={100} disabled={busy} />
                <div className="manuscript-label"><label className="field-label" htmlFor="manuscript">원고 <span>최대 10,000자</span></label><div className="text-actions"><button type="button" onClick={() => { invalidateFileRead(); setText(example[lang]); }} disabled={busy}>예시 원고 넣기</button><span /> <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || fileLoading} aria-describedby="file-import-help"><Upload size={13} aria-hidden="true" /> 파일 불러오기</button></div></div>
                <input ref={fileRef} type="file" accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={event => { void loadFile(event.target.files?.[0]); event.target.value = ""; }} />
                <div className="editor-wrap"><textarea id="manuscript" name="secret_manuscript" value={text} onChange={event => { invalidateFileRead(); setText(event.target.value); }} placeholder="이곳에 들려주고 싶은 이야기를 입력해 주세요.\n\n문장과 문단을 구분하면 더 자연스러운 낭독에 도움이 됩니다." aria-describedby="file-import-help" disabled={busy} /><div className="editor-bottom"><span>직접 입력 또는 TXT · PDF · DOCX</span><strong className={text.length > 10000 ? "over-limit" : ""}>{text.length.toLocaleString()} <em>/ 10,000자</em></strong></div></div>
                <p className="editor-note" role="status" aria-live="polite">{fileNotice}</p>
                {fileError && <p className="editor-note" role="alert">{fileError}</p>}
                <div className="editor-note" id="file-import-help"><Info size={15} aria-hidden="true" /><span>TXT·PDF·DOCX 파일은 20MB까지 기기에서 읽습니다. 스캔한 PDF는 글자를 읽지 못하며, 그림과 복잡한 표·배치는 누락되거나 순서가 달라질 수 있어 확인이 필요합니다.</span></div>
                <div className="editor-note"><Info size={15} /><span>긴 책은 장이나 단락별로 나눠 제작하면 검수와 수정이 쉬워요.</span></div>
              </section>

              <section className="panel voices-panel">
                <div className="panel-header"><div><div className="section-kicker">FIND YOUR VOICE</div><h2><span className="section-number">02</span> 목소리 선택</h2><p>마음에 드는 목소리를 미리 들어보고 선택하세요.</p></div><div className="header-icon"><Volume2 size={19} /></div></div>
                <div className="voice-list-header"><span>기본 목소리 <b>10</b></span><span>미리듣기는 짧은 예시 문장입니다</span></div>
                <div className="voice-grid">
                  {voices.map(item => <div key={item.id} className={`voice-card ${voice === item.id ? "selected" : ""}`}>
                    <button type="button" className="voice-select" onClick={() => setVoice(item.id)} disabled={busy} aria-pressed={voice === item.id} aria-label={`${item.name} 선택`}>
                      <span className={`voice-avatar ${item.color}`}><AudioLines size={21} /></span>
                      <span className="voice-description"><strong>{item.name}</strong><small>{item.id} · 기본 음성</small></span>
                      {voice === item.id && <span className="voice-check"><Check size={12} strokeWidth={3} /></span>}
                    </button>
                    <button type="button" className={`preview-btn ${playingPreview === item.id ? "is-playing" : ""}`} onClick={() => void playPreview(item.id)} disabled={busy} aria-label={`${item.name} ${playingPreview === item.id ? "미리듣기 정지" : "미리듣기"}`} title="목소리 미리듣기">{playingPreview === item.id ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</button>
                  </div>)}
                </div>
                <p className="voice-disclaimer">이 목소리들은 공개 기본 프리셋으로, 회사 전용 또는 독점 목소리는 아닙니다.</p>
              </section>
            </div>

            <aside className="right-column">
              <section className="panel settings-panel">
                <div className="panel-header compact"><div><div className="section-kicker">MAKE IT SOUND</div><h2><span className="section-number">03</span> 오디오 제작</h2><p>이야기를 들을 준비가 되었나요?</p></div><span className="sparkle"><Sparkles size={17} /></span></div>
                <div className="setting-block"><span className="field-label">원고 언어</span><div className="language-toggle" role="group" aria-label="원고 언어"><button type="button" aria-pressed={lang === "ko"} className={lang === "ko" ? "active" : ""} onClick={() => changeLanguage("ko")} disabled={busy}>한국어 <span>KO</span></button><button type="button" aria-pressed={lang === "en"} className={lang === "en" ? "active" : ""} onClick={() => changeLanguage("en")} disabled={busy}>English <span>EN</span></button></div><p className="setting-hint">입력한 원고의 언어와 맞춰 주세요.</p></div>
                <div className="setting-block selected-summary"><span className="field-label">선택한 목소리</span><div className="selection-row"><span className={`small-avatar ${selectedVoice.color}`}><AudioLines size={16} /></span><div><strong>{selectedVoice.name}</strong><small>{voice} · {lang === "ko" ? "한국어" : "English"}</small></div><Check size={16} /></div></div>
                <fieldset className="sound-options" aria-describedby="preset-help preset-existing-help">
                  <legend>제작 프리셋</legend>
                  {presets.map(preset => <button key={preset.id} type="button" className={`version-option ${selectedPreset === preset.id ? "selected" : ""}`} style={{ width: "100%", textAlign: "left" }} aria-pressed={selectedPreset === preset.id} onClick={() => applyPreset(preset)} disabled={busy}>
                    <span className="version-copy"><strong>{preset.name}</strong><small>읽는 속도 {preset.speed.toFixed(2)}× · 배경 음악 {Math.round(preset.musicVolume * 100)}%</small></span>
                    {selectedPreset === preset.id && <span className="version-selected" aria-hidden="true">선택됨</span>}
                  </button>)}
                  <p role="status" aria-live="polite">현재 설정: {selectedPreset ? `${presets.find(preset => preset.id === selectedPreset)!.name} 선택됨` : "수동 조절"} · 읽는 속도 {speed.toFixed(2)}× · 음악 크기 {Math.round(musicVolume * 100)}% · 배경 음악 {music ? "켜짐" : "꺼짐"}</p>
                  <p id="preset-help">프리셋은 읽는 속도와 음악 크기만 바꿉니다. 배경 음악이 꺼져 있어도 크기를 조절할 수 있으며 자동으로 켜지지 않습니다. 효과음과 다른 설정은 그대로이며 아래 슬라이더로 직접 조절할 수 있습니다.</p>
                  <p id="preset-existing-help">기존 낭독의 속도는 바뀌지 않습니다. 바뀐 속도로 들으려면 새로 제작해야 합니다. 기존 음향 포함 파일에 바뀐 음악 크기를 반영하려면 음향 설정을 다시 적용해야 합니다.</p>
                </fieldset>
                <div className="setting-block speed-block"><label className="field-label" htmlFor="speed">읽는 속도 <strong>{speed.toFixed(2)}×</strong></label><input id="speed" type="range" min="0.8" max="1.2" step="0.05" value={speed} aria-valuetext={`${speed.toFixed(2)}배`} onChange={event => { setSpeed(Number(event.target.value)); setSelectedPreset(null); }} disabled={busy} /><div className="range-label"><span>천천히</span><span>보통</span><span>빠르게</span></div></div>
                <fieldset className="sound-options" aria-describedby="sound-help"><legend>자동 음향 <span>시범 기능</span></legend>
                  <label className="sound-toggle"><input type="checkbox" checked={music} onChange={event => setMusic(event.target.checked)} disabled={busy} /><span><strong>배경 음악</strong><small>차분한 음악을 자동으로 넣어요</small></span></label>
                  <label className="sound-range" htmlFor="music-volume">음악 크기 <strong>{Math.round(musicVolume * 100)}%</strong></label><input className="sound-slider" id="music-volume" type="range" min="0" max="1" step="0.1" value={musicVolume} aria-valuetext={`${Math.round(musicVolume * 100)}%`} onChange={event => { setMusicVolume(Number(event.target.value)); setSelectedPreset(null); }} disabled={busy} />
                  <label className="sound-toggle"><input type="checkbox" checked={effects} onChange={event => setEffects(event.target.checked)} disabled={busy} /><span><strong>장면 효과음</strong><small>원고 속 단서에 맞춰 자동으로 넣어요</small></span></label>
                  <label className="sound-range" htmlFor="effects-volume">효과음 크기 <strong>{Math.round(effectsVolume * 100)}%</strong></label><input className="sound-slider" id="effects-volume" type="range" min="0" max="1" step="0.1" value={effectsVolume} onChange={event => setEffectsVolume(Number(event.target.value))} disabled={busy || !effects} />
                  <label className="sound-toggle"><input type="checkbox" checked={spatial} onChange={event => setSpatial(event.target.checked)} disabled={busy || (!music && !effects)} /><span><strong>입체 음향 · 이어폰 권장</strong><small>효과음에 창작적인 방향과 거리감을 더해요</small></span></label>
                  <p id="sound-help">비, 숲, 바다, 발소리, 문, 책장과 관련된 표현·동작 및 일부 부정 표현을 살펴보고 낭독의 쉼을 참고해 배치합니다. 문맥을 완전히 이해하거나 단어별로 정확하게 맞추는 기능은 아니므로 효과음과 타이밍을 꼭 확인해 주세요.</p>
                  <p>입체 모드는 개인 맞춤이 아닌 2채널 헤드폰용 시제품입니다. 방향·거리감은 창작적인 연출이며 돌비 애트모스나 영화관 다채널 믹스가 아닙니다.</p>
                  <p>효과음은 TinyAudio로 미리 만든 시험용 AI 음향으로 실제 녹음이 아닙니다. 실시간 생성은 지원하지 않으며, 특히 발소리·문·책장·파도는 실제와 다르거나 작게 들릴 수 있으니 직접 확인해 주세요.</p>
                  <details className="effect-preview">
                    <summary>시범 효과음 미리 듣기</summary>
                    <p>소리의 적합성은 사람의 청취 검수가 필요합니다. 원치 않으면 장면 효과음을 끌 수 있습니다.</p>
                    {[
                      ["rain", "비"], ["forest", "숲"], ["ocean", "파도"],
                      ["footsteps", "발소리"], ["door", "문"], ["page", "책장"],
                    ].map(([name, label]) => <div className="effect-preview-item" key={name}>
                      <span>{label}</span>
                      <audio controls preload="none" src={`${import.meta.env.BASE_URL}soundscape/tinyaudio-v1/${name}.mp3`} aria-label={`${label} 시범 효과음 미리듣기`} />
                    </div>)}
                  </details>
                  <p>음향 포함 작업은 최대 10분까지 지원합니다. 배경 음악은 별도 시험용 AI 자산이므로 상업 배포 전 이용 권리를 확인해 주세요.</p>
                </fieldset>
                <button type="button" className="generate-btn" onClick={() => void generate()} disabled={busy || batchBusy || qualityBusy || fileLoading}>{busy ? <><LoaderCircle size={18} className="spin" /> 제작 중이에요</> : <><Sparkles size={18} /> 오디오 만들기 <ArrowRight size={17} /></>}</button>
                {fileLoading && <p className="batch-busy-note" role="status">원고 파일을 읽는 중입니다. 읽기가 끝난 뒤 오디오를 제작할 수 있어요.</p>}
                {batchBusy && <p className="batch-busy-note" role="status">일괄 변환 또는 ZIP 준비가 진행 중입니다. 끝난 뒤 오디오를 제작할 수 있어요.</p>}
                {qualityBusy && <p className="batch-busy-note" role="status">오디오 품질 검사 중입니다. 검사가 끝난 뒤 오디오 제작이나 음향 재적용, 일괄 변환을 시작할 수 있어요.</p>}
                {busy && <div className="progress-box" role="status"><div className="progress-head"><span>{status}</span>{typeof progress === "number" && <strong>{Math.round(progress)}%</strong>}</div><div className="progress-track"><span style={{ width: `${typeof progress === "number" ? Math.max(3, Math.min(100, progress)) : 8}%` }} /></div><p>{waitingForSoundscape ? "브라우저에서 이미 시작한 음향 작업은 즉시 중단할 수 없어 오래 걸릴 수 있습니다. 작업이 끝날 때까지 새 오디오 작업을 시작할 수 없어요." : "긴 원고는 시간이 걸릴 수 있어요. 제작 중 이 페이지를 열어 두세요."}</p><button type="button" className="cancel-btn" onClick={cancel} disabled={waitingForSoundscape}>{waitingForSoundscape ? "처리 종료 대기 중" : "제작 취소"}</button></div>}
                {!busy && status.startsWith("제작을 취소") && <div className="cancel-notice" role="status">{status}</div>}
                {error && <div role="alert" className="error-box"><Info size={16} /> {error}</div>}
                <div className="privacy-note"><span><Check size={13} /></span><p><strong>원고는 내 기기에서 처리돼요</strong><br />음성 합성 서버에 원고를 보내지 않습니다.</p></div>
              </section>

              <section className={`panel output-panel ${result ? "has-result" : ""}`}>
                <div className="output-heading"><div><div className="section-kicker">YOUR AUDIO</div><h2>완성된 오디오</h2></div><span className="output-icon"><Headphones size={18} /></span></div>
                {result ? <div className="audio-result"><div className="result-file"><span className="result-file-icon"><AudioLines size={20} /></span><div><strong>{result.title}</strong><small>{result.lang === "ko" ? "한국어" : "English"} · {result.voice} · {formatTime(result.duration)}</small></div><span className="ready-tag">{resultIsOutdated ? "이전 결과" : "완료"}</span></div>
                  {resultIsOutdated && <p className="stale-notice">현재 원고나 설정을 바꾸기 전에 만든 오디오입니다.</p>}
                  {result.speed !== speed && <p className="stale-notice" role="status">기존 낭독은 {result.speed.toFixed(2)}× 속도로 그대로입니다. 현재 속도 {speed.toFixed(2)}×를 반영하려면 새로 제작해 주세요. 음향 재적용만으로는 낭독 속도가 바뀌지 않습니다.</p>}
                  {result.mixUrl ? <fieldset className="version-picker" aria-describedby="version-help">
                    <legend>들을 버전 선택</legend>
                    <p id="version-help">버전을 바꾸면 재생이 멈추고 처음부터 다시 재생됩니다.</p>
                    <label className={`version-option ${playVersion === "voice" ? "selected" : ""}`}>
                      <input type="radio" name="play-version" value="voice" checked={playVersion === "voice"} onChange={() => selectPlayVersion("voice")} />
                      <span className="version-copy"><strong>낭독만</strong><small>배경 음악과 효과음 없이 목소리만 들려요.</small></span>
                      {playVersion === "voice" && <span className="version-selected" aria-hidden="true">선택됨</span>}
                    </label>
                    <label className={`version-option ${playVersion === "mixed" ? "selected" : ""}`}>
                      <input type="radio" name="play-version" value="mixed" checked={playVersion === "mixed"} onChange={() => selectPlayVersion("mixed")} />
                      <span className="version-copy"><strong>음향 포함</strong><small>낭독 + {mixComponents.join(" + ") || "배경 음악 또는 장면 효과음"}</small></span>
                      {playVersion === "mixed" && <span className="version-selected" aria-hidden="true">선택됨</span>}
                    </label>
                  </fieldset> : <div className="version-single">
                    <strong>사용 가능한 버전 · 낭독만</strong>
                    <p>배경 음악과 효과음 없이 목소리만 들려요.</p>
                    {result.mixUnavailableReason && <p>{result.mixUnavailableReason}</p>}
                  </div>}
                  <audio ref={resultAudio} key={playVersion === "mixed" && result.mixUrl ? result.mixUrl : result.url} controls src={playVersion === "mixed" && result.mixUrl ? result.mixUrl : result.url} preload="metadata" aria-label={playVersion === "mixed" && result.mixUrl ? "음향 포함 오디오 재생" : "낭독만 오디오 재생"} onPlay={stopPreview} />
                  <div className="download-heading">{result.mixUrl ? "두 버전 개별 다운로드" : "낭독만 다운로드"}</div>
                  {result.mixUrl && <p className="download-hint">청취 선택과 관계없이 각 파일을 따로 저장할 수 있어요.</p>}
                  <a href={result.url} download={`${safeName}_낭독만.mp3`} className="download-btn"><ArrowDownToLine size={16} aria-hidden="true" /> 낭독만 MP3 다운로드</a>
                  {result.mixUrl && <a href={result.mixUrl} download={`${safeName}_음향포함.mp3`} className="download-btn voice-download"><ArrowDownToLine size={16} aria-hidden="true" /> 음향 포함 MP3 다운로드</a>}
                  {result.events && result.events.length > 0 && <div className="cue-summary"><strong>자동 배치된 효과음</strong><p>{result.events.map(event => `${formatTime(event.time)} ${event.label}`).join(" · ")}</p></div>}
                  {result.warnings?.map((warning, index) => <p className="sound-warning" key={`${index}-${warning}`}>{warning}</p>)}
                  {settingsChanged && <p className="sound-warning">음향 설정을 변경했습니다. 아래 버튼으로 기존 낭독에 다시 적용해 주세요.</p>}
                  {(settingsChanged || (!result.mixOptions && (music || effects))) && <button type="button" className="remix-btn" onClick={() => void remix()} disabled={busy || batchBusy || qualityBusy || fileLoading}>완성된 낭독에 음향 설정 다시 적용</button>}
                  <p className="result-disclaimer">음향 파일은 합쳐진 MP3라서 재생 중 소리별 조절은 되지 않습니다. 새로 제작하면 기존 결과가 교체되므로 필요한 파일은 먼저 다운로드해 주세요. 새로고침하면 화면의 결과는 사라집니다.</p></div> : <div className="output-empty"><div className="empty-wave"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div><strong>아직 만들어진 오디오가 없어요</strong><p>원고와 목소리를 선택하고<br />오디오를 만들어 보세요.</p></div>}
                {result && <a className="quality-shortcut" href="#quality-panel">완성된 오디오 자동 점검 결과 보기 <ArrowRight size={14} aria-hidden="true" /></a>}
              </section>
              <div className="model-note"><CircleHelp size={15} /><p>처음 제작할 때 낭독 모델 약 380MB를 다운로드합니다. TinyAudio 효과음은 미리 제작된 파일을 사용하며 별도 모델 다운로드가 필요하지 않습니다.</p></div>
            </aside>
          </div>
          <QualityPanel sources={qualitySources} otherBusy={busy || batchBusy} onBusyChange={setQualityBusy} />
          <BatchConverter otherBusy={busy || qualityBusy} onBusyChange={setBatchBusy} />
          <footer><span>© 텍타일오디오 · AI 생성 음성</span><span>Supertonic 3 · <a href={`${import.meta.env.BASE_URL}licenses/index.html`} target="_blank" rel="noreferrer">오픈소스 및 이용 조건</a></span></footer>
        </div>
      </main>
    </div>
  );
}
