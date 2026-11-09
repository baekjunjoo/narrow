import * as ort from 'onnxruntime-web/webgpu';
import { Mp3Encoder } from '@breezystack/lamejs';
import type { TtsOptions } from './tts-engine';

// Local emitted asset, not a CDN version: the WASM binary must match the JS runtime.
import wasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';

// Based on Supertone's MIT-licensed web/helper.js; see TTS_ATTRIBUTION.md.
const ROOT = 'https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/aafc6e32416a594460b32413efc49d7fe4ce6d46';
const CACHE_NAME = 'narravo-supertonic3-aafc6e32416a';
const STEPS = 8;
const SILENCE_SECONDS = 0.3;
const MODEL_FILES = [
  { name: 'duration_predictor', size: 3_700_147 },
  { name: 'text_encoder', size: 36_416_150 },
  { name: 'vector_estimator', size: 256_534_781 },
  { name: 'vocoder', size: 101_424_195 },
] as const;
const TOTAL_MODEL_BYTES = MODEL_FILES.reduce((sum, model) => sum + model.size, 0);

type Config = { ae: { sample_rate: number; base_chunk_size: number }; ttl: { chunk_compress_factor: number; latent_dim: number } };
type StyleFile = { style_ttl: { dims: number[]; data: unknown[] }; style_dp: { dims: number[]; data: unknown[] } };
type Style = { ttl: ort.Tensor; dp: ort.Tensor };
type Backend = 'webgpu' | 'wasm';
type Sessions = { duration: ort.InferenceSession; encoder: ort.InferenceSession; vector: ort.InferenceSession; vocoder: ort.InferenceSession };
type Engine = { config: Config; indexer: number[]; sessions: Sessions; backend: Backend };
let engine: Engine | null = null;
const styles = new Map<string, Style>();
const cacheWrites = new WeakMap<Response, Promise<void>>();

// Single threaded WASM also works on deployments without cross-origin isolation.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false; // We are already inside our own dedicated Worker.
ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };

