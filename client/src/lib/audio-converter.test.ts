import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AudioConverter } from './audio-converter';
import { checkFloatFrame, ChunkWriter, FlacIntegrity, inspectWav, mp3DeclaredLength, mp3LengthStatus, parseMp3Length, StreamingMd5 } from './audio-converter.worker';
import type LibAVTypes from '@libav.js/variant-obsolete';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

const file = () => new File(['audio'], 'recording.not-an-extension');
const result = () => ({ blob: new Blob(['result'], { type: 'audio/flac' }), warnings: [], inputChannels: 2, outputChannels: 2, inputSampleRate: 44100, outputSampleRate: 44100 });

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('window', { location: { href: 'https://example.test/app/' } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('AudioConverter', () => {
  it('passes the subpath LibAV directory to the worker', async () => {
    vi.stubEnv('BASE_URL', '/narrow/');
    const converter = new AudioConverter();
    const pending = converter.convert(file(), 'wav', vi.fn());
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ assetBase: 'https://example.test/narrow/libav/' }));
    worker.emit({ type: 'success', result: result() });
    await pending; converter.dispose();
  });

  it('keeps progress separate from a successful result and passes the File intact', async () => {
    const converter = new AudioConverter();
    const report = vi.fn();
    const original = file();
    const pending = converter.convert(original, 'flac', report);
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'convert', file: original, format: 'flac', assetBase: expect.stringMatching(/^https:\/\/example\.test\//) }));
    worker.emit({ type: 'progress', message: '변환 중' });
    expect(report).toHaveBeenCalledWith('변환 중');
    const output = result();
    worker.emit({ type: 'success', result: output });
    await expect(pending).resolves.toEqual(output);
    expect(report).toHaveBeenCalledTimes(1);
    converter.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('reports worker errors as rejected promises without success progress', async () => {
    const converter = new AudioConverter();
    const report = vi.fn();
    const pending = converter.convert(file(), 'wav', report);
    FakeWorker.instances[0].emit({ type: 'error', message: '지원하지 않는 오디오입니다.' });
    await expect(pending).rejects.toThrow('지원하지 않는 오디오입니다.');
    expect(report).not.toHaveBeenCalled();
    converter.dispose();
  });

  it('rejects overlapping requests but accepts another after completion', async () => {
    const converter = new AudioConverter();
    const first = converter.convert(file(), 'mp3', vi.fn());
    await expect(converter.convert(file(), 'wav', vi.fn())).rejects.toThrow('변환 중');
    FakeWorker.instances[0].emit({ type: 'success', result: result() });
    await first;
    const second = converter.convert(file(), 'wav', vi.fn());
    FakeWorker.instances[0].emit({ type: 'error', message: '손상된 파일' });
    await expect(second).rejects.toThrow('손상된 파일');
    converter.dispose();
  });

  it('permanently terminates the worker and rejects an active conversion on dispose', async () => {
    const converter = new AudioConverter();
    const pending = converter.convert(file(), 'mp3', vi.fn());
    const worker = FakeWorker.instances[0];
    converter.dispose();
    await expect(pending).rejects.toThrow('취소');
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(converter.convert(file(), 'mp3', vi.fn())).rejects.toThrow('종료');
    converter.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects empty files without starting a worker', async () => {
    const converter = new AudioConverter();
    await expect(converter.convert(new File([], 'empty.wav'), 'wav', vi.fn())).rejects.toThrow('비어');
    expect(FakeWorker.instances).toHaveLength(0);
    converter.dispose();
  });

  it('recovers from a worker crash with a Korean error', async () => {
    const converter = new AudioConverter();
    const pending = converter.convert(file(), 'wav', vi.fn());
    FakeWorker.instances[0].onerror?.();
    await expect(pending).rejects.toThrow('변환 중 오류');
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    const next = converter.convert(file(), 'wav', vi.fn());
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].emit({ type: 'success', result: result() });
    await next;
    converter.dispose();
  });
});

/** Two valid MP3 frames, the first with a realistic Xing/Info/VBRI header. */
function mp3Header(marker: 'Xing' | 'Info' | 'VBRI' | 'none', version: 1 | 2 | 2.5 = 1, mono = false, crc = false): Uint8Array {
  const mpeg1 = version === 1;
  const sampleRate = mpeg1 ? 44100 : version === 2 ? 22050 : 11025;
  const bitrate = mpeg1 ? 128000 : 64000;
  const frameSize = Math.floor((mpeg1 ? 144 : 72) * bitrate / sampleRate);
  const b = new Uint8Array(frameSize * 2);
  const h = [0xff, (mpeg1 ? 0xfb : version === 2 ? 0xf3 : 0xe3) - (crc ? 1 : 0), mpeg1 ? 0x90 : 0x80, mono ? 0xc0 : 0x00];
  b.set(h, 0); b.set(h, frameSize);
  const v = new DataView(b.buffer);
  if (marker === 'VBRI') {
    b.set(new TextEncoder().encode(marker), 36);
    v.setUint16(40, 1); v.setUint32(46, frameSize * 100); v.setUint32(50, 100);
  } else if (marker !== 'none') {
    const side = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const pos = 4 + side + (crc ? 2 : 0);
    b.set(new TextEncoder().encode(marker), pos);
    v.setUint32(pos + 4, 3); v.setUint32(pos + 8, 100); v.setUint32(pos + 12, frameSize * 100);
  }
  return b;
}

/** A physically complete synthetic stream, not just two frames with a 100-frame declaration. */
function completeMp3(marker: 'Xing' | 'VBRI'): Uint8Array {
  const first = mp3Header(marker);
  const frameSize = first.length / 2;
  const audio = new Uint8Array(frameSize * 100);
  audio.set(first);
  for (let i = 2; i < 100; i++) audio.set(first.subarray(0, 4), i * frameSize);
  return audio;
}

describe('MP3 declared length validation', () => {
  it('does not claim a greatly excessive decoded length is within tolerance', () => {
    const length = { samples: 100 * 1152, sampleRate: 44100, samplesPerFrame: 1152 };
    expect(mp3LengthStatus(length, length.samples + 100 * 1152, 44100)).toBe('unknown');
  });

  it('detects an incomplete Xing byte count even when decoded samples are close enough', async () => {
    const audio = mp3Header('Xing');
    const blob = new Blob([new Uint8Array(audio)]);
    const declaration = await mp3DeclaredLength(blob);
    expect(mp3LengthStatus(declaration, 100 * 1152, 44100)).toBe('short');
  });

  it('counts Xing bytes from the first audio frame after ID3, not from the start of the file', async () => {
    const audio = mp3Header('Xing');
    new DataView(audio.buffer).setUint32(48, audio.length);
    const tag = new Uint8Array(1010);
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 7, 104]); // 1000-byte tag
    const valid = new Blob([tag, new Uint8Array(audio)]);
    const cut = new Blob([tag, new Uint8Array(audio.slice(0, -1))]);
    expect(mp3LengthStatus(await mp3DeclaredLength(valid), 115200, 44100)).toBe('ok');
    expect(mp3LengthStatus(await mp3DeclaredLength(cut), 115200, 44100)).toBe('short');
  });

  it('checks a physically complete VBRI stream and detects a whole missing frame despite sample tolerance', async () => {
    const audio = completeMp3('VBRI');
    const frameSize = audio.length / 100;
    const full = await mp3DeclaredLength(new Blob([new Uint8Array(audio)]));
    const cut = await mp3DeclaredLength(new Blob([audio.slice(0, -frameSize)]));
    expect(full).toEqual({ samples: 115200, sampleRate: 44100, samplesPerFrame: 1152 });
    expect(mp3LengthStatus(full, 115200, 44100)).toBe('ok');
    expect(cut?.truncatedBytes).toBe(true);
    expect(mp3LengthStatus(cut, 99 * 1152, 44100)).toBe('short');
  });

  it('measures VBRI bytes from the first frame after an ID3 tag and leading junk', async () => {
    const audio = completeMp3('VBRI');
    const tag = new Uint8Array(1010);
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 7, 104]);
    const junk = new Uint8Array(13);
    const full = new Blob([tag, junk, new Uint8Array(audio)]);
    const cut = new Blob([tag, junk, audio.slice(0, -(audio.length / 100))]);
    expect(mp3LengthStatus(await mp3DeclaredLength(full), 115200, 44100)).toBe('ok');
    expect(mp3LengthStatus(await mp3DeclaredLength(cut), 99 * 1152, 44100)).toBe('short');
  });

  it('rejects malformed VBRI count and byte fields instead of treating them as declarations', () => {
    const tooSmall = completeMp3('VBRI');
    new DataView(tooSmall.buffer).setUint32(46, tooSmall.length / 100 - 1);
    expect(parseMp3Length(tooSmall)).toBeNull();
    const zeroFrames = completeMp3('VBRI');
    new DataView(zeroFrames.buffer).setUint32(50, 0);
    expect(parseMp3Length(zeroFrames)).toBeNull();
    const wrongVersion = completeMp3('VBRI');
    new DataView(wrongVersion.buffer).setUint16(40, 2);
    expect(parseMp3Length(wrongVersion)).toBeNull();
  });

  it('does not read VBRI frame-count bytes across the first-frame boundary', () => {
    const b = new Uint8Array(104);
    b.set([0xff, 0xe3, 0x10, 0], 0); // MPEG 2.5: 52-byte frames
    b.set(new TextEncoder().encode('VBRI'), 36);
    const v = new DataView(b.buffer);
    v.setUint16(40, 1); v.setUint32(46, 104); v.setUint32(50, 2);
    expect(parseMp3Length(b)).toBeNull();
  });

  it('accepts a complete ID3-tagged Xing stream with a LAME gapless declaration', async () => {
    const audio = completeMp3('Xing');
    const encoder = 36 + 16;
    audio.set(new TextEncoder().encode('LAME3.100'), encoder);
    audio.set([0x24, 0x05, 0x40], encoder + 21);
    const tag = new Uint8Array(1010);
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 7, 104]);
    const declaration = await mp3DeclaredLength(new Blob([tag, new Uint8Array(audio)]));
    expect(declaration).toEqual({ samples: 115200, sampleRate: 44100, samplesPerFrame: 1152, gaplessSamples: 1920 });
    expect(mp3LengthStatus(declaration, 115200 - 1920, 44100)).toBe('ok');
    // A one-byte disagreement is rejected as inconsistent metadata, not proof of audible loss.
    const cut = await mp3DeclaredLength(new Blob([tag, audio.slice(0, -1)]));
    expect(mp3LengthStatus(cut, 115200 - 1920, 44100)).toBe('short');
  });

  it.each([
    ['Info', 1, false, false, 44100, 1152],
    ['Xing', 1, true, true, 44100, 1152],
    ['Xing', 2, false, false, 22050, 576],
    ['Info', 2.5, true, false, 11025, 576],
    ['VBRI', 1, false, false, 44100, 1152],
  ] as const)('parses %s for MPEG %s, mono=%s, CRC=%s', (marker, version, mono, crc, rate, perFrame) => {
    expect(parseMp3Length(mp3Header(marker, version, mono, crc))).toEqual({ samples: 100 * perFrame, sampleRate: rate, samplesPerFrame: perFrame });
  });

  it('does not invent a length without a valid declaration and frame count', () => {
    expect(parseMp3Length(mp3Header('none'))).toBeNull();
    const noCount = mp3Header('Xing');
    new DataView(noCount.buffer).setUint32(40, 2); // flags: bytes only
    expect(parseMp3Length(noCount)).toBeNull();
    const zeroCount = mp3Header('Info');
    new DataView(zeroCount.buffer).setUint32(44, 0);
    expect(parseMp3Length(zeroCount)).toBeNull();
    const malformed = mp3Header('Info'); malformed[1] = 0xff; // reserved MPEG version
    expect(parseMp3Length(malformed)).toBeNull();
    const truncated = mp3Header('Xing').slice(0, 50);
    expect(parseMp3Length(truncated)).toBeNull();
  });

  it('keeps the first frame declaration even if the following frame is damaged', () => {
    const audio = mp3Header('Xing');
    const secondFrame = Math.floor(audio.length / 2);
    audio[secondFrame] = 0;
    expect(parseMp3Length(audio)).toEqual({ samples: 115200, sampleRate: 44100, samplesPerFrame: 1152 });
  });

  it('uses a recognized LAME-compatible delay and padding declaration', () => {
    const audio = mp3Header('Xing');
    const encoder = 36 + 16; // MPEG-1 stereo, Xing flags specify count and bytes
    audio.set(new TextEncoder().encode('LAME3.100'), encoder);
    audio.set([0x24, 0x05, 0x40], encoder + 21); // 576 delay + 1344 padding
    expect(parseMp3Length(audio)).toEqual({ samples: 115200, sampleRate: 44100, samplesPerFrame: 1152, gaplessSamples: 1920 });
    expect(mp3LengthStatus({ samples: 44 * 576, sampleRate: 8000, samplesPerFrame: 576, gaplessSamples: 1344 }, 12000, 8000)).toBe('short');
  });

  it('allows reasonable delay and padding but rejects severe decoded loss', () => {
    const length = { samples: 335 * 1152, sampleRate: 48000, samplesPerFrame: 1152 };
    expect(mp3LengthStatus(length, 384000, 48000)).toBe('ok');
    expect(mp3LengthStatus(length, Math.floor(3.985 * 48000), 48000)).toBe('short');
    expect(mp3LengthStatus(length, length.samples - (8190 + 2304), 48000)).toBe('ok');
    expect(mp3LengthStatus(length, length.samples - (8190 + 2304) - 1, 48000)).toBe('short');
    expect(mp3LengthStatus(length, length.samples + 2304, 48000)).toBe('ok');
    expect(mp3LengthStatus(length, length.samples + 2305, 48000)).toBe('unknown');
    expect(mp3LengthStatus(null, 100000, 48000)).toBe('unknown');
    expect(mp3LengthStatus(length, 384000, 44100)).toBe('unknown');
    expect(mp3LengthStatus({ ...length, samples: 2 * 1152 }, 1000, 48000)).toBe('unknown');
  });

  it('jumps over a large ID3 tag using bounded slices, not an entire-file read', async () => {
    const tagSize = 2 * 1024 * 1024;
    const tag = new Uint8Array(10);
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, (tagSize >> 21) & 127, (tagSize >> 14) & 127, (tagSize >> 7) & 127, tagSize & 127]);
    const audio = mp3Header('Xing');
    const slice = vi.fn((start: number, _end: number) => new Blob([new Uint8Array(start === 0 ? tag : audio)]));
    const fake = { size: tagSize + 10 + 200 * 1024 * 1024, slice } as unknown as File;
    expect(await mp3DeclaredLength(fake)).toEqual({ samples: 115200, sampleRate: 44100, samplesPerFrame: 1152 });
    expect(slice).toHaveBeenNthCalledWith(1, 0, 10);
    expect(slice).toHaveBeenNthCalledWith(2, tagSize + 10, tagSize + 10 + 64 * 1024 + 1500);
  });
});

