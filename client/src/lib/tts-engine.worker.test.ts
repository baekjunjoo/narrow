import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Run the production worker code in isolation with lightweight model doubles.
// No model downloads, network access, or GPU are required for these tests.
function workerHarness(options: { encoderFails?: boolean; noSegmenter?: boolean; validDigest?: boolean } = {}) {
  const messages: any[] = [];
  const self: any = { location: { href: 'https://example.test/' }, postMessage: (m: unknown) => messages.push(m) };
  class Tensor { constructor(public type: string, public data: unknown, public dims: number[]) {} }
  class Encoder {
    encodeBuffer() { if (options.encoderFails) throw new Error('MP3 encoding failed'); return new Uint8Array([1]); }
    flush() { return new Uint8Array([2]); }
  }
  const ort = { env: { wasm: {} }, Tensor, InferenceSession: { create: vi.fn() } };
  const file = new URL('./tts-engine.worker.ts', import.meta.url);
  let source = readFileSync(file, 'utf8').replace(/^import .*;\n/gm, '');
  source += '\nglobalThis.__test = { splitText, normalizeText, render, getEngine, loadEngine, modelBytes, setEngine: e => { engine = e }, setStyle: (v, s) => styles.set(v, s), setLoadEngine: f => { loadEngine = f }, setModelBytes: f => { modelBytes = f }, setJsonFile: f => { jsonFile = f } };';
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const intl = options.noSegmenter ? { ...Intl, Segmenter: undefined } : Intl;
  const cache = { match: vi.fn(async (_url: string): Promise<Response | undefined> => undefined), put: vi.fn(async (_url: string, _response: Response) => {}), delete: vi.fn(async () => true) };
  const digest = vi.fn(async () => options.validDigest ? Uint8Array.from(Buffer.from('c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db', 'hex')).buffer : new Uint8Array(32).buffer);
  const context = vm.createContext({ self, ort, Mp3Encoder: Encoder, wasmUrl: 'model.wasm', URL, Blob, Uint8Array, Float32Array, Int16Array, BigInt64Array, Math, Array, Intl: intl, Number, Error, AbortSignal, Response, setTimeout, navigator: {}, crypto: { subtle: { digest } }, caches: { open: async () => cache } });
  vm.runInContext(js, context, { filename: file.pathname });
  return { self, messages, api: context.__test, ort, Tensor, cache, digest, context };
}

const settings = { text: 'Hello.', lang: 'en', voice: 'F1', speed: 1 };
function mockEngine(backend: 'webgpu' | 'wasm', durationRun?: () => Promise<unknown>) {
  const release = vi.fn(async () => {});
  return {
    backend, config: { ae: { sample_rate: 24000, base_chunk_size: 120 }, ttl: { chunk_compress_factor: 2, latent_dim: 2 } }, indexer: [],
    sessions: {
      duration: { run: durationRun ?? (async () => ({ duration: { data: [0.02] } })), release },
      encoder: { run: async () => ({ text_emb: {} }), release },
      vector: { run: async (args: any) => ({ denoised_latent: args.noisy_latent }), release },
      vocoder: { run: async () => ({ wav_tts: { data: new Float32Array(480) } }), release },
    },
  };
}

async function runWithGpu(h: ReturnType<typeof workerHarness>, gpu: ReturnType<typeof mockEngine>) {
  h.api.setEngine(gpu); h.api.setStyle('F1', { dp: {}, ttl: {} });
  const load = vi.fn(async () => mockEngine('wasm'));
  h.api.setLoadEngine(load);
  await h.self.onmessage({ data: { type: 'generate', options: settings } });
  return load;
}

describe('TTS text splitting', () => {
  it.each([false, true])('keeps NFD Hangul and combining accents intact (no Segmenter: %s)', noSegmenter => {
    const { api } = workerHarness({ noSegmenter });
    for (const [lang, source] of [['ko', '가'.repeat(119) + '\u1100\u1161' + '나'], ['en', 'a'.repeat(239) + 'e\u0301' + 'b']]) {
      const chunks: string[] = api.splitText(source, lang);
      expect(chunks.join('')).toBe(source);
      expect(chunks.every(c => Array.from(c).length <= (lang === 'ko' ? 120 : 240))).toBe(true);
      expect(chunks.some(c => c.startsWith('\u1161') || c.startsWith('\u0301'))).toBe(false);
      expect(chunks.some(c => c.includes(lang === 'ko' ? '\u1100\u1161' : 'e\u0301'))).toBe(true);
    }
  });
  it.each([false, true])('preserves entire ZWJ emoji across the hard boundary (no Segmenter: %s)', noSegmenter => {
    const { api } = workerHarness({ noSegmenter });
    const source = 'a'.repeat(239) + '👩‍👩‍👧‍👦' + 'b';
    const chunks: string[] = api.splitText(source, 'en');
    expect(chunks.join('')).toBe(source);
    expect(chunks.some(c => c.includes('👩‍👩‍👧‍👦'))).toBe(true);
    expect(chunks.every(c => Array.from(c).length <= 240)).toBe(true);
  });
  it('rejects an over-limit indivisible grapheme rather than splitting it or exceeding the cap', () => {
    const { api } = workerHarness();
    expect(() => api.splitText('a' + '\u0301'.repeat(240), 'en')).toThrow();
  });
  it.each(['❤️', '👩‍👩‍👧‍👦', '🏳️‍🌈', '1️⃣', '™️', '🀄', '🃏', '🇰🇷', '\u200d\ufe0f'])('does not treat only emoji/format characters as speech: %s', text => {
    const { api } = workerHarness();
    expect(api.normalizeText(text, 'en')).toBe('');
  });
  it('still normalizes ordinary mixed Korean and English text', () => {
    const { api } = workerHarness();
    expect(api.normalizeText('안녕, hello!', 'ko')).toBe('<ko>안녕, hello!</ko>'.normalize('NFKD'));
    expect(api.normalizeText('ACME™', 'en')).toBe('<en>ACMETM.</en>');
  });
});