function report(message: string, percent?: number) {
  self.postMessage({ type: 'progress', message, percent: percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(percent))) });
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cachedFetch(path: string): Promise<Response> {
  const url = `${ROOT}/${path}`;
  // Cache Storage is optional (private browsing, storage quota and policy can disable it).
  let cache: Cache | undefined;
  try { cache = await caches.open(CACHE_NAME); } catch { /* fall back to HTTP cache */ }
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return hit;
    } catch { /* fall back to network */ }
  }
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Allow slow connections enough time to download the 245 MiB largest file.
      const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache', signal: AbortSignal.timeout(1_800_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (cache) {
        // Stream a clone into disk cache while the caller consumes the response. Quota
        // failures do not prevent synthesis; subsequent runs can re-download the file.
        cacheWrites.set(response, cache.put(url, response.clone()).catch(() => undefined));
      }
      return response;
    } catch (error) {
      last = error;
      if (attempt < 2) {
        report(`모델 연결을 다시 시도합니다 (${attempt + 2}/3)…`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw new Error(`${path} 다운로드 실패: ${errorText(last)}. 네트워크/CORS를 확인하고 다시 시도해 주세요.`);
}

async function jsonFile<T>(path: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response | undefined;
    try {
      response = await cachedFetch(path);
      const result = await response.json() as T;
      await cacheWrites.get(response);
      return result;
    } catch (error) {
      last = error;
      if (response) await cacheWrites.get(response);
      try { const cache = await caches.open(CACHE_NAME); await cache.delete(`${ROOT}/${path}`); } catch { /* optional cache */ }
      if (attempt < 2) {
        report(`${path} 파일을 다시 불러옵니다 (${attempt + 2}/3)…`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw new Error(`${path} 파일을 읽을 수 없습니다: ${errorText(last)}. 다시 시도해 주세요.`);
}

async function modelBytes(file: typeof MODEL_FILES[number], precedingBytes: number): Promise<Uint8Array> {
  const path = `onnx/${file.name}.onnx`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response | undefined;
    try {
      response = await cachedFetch(path);
      // Allocate only once instead of retaining the stream chunks alongside a
      // second large buffer; vector_estimator alone is about 245 MiB.
      const bytes = new Uint8Array(file.size);
      let count = 0;
      if (response.body) {
        const reader = response.body.getReader();
        let lastUpdate = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (count + value.byteLength > bytes.length) throw new Error('모델 크기가 예상보다 큽니다.');
          bytes.set(value, count);
          count += value.byteLength;
          const now = Date.now();
          if (now - lastUpdate > 150 || count === file.size) {
            const percent = 3 + 38 * (precedingBytes + count) / TOTAL_MODEL_BYTES;
            report(`모델 다운로드 중: ${file.name} (${Math.round((precedingBytes + count) / 1024 / 1024)} / ${Math.round(TOTAL_MODEL_BYTES / 1024 / 1024)} MB)`, percent);
            lastUpdate = now;
          }
        }
      } else {
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.length > bytes.length) throw new Error('모델 크기가 예상보다 큽니다.');
        bytes.set(data);
        count = data.length;
      }
      if (count !== file.size) throw new Error('모델 다운로드가 불완전합니다.');
      // Allow the parallel cache write to finish before potential GPU fallback.
      await cacheWrites.get(response);
      return bytes;
    } catch (error) {
      lastError = error;
      if (response) await cacheWrites.get(response);
      try { const cache = await caches.open(CACHE_NAME); await cache.delete(`${ROOT}/${path}`); } catch { /* optional cache */ }
      if (attempt < 2) {
        report(`${file.name} 다운로드를 다시 시도합니다 (${attempt + 2}/3)…`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw new Error(`${file.name} 모델 다운로드 실패: ${errorText(lastError)}. 네트워크/CORS 및 저장 공간을 확인하고 다시 시도해 주세요.`);
}

async function release(sessions: ort.InferenceSession[]) {
  await Promise.all(sessions.map(async (session) => { try { await session.release(); } catch { /* best effort */ } }));
}

async function loadEngine(backend: Backend): Promise<Engine> {
  report('Supertonic 3 모델을 준비합니다. 최초 다운로드는 약 380MB입니다.', 1);
  const [config, indexer] = await Promise.all([
    jsonFile<Config>('onnx/tts.json'),
    jsonFile<number[]>('onnx/unicode_indexer.json'),
  ]);
  const loaded: ort.InferenceSession[] = [];
  let preceding = 0;
  try {
    for (const file of MODEL_FILES) {
      const bytes = await modelBytes(file, preceding);
      report(`${backend === 'webgpu' ? 'GPU' : 'CPU'} 모델을 초기화합니다: ${file.name}`, 3 + 38 * (preceding + file.size) / TOTAL_MODEL_BYTES);
      loaded.push(await ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: 'all' }));
      preceding += file.size;
    }
    return { config, indexer, backend, sessions: { duration: loaded[0], encoder: loaded[1], vector: loaded[2], vocoder: loaded[3] } };
  } catch (error) {
    await release(loaded);
    throw error;
  }
}

async function getEngine(forceCpu = false): Promise<Engine> {
  if (engine && (!forceCpu || engine.backend === 'wasm')) return engine;
  if (engine) { await release(Object.values(engine.sessions)); engine = null; }
  const canTryGpu = !forceCpu && 'gpu' in navigator;
  if (canTryGpu) {
    try { engine = await loadEngine('webgpu'); return engine; }
    catch (error) { report(`GPU 초기화 실패. CPU로 다시 시도합니다: ${errorText(error)}`, 0); }
  }
  engine = await loadEngine('wasm');
  return engine;
}

async function voiceStyle(voice: string): Promise<Style> {
  const existing = styles.get(voice);
  if (existing) return existing;
  const file = await jsonFile<StyleFile>(`voice_styles/${voice}.json`);
  const tensor = (item: StyleFile['style_ttl']) => new ort.Tensor('float32', Float32Array.from(item.data.flat(Infinity) as number[]), item.dims);
  const style = { ttl: tensor(file.style_ttl), dp: tensor(file.style_dp) };
  styles.set(voice, style);
  return style;
}

function normalizeText(input: string, lang: TtsOptions['lang']): string {
  let text = input.normalize('NFKD');
  text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
  const replacements: Record<string, string> = { '–': '-', '‑': '-', '—': '-', '_': ' ', '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ' };
  for (const [from, to] of Object.entries(replacements)) text = text.replaceAll(from, to);
  text = text.replace(/[♥☆♡©\\]/g, '').replaceAll('@', ' at ').replaceAll('e.g.,', 'for example, ').replaceAll('i.e.,', 'that is, ');
  text = text.replace(/\s+([,.!?;:'])/g, '$1').replace(/"{2,}/g, '"').replace(/'{2,}/g, "'").replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!/[.!?;:,'"')\]}…。 」』】〉》›»]$/.test(text)) text += '.';
  return `<${lang}>${text}</${lang}>`;
}

/** Sentence/paragraph-aware chunks, with a hard cap even for unpunctuated text. */
function splitText(text: string, lang: TtsOptions['lang']): string[] {
  const limit = lang === 'ko' ? 120 : 240;
  const result: string[] = [];
  const paragraphs = text.trim().split(/\n\s*\n+/).filter(Boolean);
  const Segmenter = Intl.Segmenter;
  const segmenter = typeof Segmenter === 'function' ? new Segmenter(lang, { granularity: 'sentence' }) : null;
  for (const paragraph of paragraphs) {
    const sentences = segmenter
      ? Array.from(segmenter.segment(paragraph), (s) => s.segment.trim()).filter(Boolean)
      : paragraph.split(/(?<=[.!?。！？])\s+/).map((s) => s.trim()).filter(Boolean);
    let current = '';
    for (const sentence of sentences) {
      let rest = sentence;
      while (Array.from(rest).length > limit) {
        if (current) { result.push(current); current = ''; }
        const chars = Array.from(rest);
        const prefix = chars.slice(0, limit).join('');
        // Prefer a word/punctuation boundary, but never drop a long unbroken word.
        const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf(','), prefix.lastIndexOf('，'), prefix.lastIndexOf(';'));
        const count = boundary >= limit / 3 ? Array.from(prefix.slice(0, boundary + 1)).length : limit;
        result.push(chars.slice(0, count).join('').trim());
        rest = chars.slice(count).join('').trim();
      }
      if (!rest) continue;
      const candidate = current ? `${current} ${rest}` : rest;
      if (Array.from(candidate).length <= limit) current = candidate;
      else { if (current) result.push(current); current = rest; }
    }
    if (current) result.push(current);
  }
  return result.filter(Boolean);
}

async function synthesizeChunk(e: Engine, text: string, options: TtsOptions, style: Style, chunkIndex: number, chunkCount: number): Promise<Float32Array> {
  const processed = normalizeText(text, options.lang);
  const ids = Array.from(processed, (char) => BigInt(e.indexer[char.codePointAt(0)!] ?? -1));
  const length = ids.length;
  const textIds = new ort.Tensor('int64', BigInt64Array.from(ids), [1, length]);
  const textMask = new ort.Tensor('float32', new Float32Array(length).fill(1), [1, 1, length]);
  const durationOutput = await e.sessions.duration.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
  const seconds = Number(durationOutput.duration.data[0]) / options.speed;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 180) throw new Error('모델이 올바르지 않은 음성 길이를 반환했습니다. 텍스트를 나누어 다시 시도해 주세요.');
  const embedding = await e.sessions.encoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
  const { sample_rate: sampleRate, base_chunk_size: baseChunkSize } = e.config.ae;
  const { chunk_compress_factor: compress, latent_dim: latentDim } = e.config.ttl;
  const wavLength = Math.floor(seconds * sampleRate);
  const latentLength = Math.ceil(wavLength / (baseChunkSize * compress));
  const channels = latentDim * compress;
  let latent: Float32Array<ArrayBufferLike> = new Float32Array(channels * latentLength);
  for (let i = 0; i < latent.length; i++) {
    const u1 = Math.max(0.0001, Math.random());
    latent[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
  }
  const latentMask = new ort.Tensor('float32', new Float32Array(latentLength).fill(1), [1, 1, latentLength]);
  const totalStep = new ort.Tensor('float32', new Float32Array([STEPS]), [1]);
  for (let step = 0; step < STEPS; step++) {
    report(`음성 생성 중: ${chunkIndex + 1}/${chunkCount} 구간 (${step + 1}/${STEPS})`, 44 + 50 * (chunkIndex + step / STEPS) / chunkCount);
    const output = await e.sessions.vector.run({
      noisy_latent: new ort.Tensor('float32', latent, [1, channels, latentLength]),
      text_emb: embedding.text_emb,
      style_ttl: style.ttl,
      latent_mask: latentMask,
      text_mask: textMask,
      current_step: new ort.Tensor('float32', new Float32Array([step]), [1]),
      total_step: totalStep,
    });
    latent = output.denoised_latent.data as Float32Array;
  }
  const output = await e.sessions.vocoder.run({ latent: new ort.Tensor('float32', latent, [1, channels, latentLength]) });
  const wav = output.wav_tts.data as Float32Array;
  // The vocoder rounds each latent segment to a full frame. Trim EVERY segment,
  // before inserting pauses, otherwise accumulated padding truncates later speech.
  return wav.slice(0, Math.min(wavLength, wav.length));
}

function appendPcm(encoder: Mp3Encoder, parts: Uint8Array[], samples: Float32Array) {
  const blockSize = 1152;
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    const end = Math.min(samples.length, offset + blockSize);
    const pcm = new Int16Array(end - offset);
    for (let i = offset; i < end; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      pcm[i - offset] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    const encoded = encoder.encodeBuffer(pcm);
    if (encoded.length) parts.push(Uint8Array.from(encoded));
  }
}

async function render(e: Engine, options: TtsOptions, style: Style): Promise<{ blob: Blob; duration: number }> {
  const chunks = splitText(options.text, options.lang).filter(chunk => normalizeText(chunk, options.lang));
  if (!chunks.length) throw new Error('읽을 텍스트를 입력해 주세요.');
  const sampleRate = e.config.ae.sample_rate;
  const encoder = new Mp3Encoder(1, sampleRate, 128);
  const parts: Uint8Array[] = [];
  let sampleCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (i) {
      const silence = new Float32Array(Math.floor(sampleRate * SILENCE_SECONDS));
      appendPcm(encoder, parts, silence);
      sampleCount += silence.length;
    }
    const wav = await synthesizeChunk(e, chunks[i], options, style, i, chunks.length);
    appendPcm(encoder, parts, wav);
    sampleCount += wav.length;
  }
  report('MP3 파일을 마무리하고 있습니다…', 96);
  const tail = encoder.flush();
  if (tail.length) parts.push(Uint8Array.from(tail));
  if (!parts.length || !sampleCount) throw new Error('음성 인코딩에 실패했습니다. 다시 시도해 주세요.');
  // Copy to plain ArrayBuffers for BlobPart compatibility with TS 5.9.
  const blob = new Blob(parts.map((part) => part.buffer as ArrayBuffer), { type: 'audio/mpeg' });
  report('음성 생성이 완료되었습니다.', 100);
  return { blob, duration: sampleCount / sampleRate };
}

self.onmessage = async (event: MessageEvent<{ type: 'generate'; options: TtsOptions }>) => {
  if (event.data?.type !== 'generate') return;
  const options = event.data.options;
  try {
    if (!splitText(options.text, options.lang).some(chunk => normalizeText(chunk, options.lang))) {
      throw new Error('읽을 수 있는 텍스트가 없습니다.');
    }
    report('음성 엔진을 준비하고 있습니다…', 0);
    let active = await getEngine();
    const style = await voiceStyle(options.voice);
    let result: { blob: Blob; duration: number };
    try {
      result = await render(active, options, style);
    } catch (error) {
      if (active.backend !== 'webgpu') throw error;
      report(`GPU 추론 실패. CPU로 전체 구간을 다시 생성합니다: ${errorText(error)}`, 0);
      active = await getEngine(true);
      result = await render(active, options, style);
    }
    self.postMessage({ type: 'result', ...result });
  } catch (error) {
    self.postMessage({ type: 'error', message: `음성 생성에 실패했습니다: ${errorText(error)}` });
  }
};