/** A minimal PCM RIFF or RF64 container, with optionally dishonest chunk sizes. */
function wavFixture(rf64: boolean, options: { dataDeclared?: number; dataActual?: number; riffDeclared?: number; align?: number; sampleCount?: bigint; formatTag?: number } = {}): Blob {
  const actual = options.dataActual ?? 8;
  const prefix = rf64 ? 80 : 44;
  const b = new Uint8Array(prefix + actual);
  const v = new DataView(b.buffer);
  const text = (at: number, value: string) => b.set(new TextEncoder().encode(value), at);
  text(0, rf64 ? 'RF64' : 'RIFF'); v.setUint32(4, rf64 ? 0xffffffff : options.riffDeclared ?? b.length - 8, true); text(8, 'WAVE');
  let at = 12;
  if (rf64) {
    text(at, 'ds64'); v.setUint32(at + 4, 28, true);
    v.setBigUint64(at + 8, BigInt(options.riffDeclared ?? b.length - 8), true);
    v.setBigUint64(at + 16, BigInt(options.dataDeclared ?? actual), true);
    v.setBigUint64(at + 24, options.sampleCount ?? 0n, true); at += 36;
  }
  text(at, 'fmt '); v.setUint32(at + 4, 16, true); v.setUint16(at + 8, options.formatTag ?? 1, true);
  v.setUint16(at + 10, 2, true); v.setUint32(at + 12, 44100, true);
  v.setUint32(at + 16, 176400, true); v.setUint16(at + 20, options.align ?? 4, true); v.setUint16(at + 22, 16, true); at += 24;
  text(at, 'data'); v.setUint32(at + 4, rf64 ? 0xffffffff : options.dataDeclared ?? actual, true);
  return new Blob([b]);
}