describe('TTS PCM cue timeline', () => {
  it('uses trimmed speech lengths and a 0.3-second pause for each new chunk', async () => {
    const h = workerHarness();
    const result = await h.api.render(mockEngine('wasm'), { ...settings, text: 'A. '.repeat(85) + 'B' }, { dp: {}, ttl: {} });
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]).toMatchObject({ start: 0, duration: 0.02 });
    expect(result.cues[1]).toMatchObject({ start: 0.32, duration: 0.02 });
    expect(result.duration).toBeCloseTo(0.34);
    expect(result.blob.type).toBe('audio/mpeg');
  });
});

describe('TTS GPU fallback boundaries', () => {
  it('does not replace the GPU engine when model output length is invalid', async () => {
    const h = workerHarness();
    const gpu = mockEngine('webgpu', async () => ({ duration: { data: [181] } }));
    const load = await runWithGpu(h, gpu);
    expect(load).not.toHaveBeenCalled();
    expect(h.messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('음성 길이') });
    expect(gpu.sessions.duration.release).not.toHaveBeenCalled();
  });
  it('does not initialize CPU when MP3 encoding fails', async () => {
    const h = workerHarness({ encoderFails: true });
    const load = await runWithGpu(h, mockEngine('webgpu'));
    expect(load).not.toHaveBeenCalled();
    expect(h.messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('MP3 encoding failed') });
  });
  it('does not retry CPU for runtime input dimension errors', async () => {
    const h = workerHarness();
    const load = await runWithGpu(h, mockEngine('webgpu', async () => { throw new Error('Got invalid dimensions for input text_ids'); }));
    expect(load).not.toHaveBeenCalled();
    expect(h.messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('invalid dimensions') });
  });
  it('does not mistake a GPU-labelled input error for a GPU failure', async () => {
    const h = workerHarness();
    const load = await runWithGpu(h, mockEngine('webgpu', async () => { throw new Error('WebGPU: invalid input dimensions'); }));
    expect(load).not.toHaveBeenCalled();
    expect(h.messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('invalid input') });
  });
  it('retries the whole request on CPU when the GPU device is lost', async () => {
    const h = workerHarness();
    const gpu = mockEngine('webgpu', async () => { throw new Error('WebGPU device lost'); });
    const load = await runWithGpu(h, gpu);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith('wasm');
    expect(gpu.sessions.duration.release).toHaveBeenCalled();
    expect(h.messages.some(m => m.type === 'progress' && m.message.includes('GPU 추론 실패'))).toBe(true);
    expect(h.messages.at(-1)).toMatchObject({ type: 'result' });
  });
  it('retries on CPU for GPU memory exhaustion', async () => {
    const h = workerHarness();
    const load = await runWithGpu(h, mockEngine('webgpu', async () => { throw new Error('WebGPU out of memory'); }));
    expect(load).toHaveBeenCalledWith('wasm');
    expect(h.messages.at(-1)).toMatchObject({ type: 'result' });
  });
});

