import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type LibAVTypes from '@libav.js/variant-obsolete';
import { AudioQualityAnalyzer } from './audio-quality';
import { inspectAudioFile } from './audio-quality-file';
import { QualityAccumulator, sourceS32BitDepth } from './audio-quality-stats';

const frame = (format: number, data: unknown, nb_samples: number) => ({ format, data, nb_samples }) as LibAVTypes.Frame;
const report = () => ({ duration: 1, channels: 1, sampleRate: 10, peakDb: -6, rmsDb: -9, silentRegions: [], issues: [] });
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); vi.stubGlobal('window', { location: { href: 'https://example.test/app/' } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('AudioQualityAnalyzer', () => {
  it('passes the subpath LibAV directory to the worker', async () => {
    vi.stubEnv('BASE_URL', '/narrow/');
    const a = new AudioQualityAnalyzer(), blob = new Blob(['x']);
    const result = a.analyze(blob);
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ assetBase: 'https://example.test/narrow/libav/' }));
    worker.emit({ type: 'success', result: report() });
    await result; a.dispose();
  });

  it('passes a Blob intact and reports progress without trusting a UI callback', async () => {
    const a = new AudioQualityAnalyzer(), blob = new Blob(['x']);
    const result = a.analyze(blob, () => { throw new Error('UI'); });
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'analyze', blob, assetBase: 'https://example.test/libav/' }));
    worker.emit({ type: 'progress', message: '읽는 중' }); worker.emit({ type: 'success', result: report() });
    await expect(result).resolves.toEqual(report()); a.dispose();
  });
  it('accepts File as well as Blob and rejects overlapping analyses', async () => {
    const a = new AudioQualityAnalyzer();
    const first = a.analyze(new File(['data'], 'test.wav'));
    await expect(a.analyze(new Blob(['b']))).rejects.toThrow('검사 중');
    FakeWorker.instances[0].emit({ type: 'error', message: '손상' });
    await expect(first).rejects.toThrow('손상'); a.dispose();
  });
  it('terminates and rejects a pending promise on dispose, permanently', async () => {
    const a = new AudioQualityAnalyzer(), p = a.analyze(new Blob(['x'])), w = FakeWorker.instances[0];
    a.dispose(); await expect(p).rejects.toThrow('취소'); expect(w.terminate).toHaveBeenCalledOnce();
    await expect(a.analyze(new Blob(['x']))).rejects.toThrow('종료'); a.dispose(); expect(w.terminate).toHaveBeenCalledOnce();
  });
  it('recovers after a worker failure and surfaces the failure', async () => {
    const a = new AudioQualityAnalyzer(), p = a.analyze(new Blob(['x'])); FakeWorker.instances[0].onerror?.();
    await expect(p).rejects.toThrow('Worker 오류'); expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    const next = a.analyze(new Blob(['x'])); FakeWorker.instances[1].emit({ type: 'success', result: report() });
    await expect(next).resolves.toEqual(report()); a.dispose();
  });
  it('rejects an empty input before creating a worker', async () => {
    await expect(new AudioQualityAnalyzer().analyze(new Blob())).rejects.toThrow('비어'); expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe('streaming statistics', () => {
  it('returns null peak/RMS and exact start/end for a silent 3 second signal', () => {
    const a = new QualityAccumulator(100, 1); a.add(frame(1, new Int16Array(300), 300));
    const r = a.finish(); expect(r.peakDb).toBeNull(); expect(r.rmsDb).toBeNull(); expect(r.silentRegions).toEqual([{ start: 0, end: 3 }]);
  });
  it('does not invent low regions in a short silent file', () => {
    const a = new QualityAccumulator(100, 1); a.add(frame(1, new Int16Array(299), 299)); expect(a.finish().silentRegions).toEqual([]);
  });
  it('combines both stereo channels without canceling opposite polarity', () => {
    const a = new QualityAccumulator(100, 2); const data = new Float32Array(800);
    for (let i = 0; i < 400; i++) { data[i * 2] = 0.5; data[i * 2 + 1] = -0.5; }
    a.add(frame(3, data, 400)); const r = a.finish(); expect(r.peakDb).toBeCloseTo(-6.0206); expect(r.rmsDb).toBeCloseTo(-6.0206); expect(r.silentRegions).toEqual([]);
  });
  it('aggregates both channels, not just a silent left channel', () => {
    const a = new QualityAccumulator(100, 2); const right = new Float32Array(400).fill(0.5);
    a.add(frame(8, [new Float32Array(400), right], 400)); const r = a.finish();
    expect(r.rmsDb).toBeCloseTo(-9.0309); expect(r.silentRegions).toEqual([]);
  });
  it('joins low windows across input frame boundaries and finishes trailing partial windows', () => {
    const a = new QualityAccumulator(100, 1);
    a.add(frame(3, new Float32Array(73).fill(0.5), 73)); a.add(frame(3, new Float32Array(210), 210)); a.add(frame(3, new Float32Array(113), 113));
    const r = a.finish(); expect(r.silentRegions).toEqual([{ start: 0.8, end: 3.96 }]);
  });
  it.each([[0, new Uint8Array([0, 255]), 0], [1, new Int16Array([-32768, 32767]), 0], [2, new Int32Array([-2147483648, 2147483647]), 0], [3, new Float32Array([-0.5, 0.5]), -6.0206]] as const)('normalizes packed format %s', (format, data, peak) => {
    const a = new QualityAccumulator(100, 1); a.add(frame(format, data, 2)); expect(a.finish().peakDb).toBeCloseTo(peak, 3);
  });
  it.each([[5, new Uint8Array([0, 255])], [6, new Int16Array([-32768, 32767])], [7, new Int32Array([-2147483648, 2147483647])], [8, new Float32Array([-1, 1])]] as const)('normalizes planar format %s', (format, data) => {
    const a = new QualityAccumulator(100, 1); a.add(frame(format, [data], 2)); expect(a.finish().peakDb).toBeCloseTo(0);
  });
  it('distinguishes a single near-limit peak from repeated exact digital limits', () => {
    const a = new QualityAccumulator(100, 1); a.add(frame(1, new Int16Array([0, 32767, 0]), 3));
    expect(a.finish().issues.some(x => x.message.includes('클리핑 의심'))).toBe(false);
    const b = new QualityAccumulator(100, 1); b.add(frame(1, new Int16Array([32767, 32767]), 2)); b.add(frame(1, new Int16Array([32767]), 1));
    expect(b.finish().issues.some(x => x.message.includes('클리핑 의심'))).toBe(true);
  });
  it('uses a confirmed 24-bit source limit for S32 while keeping negative and isolated peaks distinct', () => {
    const clipped = (values: number[], bits: 24 | null = 24) => {
      const a = new QualityAccumulator(100, 1, bits);
      a.add(frame(2, new Int32Array(values.slice(0, 2)), 2));
      a.add(frame(2, new Int32Array(values.slice(2)), values.length - 2));
      return a.finish().issues.some(x => x.message.includes('클리핑 의심'));
    };
    expect(clipped([2147483392, 2147483392, 2147483392])).toBe(true);
    expect(clipped([-2147483648, -2147483648, -2147483648])).toBe(true);
    expect(clipped([0, 2147483392, 0])).toBe(false);
    expect(clipped([-2147483392, -2147483392, -2147483392])).toBe(false);
    expect(clipped([2147483136, 2147483136, 2147483136])).toBe(false);
    expect(clipped([2147483392, 2147483392, 2147483392], null)).toBe(false);
    expect(clipped([-2147483648, 2147483392, -2147483648])).toBe(false);
  });
  it('keeps 24-bit clip runs per channel for planar stereo', () => {
    const a = new QualityAccumulator(100, 2, 24);
    a.add(frame(7, [new Int32Array([2147483392, 2147483392, 2147483392]), new Int32Array([0, 0, 0])], 3));
    expect(a.finish().issues.some(x => x.message.includes('클리핑 의심'))).toBe(true);
    const b = new QualityAccumulator(100, 2, 24);
    b.add(frame(7, [new Int32Array([2147483392, 0, 2147483392]), new Int32Array([0, 2147483392, 0])], 3));
    expect(b.finish().issues.some(x => x.message.includes('클리핑 의심'))).toBe(false);
  });
  it('warns for unknown source depth only when a packed or planar S32 frame is actually observed', () => {
    const limitation = (a: QualityAccumulator) => a.finish().issues.filter(x => x.level === 'warning' && /S32.*24비트.*양의.*놓칠/.test(x.message));
    for (const [format, data] of [[2, new Int32Array(3)], [7, [new Int32Array(3)]]] as const) {
      const a = new QualityAccumulator(100, 1);
      a.add(frame(format, data, 3)); a.add(frame(format, data, 3));
      expect(limitation(a)).toHaveLength(1);
      const known = new QualityAccumulator(100, 1, 24); known.add(frame(format, data, 3));
      expect(limitation(known)).toHaveLength(0);
      const knownOther = new QualityAccumulator(100, 1, 'other'); knownOther.add(frame(format, data, 3));
      expect(limitation(knownOther)).toHaveLength(0);
    }
    for (const [format, data] of [[1, new Int16Array(3)], [3, new Float32Array(3)], [8, [new Float32Array(3)]]] as const) {
      const a = new QualityAccumulator(100, 1); a.add(frame(format, data, 3));
      expect(limitation(a)).toHaveLength(0);
    }
  });
  it.each([NaN, Infinity, -Infinity])('rejects non-finite sample %s', sample => {
    const a = new QualityAccumulator(100, 1); expect(() => a.add(frame(3, new Float32Array([sample]), 1))).toThrow('NaN 또는 Infinity');
  });
  it('rejects unknown formats and incomplete planar samples', () => {
    const a = new QualityAccumulator(100, 2); expect(() => a.add(frame(4, new Float64Array(4), 2))).toThrow('샘플 형식');
    expect(() => a.add(frame(8, [new Float32Array(2)], 2))).toThrow('샘플 데이터');
  });
  it('warns only for large variation between at least two full active 5-second blocks', () => {
    const a = new QualityAccumulator(100, 1); a.add(frame(3, new Float32Array(500).fill(0.5), 500)); a.add(frame(3, new Float32Array(500).fill(0.1), 500));
    expect(a.finish().issues.some(x => x.message.includes('구간별 음량 차이 의심'))).toBe(true);
    const b = new QualityAccumulator(100, 1); b.add(frame(3, new Float32Array(500).fill(0.5), 500)); b.add(frame(3, new Float32Array(500), 500));
    expect(b.finish().issues.some(x => x.message.includes('구간별 음량 차이 의심'))).toBe(false);
    const c = new QualityAccumulator(100, 1); c.add(frame(3, new Float32Array(499).fill(0.1), 499)); expect(c.finish().issues.some(x => x.message.includes('구간별 음량 차이 의심'))).toBe(false);
  });
  it('caps retained regions and warns when further regions are omitted', () => {
    const a = new QualityAccumulator(10, 1);
    for (let i = 0; i < 1002; i++) { a.add(frame(3, new Float32Array(30), 30)); a.add(frame(3, new Float32Array(1).fill(0.5), 1)); }
    const r = a.finish(); expect(r.silentRegions).toHaveLength(1000); expect(r.issues.some(x => x.message.includes('처음 1000개'))).toBe(true);
  });
});

function wav(samples = 100): Blob {
  const b = new Uint8Array(44 + samples * 2), v = new DataView(b.buffer), set = (at: number, s: string) => b.set(new TextEncoder().encode(s), at);
  set(0, 'RIFF'); v.setUint32(4, b.length - 8, true); set(8, 'WAVE'); set(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); set(36, 'data'); v.setUint32(40, samples * 2, true);
  return new Blob([b]);
}
describe('bounded file inspection', () => {
  it('confirms 24 bits from WAV PCM and FLAC STREAMINFO, not float, 32-bit or malformed headers', async () => {
    const b = new Uint8Array(await wav(99).arrayBuffer());
    const v = new DataView(b.buffer);
    v.setUint16(32, 3, true); v.setUint16(34, 24, true);
    expect(await sourceS32BitDepth(new Blob([b]), 'wav')).toBe(24);
    v.setUint16(34, 32, true);
    expect(await sourceS32BitDepth(new Blob([b]), 'wav')).toBeNull();
    v.setUint16(32, 4, true);
    expect(await sourceS32BitDepth(new Blob([b]), 'wav')).toBe('other');
    v.setUint16(32, 3, true);
    v.setUint16(34, 24, true); v.setUint16(20, 3, true);
    expect(await sourceS32BitDepth(new Blob([b]), 'wav')).toBeNull();
    const flac = new Uint8Array(42); flac.set(new TextEncoder().encode('fLaC')); flac[7] = 34;
    flac[20] = 1; flac[21] = 0x70; // 24-bit STREAMINFO
    expect(await sourceS32BitDepth(new Blob([flac]), 'flac')).toBe(24);
    flac[21] = 0xf0; // 32-bit STREAMINFO
    expect(await sourceS32BitDepth(new Blob([flac]), 'flac')).toBe('other');
    expect(await sourceS32BitDepth(new Blob([flac.slice(0, 21)]), 'flac')).toBeNull();
    expect(await sourceS32BitDepth(new Blob([b]), 'mp3')).toBe('other');
  });
  it('accepts only unambiguous 24-bit PCM extensible WAV metadata', async () => {
    const b = new Uint8Array(68 + 6), v = new DataView(b.buffer);
    const put = (at: number, s: string) => b.set(new TextEncoder().encode(s), at);
    put(0, 'RIFF'); v.setUint32(4, b.length - 8, true); put(8, 'WAVE'); put(12, 'fmt '); v.setUint32(16, 40, true);
    v.setUint16(20, 0xfffe, true); v.setUint16(22, 1, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
    v.setUint16(36, 22, true); v.setUint16(38, 24, true); v.setUint32(44, 1, true); v.setUint16(50, 0x10, true);
    b.set([0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 52); put(60, 'data'); v.setUint32(64, 6, true);
    expect(await sourceS32BitDepth(new Blob([b]), 'wav')).toBe(24);
    v.setUint16(38, 20, true); expect(await sourceS32BitDepth(new Blob([b]), 'wav')).toBe('other');
    v.setUint16(38, 24, true); v.setUint32(44, 3, true); expect(await sourceS32BitDepth(new Blob([b]), 'wav')).toBeNull();
    v.setUint32(44, 1, true);
    const duplicate = new Uint8Array(b.length + 48); duplicate.set(b); duplicate.set(b.slice(12, 60), b.length);
    new DataView(duplicate.buffer).setUint32(4, duplicate.length - 8, true);
    expect(await sourceS32BitDepth(new Blob([duplicate]), 'wav')).toBeNull();
  });
  it('identifies WAV by signature and reads declared PCM sample count', async () => { expect(await inspectAudioFile(wav(100))).toMatchObject({ format: 'wav', samples: 100 }); });
  it('rejects truncated RIFF and a data chunk extending beyond RIFF', async () => {
    const file = wav(100); await expect(inspectAudioFile(file.slice(0, file.size - 2))).rejects.toThrow('잘렸');
    const b = new Uint8Array(await file.arrayBuffer()); new DataView(b.buffer).setUint32(40, 202, true); await expect(inspectAudioFile(new Blob([b]))).rejects.toThrow('청크');
  });
  it('validates FLAC STREAMINFO and warns on unknown sample count', async () => {
    const b = new Uint8Array(42); b.set(new TextEncoder().encode('fLaC')); b[7] = 34;
    expect(await inspectAudioFile(new Blob([b]))).toMatchObject({ format: 'flac', samples: null, warnings: [expect.stringContaining('검증할 수 없습니다')] });
    b[25] = 100; expect(await inspectAudioFile(new Blob([b]))).toMatchObject({ samples: 100 });
    await expect(inspectAudioFile(new Blob([b.slice(0, 20)]))).rejects.toThrow('STREAMINFO');
  });
  it('rejects extension-only or fake ID3 files and truncated tags', async () => {
    await expect(inspectAudioFile(new File(['not wave'], 'hello.wav'))).rejects.toThrow('지원하지');
    await expect(inspectAudioFile(new Blob([new Uint8Array([73,68,51,4,0,0,0,0,0,0])]))).rejects.toThrow('프레임');
    await expect(inspectAudioFile(new Blob([new Uint8Array([73,68,51,4,0,0,0,0,1,0])]))).rejects.toThrow('태그');
  });
  it('only reads short slices even when a Blob is larger than 128 MiB', async () => {
    const input = wav(100); const header = new Uint8Array(await input.arrayBuffer());
    const slice = vi.fn((start: number, end: number) => new Blob([header.slice(start, Math.min(end, header.length))]));
    const large = { size: 200 * 1024 * 1024, slice } as unknown as Blob;
    expect(await inspectAudioFile(large)).toMatchObject({ format: 'wav', samples: 100 });
    expect(Math.max(...slice.mock.calls.map(([start, end]) => end - start))).toBeLessThanOrEqual(16);
    slice.mockClear();
    expect(await sourceS32BitDepth(large, 'wav')).toBe('other');
    expect(Math.max(...slice.mock.calls.map(([start, end]) => end - start))).toBeLessThanOrEqual(40);
  });
  it('does not perform network I/O on source audio', () => {
    const worker = readFileSync(new URL('./audio-quality.worker.ts', import.meta.url), 'utf8');
    const modules = ['./audio-quality.ts', './audio-quality-file.ts', './audio-quality-length.ts', './audio-quality-stats.ts']
      .map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
    expect(worker + modules.join('\n')).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/);
    expect(worker).toContain('base.origin !== self.location.origin');
    expect(worker).toContain("mkreadaheadfile('quality-input', blob)");
  });
  it('describes the MP3 short status without asserting a large decoded-audio shortfall', () => {
    const worker = readFileSync(new URL('./audio-quality.worker.ts', import.meta.url), 'utf8');
    expect(worker).not.toContain('디코딩된 오디오가 크게 부족');
    expect(worker).toMatch(/MP3.*바이트.*길이.*불일치/);
  });
});