/** Mono IMA ADPCM: an 8-byte block contains nine samples, not eight PCM frames. */
function rf64Adpcm(sampleCount: bigint): Blob {
  const b = new Uint8Array(104);
  const v = new DataView(b.buffer);
  const text = (at: number, value: string) => b.set(new TextEncoder().encode(value), at);
  text(0, 'RF64'); v.setUint32(4, 0xffffffff, true); text(8, 'WAVE');
  text(12, 'ds64'); v.setUint32(16, 28, true);
  v.setBigUint64(20, BigInt(b.length - 8), true); v.setBigUint64(28, 8n, true); v.setBigUint64(36, sampleCount, true);
  text(48, 'fmt '); v.setUint32(52, 20, true); v.setUint16(56, 0x11, true);
  v.setUint16(58, 1, true); v.setUint32(60, 8000, true); v.setUint32(64, 7111, true);
  v.setUint16(68, 8, true); v.setUint16(70, 4, true); v.setUint16(72, 2, true); v.setUint16(74, 9, true);
  text(76, 'fact'); v.setUint32(80, 4, true); v.setUint32(84, 9, true);
  text(88, 'data'); v.setUint32(92, 0xffffffff, true);
  return new Blob([b]);
}

describe('WAV container integrity', () => {
  it.each([false, true])('accepts complete PCM (RF64=%s)', async rf64 => {
    await expect(inspectWav(wavFixture(rf64))).resolves.toEqual({ samples: 2, warnings: [] });
  });

  it('accepts matching or unknown-zero RF64 ds64 sample counts for PCM', async () => {
    await expect(inspectWav(wavFixture(true, { sampleCount: 2n }))).resolves.toEqual({ samples: 2, warnings: [] });
    await expect(inspectWav(wavFixture(true, { sampleCount: 0n }))).resolves.toEqual({ samples: 2, warnings: [] });
  });

  it.each([1n, 3n])('rejects a contradictory RF64 ds64 sample count %s for complete PCM', async sampleCount => {
    await expect(inspectWav(wavFixture(true, { sampleCount }))).rejects.toThrow('손상');
  });

  it('compares ds64 for uncompressed float and WAVE_FORMAT_EXTENSIBLE PCM', async () => {
    const float = new Uint8Array(await wavFixture(true, { sampleCount: 1n, formatTag: 3, align: 8 }).arrayBuffer());
    new DataView(float.buffer).setUint16(70, 32, true);
    await expect(inspectWav(new Blob([float]))).resolves.toEqual({ samples: 1, warnings: [] });
    new DataView(float.buffer).setBigUint64(36, 2n, true);
    await expect(inspectWav(new Blob([float]))).rejects.toThrow('손상');

    const original = new Uint8Array(await wavFixture(true, { sampleCount: 2n }).arrayBuffer());
    const ext = new Uint8Array(original.length + 24);
    ext.set(original.subarray(0, 72)); ext.set(original.subarray(72), 96);
    const v = new DataView(ext.buffer);
    v.setBigUint64(20, BigInt(ext.length - 8), true); v.setUint32(52, 40, true); v.setUint16(56, 0xfffe, true);
    v.setUint16(72, 22, true); v.setUint16(74, 16, true); v.setUint32(76, 3, true);
    ext.set([1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 80);
    await expect(inspectWav(new Blob([ext]))).resolves.toEqual({ samples: 2, warnings: [] });
    v.setBigUint64(36, 3n, true);
    await expect(inspectWav(new Blob([ext]))).rejects.toThrow('손상');
  });

  it('does not compare RF64 sample counts for legal non-PCM ADPCM data', async () => {
    const result = await inspectWav(rf64Adpcm(9n));
    expect(result.samples).toBeNull();
    expect(result.warnings.join(' ')).toContain('ds64');
    expect(result.warnings.join(' ')).toContain('확인할 수 없');
    const unknown = await inspectWav(rf64Adpcm(0n));
    expect(unknown.samples).toBeNull();
    expect(unknown.warnings.join(' ')).toContain('검증이 제한');
  });

  it('compares a safe integer RF64 sample count at the upper boundary', async () => {
    await expect(inspectWav(wavFixture(true, { sampleCount: BigInt(Number.MAX_SAFE_INTEGER) }))).rejects.toThrow('손상');
  });

  it('warns rather than rejecting a ds64 count beyond the safe integer range', async () => {
    const result = await inspectWav(wavFixture(true, { sampleCount: BigInt(Number.MAX_SAFE_INTEGER) + 1n }));
    expect(result.samples).toBe(2);
    expect(result.warnings.join(' ')).toContain('ds64');
    expect(result.warnings.join(' ')).toContain('확인할 수 없');
  });

  it('warns rather than comparing when multiple RF64 data chunks are present', async () => {
    const original = new Uint8Array(await wavFixture(true, { sampleCount: 200n }).arrayBuffer());
    const b = new Uint8Array(original.length + 12);
    b.set(original); b.set(new TextEncoder().encode('data'), original.length);
    const v = new DataView(b.buffer);
    v.setUint32(original.length + 4, 4, true);
    v.setBigUint64(20, BigInt(b.length - 8), true);
    const result = await inspectWav(new Blob([b]));
    expect(result.samples).toBeNull();
    expect(result.warnings.join(' ')).toContain('ds64');
  });

  it('warns rather than comparing RF64 ds64 when PCM format fields make alignment ambiguous', async () => {
    const result = await inspectWav(wavFixture(true, { sampleCount: 20n, align: 2 }));
    expect(result.samples).toBeNull();
    expect(result.warnings.join(' ')).toContain('ds64');
  });

  it('warns rather than comparing RF64 ds64 after an incomplete chunk scan', async () => {
    const original = new Uint8Array(await wavFixture(true, { sampleCount: 20n }).arrayBuffer());
    const b = new Uint8Array(original.length + 4097 * 8);
    b.set(original);
    for (let i = 0; i < 4097; i++) b.set(new TextEncoder().encode('JUNK'), original.length + i * 8);
    new DataView(b.buffer).setBigUint64(20, BigInt(b.length - 8), true);
    const result = await inspectWav(new Blob([b]));
    expect(result.samples).toBeNull();
    expect(result.warnings.join(' ')).toContain('ds64');
  });

  it('warns rather than comparing RF64 ds64 when multiple fmt chunks make the layout ambiguous', async () => {
    const original = new Uint8Array(await wavFixture(true, { sampleCount: 20n }).arrayBuffer());
    const b = new Uint8Array(original.length + 24);
    b.set(original); b.set(original.subarray(48, 72), original.length);
    new DataView(b.buffer).setBigUint64(20, BigInt(b.length - 8), true);
    const result = await inspectWav(new Blob([b]));
    expect(result.samples).toBeNull();
    expect(result.warnings.join(' ')).toContain('ds64');
  });

  it.each([false, true])('rejects data extending beyond the physical file (RF64=%s)', async rf64 => {
    await expect(inspectWav(wavFixture(rf64, { dataDeclared: 16 }))).rejects.toThrow();
  });

  it.each([false, true])('rejects incomplete sample frames (RF64=%s)', async rf64 => {
    await expect(inspectWav(wavFixture(rf64, { dataDeclared: 6, dataActual: 6 }))).rejects.toThrow();
  });

  it.each([false, true])('rejects zero PCM block alignment (RF64=%s)', async rf64 => {
    await expect(inspectWav(wavFixture(rf64, { align: 0 }))).rejects.toThrow();
  });

  it('accepts a final unpadded odd byte for an aligned 8-bit PCM file', async () => {
    const wav = new Uint8Array(await wavFixture(false, { dataDeclared: 3, dataActual: 3, align: 1 }).arrayBuffer());
    const v = new DataView(wav.buffer); v.setUint16(22, 1, true); v.setUint16(34, 8, true);
    await expect(inspectWav(new Blob([wav]))).resolves.toEqual({ samples: 3, warnings: [] });
  });

  it('limits many unknown chunks and explicitly warns when the scan is incomplete', async () => {
    const chunks = 4097;
    const b = new Uint8Array(12 + chunks * 8); const v = new DataView(b.buffer);
    b.set(new TextEncoder().encode('RIFF'), 0); v.setUint32(4, b.length - 8, true); b.set(new TextEncoder().encode('WAVE'), 8);
    for (let i = 0; i < chunks; i++) b.set(new TextEncoder().encode('JUNK'), 12 + i * 8);
    const inspected = await inspectWav(new Blob([b]));
    expect(inspected.samples).toBeNull(); expect(inspected.warnings.join(' ')).toContain('검증이 제한');
  });
});

describe('streaming FLAC integrity', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 1000, 65537])('matches an independent MD5 for %i bytes in irregular chunks', size => {
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 71 + 11) & 255);
    const md5 = new StreamingMd5();
    for (let i = 0; i < size; i += 37) md5.update(data.subarray(i, i + 37));
    expect(Buffer.from(md5.digest()).toString('hex')).toBe(createHash('md5').update(data).digest('hex'));
  });

  it('hashes signed 20-bit samples in channel-interleaved, sign-extended little endian order', () => {
    const expected = createHash('md5').update(Buffer.from([0xff, 0xff, 0xff, 1, 0, 0, 0, 0, 0xf8, 0xff, 0xff, 0x07])).digest();
    const formats = { s16: 1, s16p: 6, s32: 2, s32p: 7 };
    const checker = new FlacIntegrity(20, 2, expected, formats);
    checker.add({ format: 7, nb_samples: 2, data: [new Int32Array([-4096, -2147483648]), new Int32Array([4096, 2147479552])] } as LibAVTypes.Frame);
    expect(checker.result()).toBe('verified');
    const corrupt = new FlacIntegrity(20, 2, expected, formats);
    corrupt.add({ format: 7, nb_samples: 2, data: [new Int32Array([0, -2147483648]), new Int32Array([4096, 2147479552])] } as LibAVTypes.Frame);
    expect(corrupt.result()).toBe('mismatch');
  });

  it('reports unavailable rather than a false mismatch for missing MD5 or an unknown decoded layout', () => {
    const formats = { s16: 1, s16p: 6, s32: 2, s32p: 7 };
    expect(new FlacIntegrity(16, 1, new Uint8Array(16), formats).result()).toBe('unavailable');
    const unknown = new FlacIntegrity(16, 1, new Uint8Array(16).fill(1), formats);
    unknown.add({ format: 100, nb_samples: 1, data: new Float32Array([0]) } as LibAVTypes.Frame);
    expect(unknown.result()).toBe('unavailable');
  });

  it.each([8, 12, 16, 20, 24, 32])('matches independent signed PCM serialization at %i bits', bits => {
    const formats = { s16: 1, s16p: 6, s32: 2, s32p: 7 };
    const min = -(2 ** (bits - 1)), max = 2 ** (bits - 1) - 1;
    const samples = [min, max, -1, 0, 1, 0]; // interleaved stereo
    const width = bits <= 16 ? 16 : 32;
    const native = width === 16 ? Int16Array : Int32Array;
    const packed = new native(samples.map(n => n * 2 ** (width - bits)));
    const nbytes = Math.ceil(bits / 8), serialized = Buffer.alloc(samples.length * nbytes);
    samples.forEach((value, i) => serialized.writeIntLE(value, i * nbytes, nbytes));
    const expected = createHash('md5').update(serialized).digest();
    const checker = new FlacIntegrity(bits, 2, expected, formats);
    checker.add({ format: width === 16 ? 1 : 2, nb_samples: 3, data: packed } as LibAVTypes.Frame);
    expect(checker.result()).toBe('verified');
  });
});

