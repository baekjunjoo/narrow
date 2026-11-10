import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioConverter } from './audio-converter';
import { checkFloatFrame, ChunkWriter, mp3DeclaredLength, mp3LengthStatus, parseMp3Length } from './audio-converter.worker';
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
afterEach(() => vi.unstubAllGlobals());

describe('AudioConverter', () => {
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

describe('MP3 declared length validation', () => {
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