describe('TTS model cache recovery', () => {
  it('does not attempt CPU initialization for a model download failure', async () => {
    const h = workerHarness(); h.context.navigator.gpu = {};
    h.api.setJsonFile(async () => ({}));
    const bytes = vi.fn(async () => { throw new Error('model download failed'); }); h.api.setModelBytes(bytes);
    await expect(h.api.getEngine()).rejects.toThrow('model download failed');
    expect(bytes).toHaveBeenCalledOnce();
    expect(h.ort.InferenceSession.create).not.toHaveBeenCalled();
    expect(h.messages.some(m => m.message?.includes('CPU로 다시 시도'))).toBe(false);
  });
  it('still initializes CPU after a GPU session creation failure', async () => {
    const h = workerHarness(); h.context.navigator.gpu = {};
    h.api.setJsonFile(async () => ({})); h.api.setModelBytes(async () => new Uint8Array(4));
    h.ort.InferenceSession.create.mockRejectedValueOnce(new Error('GPU backend unsupported'))
      .mockResolvedValue({ release: async () => {} });
    await expect(h.api.getEngine()).resolves.toMatchObject({ backend: 'wasm' });
    expect(h.ort.InferenceSession.create).toHaveBeenCalledTimes(5);
    expect(h.messages.some(m => m.message?.includes('CPU로 다시 시도'))).toBe(true);
  });
  it('evicts a digest-confirmed corrupt model and requests fresh bytes once', async () => {
    const h = workerHarness();
    h.api.setJsonFile(async () => ({}));
    const bytes = vi.fn(async (_file: unknown, _preceding: number, _bypass?: boolean) => new Uint8Array(4)); h.api.setModelBytes(bytes);
    h.ort.InferenceSession.create.mockRejectedValueOnce(new Error('Failed to load model because protobuf parsing failed'))
      .mockResolvedValue({ release: async () => {} });
    await expect(h.api.loadEngine('wasm')).resolves.toMatchObject({ backend: 'wasm' });
    expect(h.cache.delete).toHaveBeenCalledOnce();
    expect(bytes.mock.calls[1][2]).toBe(true);
    expect(h.digest).toHaveBeenCalledOnce();
  });
  it('does not evict a digest-valid model after a parse failure', async () => {
    const h = workerHarness({ validDigest: true });
    h.api.setJsonFile(async () => ({})); h.api.setModelBytes(async () => new Uint8Array(4));
    h.ort.InferenceSession.create.mockRejectedValue(new Error('protobuf parsing failed'));
    await expect(h.api.loadEngine('wasm')).rejects.toThrow('protobuf parsing');
    expect(h.cache.delete).not.toHaveBeenCalled();
    expect(h.digest).toHaveBeenCalledOnce();
  });
  it('keeps the cache when SHA-256 is unavailable and does not try CPU', async () => {
    const h = workerHarness(); h.context.navigator.gpu = {}; h.context.crypto = undefined;
    h.api.setJsonFile(async () => ({})); h.api.setModelBytes(async () => new Uint8Array(4));
    h.ort.InferenceSession.create.mockRejectedValue(new Error('protobuf parsing failed'));
    await expect(h.api.getEngine()).rejects.toThrow('protobuf parsing');
    expect(h.cache.delete).not.toHaveBeenCalled();
    expect(h.ort.InferenceSession.create).toHaveBeenCalledOnce();
  });
  it('does not retry corrupt replacement bytes indefinitely', async () => {
    const h = workerHarness();
    h.api.setJsonFile(async () => ({}));
    const bytes = vi.fn(async () => new Uint8Array(4)); h.api.setModelBytes(bytes);
    h.ort.InferenceSession.create.mockRejectedValue(new Error('protobuf parsing failed'));
    await expect(h.api.loadEngine('wasm')).rejects.toThrow('protobuf parsing');
    expect(bytes).toHaveBeenCalledTimes(2);
    expect(h.cache.delete).toHaveBeenCalledTimes(2);
  });
  it('does not hash or evict a model when the GPU runs out of memory', async () => {
    const h = workerHarness();
    h.api.setJsonFile(async () => ({})); h.api.setModelBytes(async () => new Uint8Array(4));
    h.ort.InferenceSession.create.mockRejectedValue(new Error('WebGPU out of memory'));
    await expect(h.api.loadEngine('webgpu')).rejects.toThrow('out of memory');
    expect(h.cache.delete).not.toHaveBeenCalled();
    expect(h.digest).not.toHaveBeenCalled();
  });
  it('uses the real hash and bypasses Cache Storage and HTTP cache after a same-size corrupt hit', async () => {
    const h = workerHarness();
    h.context.crypto = webcrypto;
    const stored = new Uint8Array(3_700_147); // Correct length, incorrect content.
    const fresh = new Uint8Array(stored.length); fresh[0] = 42;
    h.cache.match.mockResolvedValue(new Response(stored));
    h.context.fetch = vi.fn(async () => new Response(fresh));
    h.api.setJsonFile(async () => ({}));
    const original = h.api.modelBytes;
    h.api.setModelBytes(async (file: { name: string }, preceding: number, bypass: boolean) =>
      file.name === 'duration_predictor' ? original(file, preceding, bypass) : new Uint8Array(4));
    h.ort.InferenceSession.create.mockRejectedValueOnce(new Error('protobuf parsing failed'))
      .mockResolvedValue({ release: async () => {} });
    await expect(h.api.loadEngine('wasm')).resolves.toMatchObject({ backend: 'wasm' });
    expect(h.cache.match).toHaveBeenCalledOnce();
    expect(h.cache.delete).toHaveBeenCalledOnce();
    expect(h.context.fetch).toHaveBeenCalledOnce();
    expect(h.context.fetch.mock.calls[0][1]).toMatchObject({ cache: 'reload', credentials: 'omit' });
    expect(h.ort.InferenceSession.create.mock.calls[1][0][0]).toBe(42);
  });
});