describe('bounded output writer', () => {
  it('preserves random-access header rewrites and rejects output over 128 MiB', async () => {
    const writer = new ChunkWriter();
    writer.write(0, new Uint8Array([0, 1, 2, 3]));
    writer.write(1, new Uint8Array([9, 8]));
    expect([...new Uint8Array(await writer.blob('audio/wav').arrayBuffer())]).toEqual([0, 9, 8, 3]);
    expect(() => writer.write(128 * 1024 * 1024, new Uint8Array([1]))).toThrow('128 MiB');
    expect(writer.overflow).toBe(true);
  });
});

describe('decoded float sample validation', () => {
  const frame = (format: number, data: unknown, nb_samples = 2) => ({ format, data, nb_samples }) as LibAVTypes.Frame;
  const flt = 3, fltp = 8;

  it('accepts exact ±1 and ordinary samples in packed and planar frames', () => {
    expect(() => checkFloatFrame(frame(flt, new Float32Array([-1, 1, 0, 0.5])), 2, flt, fltp)).not.toThrow();
    expect(() => checkFloatFrame(frame(fltp, [new Float32Array([-1, 0]), new Float32Array([1, 0.5])]), 2, flt, fltp)).not.toThrow();
    expect(() => checkFloatFrame(frame(2, new Int32Array([2147483647])), 1, flt, fltp)).not.toThrow();
  });

  it.each([1.01, -1.01])('rejects out-of-range sample %s in either layout and channel', value => {
    expect(() => checkFloatFrame(frame(flt, new Float32Array([0, 0, 0, value])), 2, flt, fltp)).toThrow('0 dBFS');
    expect(() => checkFloatFrame(frame(fltp, [new Float32Array([0, 0]), new Float32Array([0, value])]), 2, flt, fltp)).toThrow('원본 음량');
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite samples: %s', value => {
    expect(() => checkFloatFrame(frame(flt, new Float32Array([0, 0, 0, value])), 2, flt, fltp)).toThrow('NaN 또는 Infinity');
  });

  it('fails closed for malformed or incomplete libav float planes', () => {
    expect(() => checkFloatFrame(frame(flt, new Uint8Array(16)), 2, flt, fltp)).toThrow('데이터');
    expect(() => checkFloatFrame(frame(flt, new Float32Array(3)), 2, flt, fltp)).toThrow('데이터');
    expect(() => checkFloatFrame(frame(fltp, [new Float32Array(2)]), 2, flt, fltp)).toThrow('데이터');
    expect(() => checkFloatFrame(frame(fltp, [new Float32Array(2), new Float32Array(1)]), 2, flt, fltp)).toThrow('데이터');
  });
});
