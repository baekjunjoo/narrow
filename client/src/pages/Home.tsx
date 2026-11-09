import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, CircleHelp,
  FileText, Headphones, Info, LoaderCircle, Pause, Play, Sparkles, Upload, Volume2,
} from "lucide-react";
import { TtsEngine } from "@/lib/tts-engine";

type Language = "ko" | "en";
type Result = { url: string; duration: number; title: string; voice: string; lang: Language; text: string; speed: number };

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
  const [lang, setLang] = useState<Language>("ko");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("나의 오디오북");
  const [voice, setVoice] = useState("F1");
  const [speed, setSpeed] = useState(0.95);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<number | undefined>();
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const engine = useRef<TtsEngine | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const generatedUrl = useRef<string | null>(null);
  const selectedVoice = voices.find(item => item.id === voice)!;
  const resultIsOutdated = result && (result.text !== text.trim() || result.title !== (title.trim() || "나의 오디오북") || result.voice !== voice || result.lang !== lang || result.speed !== speed);

  useEffect(() => () => {
    engine.current?.dispose();
    previewAudio.current?.pause();
    if (generatedUrl.current) URL.revokeObjectURL(generatedUrl.current);
  }, []);

  const changeLanguage = (next: Language) => {
    previewAudio.current?.pause();
    setPlayingPreview(null);
    setLang(next);
  };

  const playPreview = async (id: string) => {
    setError("");
    if (playingPreview === id) {
      previewAudio.current?.pause();
      setPlayingPreview(null);
      return;
    }
    previewAudio.current?.pause();
    const audio = new Audio(`/voice-previews/${lang}/${id}.mp3`);
    previewAudio.current = audio;
    audio.onended = () => setPlayingPreview(null);
    audio.onerror = () => { setPlayingPreview(null); setError("목소리 미리보기를 불러오지 못했습니다. 다시 시도해 주세요."); };
    try {
      await audio.play();
      setPlayingPreview(id);
    } catch {
      setPlayingPreview(null);
      setError("목소리 미리보기를 재생하지 못했습니다. 브라우저의 소리 설정을 확인해 주세요.");
    }
  };

  const loadFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".txt")) {
      setError("지금은 UTF-8 텍스트(.txt) 파일만 불러올 수 있습니다.");
      return;
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      setText(content);
      setTitle(file.name.replace(/\.txt$/i, "") || "나의 오디오북");
      setError("");
    } catch {
      setError("파일을 읽지 못했습니다. 텍스트를 UTF-8로 저장한 후 다시 불러와 주세요.");
    }
  };

  const generate = async () => {
    if (!text.trim()) { setError("먼저 읽을 원고를 입력해 주세요."); return; }
    if (text.length > 10000) { setError("안정적인 제작을 위해 원고를 10,000자 이하로 나눠 입력해 주세요."); return; }
    setBusy(true);
    setError("");
    setProgress(undefined);
    setStatus("음성 제작을 준비하고 있어요.");
    previewAudio.current?.pause();
    setPlayingPreview(null);
    try {
      if (!engine.current) engine.current = new TtsEngine();
      const output = await engine.current.generate({ text: text.trim(), lang, voice, speed }, (message, percent) => {
        setStatus(message);
        setProgress(percent);
      });
      const url = URL.createObjectURL(output.blob);
      if (generatedUrl.current) URL.revokeObjectURL(generatedUrl.current);
      generatedUrl.current = url;
      setResult({ url, duration: output.duration, title: title.trim() || "나의 오디오북", voice, lang, text: text.trim(), speed });
      setStatus("음성 제작이 완료되었어요.");
      setProgress(100);
    } catch (err) {
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
      setBusy(false);
    }
  };

  const cancel = () => {
    engine.current?.dispose();
    engine.current = null;
  };

  const safeName = (result?.title || "audiobook").replace(/[\\/:*?"<>|]+/g, "_");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Narravo 홈">
          <span className="brand-mark"><AudioLines size={23} strokeWidth={2.4} /></span>
          <span className="brand-word">narravo<span>.</span><small>오디오북 제작실</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <div className="side-link active"><AudioLines size={17} /> <span>오디오 제작</span><span className="side-dot" /></div>
        <div className="sidebar-bottom">
          <div className="side-help-icon"><Headphones size={18} /></div>
          <div><strong>나만의 목소리 작업실</strong><p>이야기가 소리가 되는 곳</p></div>
        </div>
        <div className="side-version">NARRAVO STUDIO <span> / </span> BETA</div>
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

          <div className="workspace-grid">
            <div className="left-column">
              <section className="panel manuscript-panel">
                <div className="panel-header"><div><div className="section-kicker">YOUR MANUSCRIPT</div><h2><span className="section-number">01</span> 원고 입력</h2><p>텍스트를 직접 입력하거나 파일을 불러오세요.</p></div><div className="header-icon"><FileText size={19} /></div></div>
                <label className="field-label" htmlFor="book-title">제목 <span>파일명으로 사용돼요</span></label>
                <input id="book-title" name="secret_book_title" className="title-input" value={title} onChange={event => setTitle(event.target.value)} maxLength={100} disabled={busy} />
                <div className="manuscript-label"><label className="field-label" htmlFor="manuscript">원고 <span>최대 10,000자</span></label><div className="text-actions"><button type="button" onClick={() => setText(example[lang])} disabled={busy}>예시 원고 넣기</button><span /> <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={13} /> TXT 불러오기</button></div></div>
                <input ref={fileRef} type="file" accept=".txt,text/plain" hidden onChange={event => { void loadFile(event.target.files?.[0]); event.target.value = ""; }} />
                <div className="editor-wrap"><textarea id="manuscript" name="secret_manuscript" value={text} onChange={event => setText(event.target.value)} placeholder="이곳에 들려주고 싶은 이야기를 입력해 주세요.\n\n문장과 문단을 구분하면 더 자연스러운 낭독에 도움이 됩니다." disabled={busy} /><div className="editor-bottom"><span>TXT 파일 또는 직접 입력</span><strong className={text.length > 10000 ? "over-limit" : ""}>{text.length.toLocaleString()} <em>/ 10,000자</em></strong></div></div>
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
                <div className="setting-block"><label className="field-label">원고 언어</label><div className="language-toggle"><button type="button" className={lang === "ko" ? "active" : ""} onClick={() => changeLanguage("ko")} disabled={busy}>한국어 <span>KO</span></button><button type="button" className={lang === "en" ? "active" : ""} onClick={() => changeLanguage("en")} disabled={busy}>English <span>EN</span></button></div><p className="setting-hint">입력한 원고의 언어와 맞춰 주세요.</p></div>
                <div className="setting-block selected-summary"><span className="field-label">선택한 목소리</span><div className="selection-row"><span className={`small-avatar ${selectedVoice.color}`}><AudioLines size={16} /></span><div><strong>{selectedVoice.name}</strong><small>{voice} · {lang === "ko" ? "한국어" : "English"}</small></div><Check size={16} /></div></div>
                <div className="setting-block speed-block"><label className="field-label" htmlFor="speed">읽는 속도 <strong>{speed.toFixed(2)}×</strong></label><input id="speed" type="range" min="0.8" max="1.2" step="0.05" value={speed} onChange={event => setSpeed(Number(event.target.value))} disabled={busy} /><div className="range-label"><span>천천히</span><span>보통</span><span>빠르게</span></div></div>
                <button type="button" className="generate-btn" onClick={() => void generate()} disabled={busy}>{busy ? <><LoaderCircle size={18} className="spin" /> 제작 중이에요</> : <><Sparkles size={18} /> 오디오 만들기 <ArrowRight size={17} /></>}</button>
                {busy && <div className="progress-box" role="status"><div className="progress-head"><span>{status}</span>{typeof progress === "number" && <strong>{Math.round(progress)}%</strong>}</div><div className="progress-track"><span style={{ width: `${typeof progress === "number" ? Math.max(3, Math.min(100, progress)) : 8}%` }} /></div><p>긴 원고는 시간이 걸릴 수 있어요. 제작 중 이 페이지를 열어 두세요.</p><button type="button" className="cancel-btn" onClick={cancel}>제작 취소</button></div>}
                {!busy && status.startsWith("제작을 취소") && <div className="cancel-notice" role="status">{status}</div>}
                {error && <div role="alert" className="error-box"><Info size={16} /> {error}</div>}
                <div className="privacy-note"><span><Check size={13} /></span><p><strong>원고는 내 기기에서 처리돼요</strong><br />음성 합성 서버에 원고를 보내지 않습니다.</p></div>
              </section>

              <section className={`panel output-panel ${result ? "has-result" : ""}`}>
                <div className="output-heading"><div><div className="section-kicker">YOUR AUDIO</div><h2>완성된 오디오</h2></div><span className="output-icon"><Headphones size={18} /></span></div>
                {result ? <div className="audio-result"><div className="result-file"><span className="result-file-icon"><AudioLines size={20} /></span><div><strong>{result.title}</strong><small>{result.lang === "ko" ? "한국어" : "English"} · {result.voice} · {formatTime(result.duration)}</small></div><span className="ready-tag">{resultIsOutdated ? "이전 결과" : "완료"}</span></div>{resultIsOutdated && <p className="stale-notice">현재 원고나 설정을 바꾸기 전에 만든 오디오입니다.</p>}<audio controls src={result.url} preload="metadata" aria-label="완성된 오디오 미리 듣기" /><a href={result.url} download={`${safeName}.mp3`} className="download-btn"><ArrowDownToLine size={16} /> MP3 다운로드</a><p>다시 제작하면 이 화면의 오디오가 교체됩니다. 필요한 파일은 먼저 다운로드해 주세요.</p></div> : <div className="output-empty"><div className="empty-wave"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div><strong>아직 만들어진 오디오가 없어요</strong><p>원고와 목소리를 선택하고<br />오디오를 만들어 보세요.</p></div>}
              </section>
              <div className="model-note"><CircleHelp size={15} /><p>처음 제작할 때 공개 모델 약 380MB를 다운로드합니다. 컴퓨터 성능과 인터넷 속도에 따라 시간이 걸릴 수 있어요.</p></div>
            </aside>
          </div>
          <footer><span>© Narravo Studio · AI 생성 음성</span><span>Supertonic 3 · <a href="/licenses/index.html" target="_blank" rel="noreferrer">오픈소스 및 이용 조건</a></span></footer>
        </div>
      </main>
    </div>
  );
}
