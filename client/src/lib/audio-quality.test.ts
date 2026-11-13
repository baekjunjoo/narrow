import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type LibAVTypes from '@libav.js/variant-obsolete';
import { AudioQualityAnalyzer } from './audio-quality';
import { inspectAudioFile } from './audio-quality-file';
import { QualityAccumulator } from './audio-quality-stats';

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
afterEach(() => vi.unstubAllGlobals());

describe('AudioQualityAnalyzer', () => {
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
  });
  it('does not perform network I/O on source audio', () => {
    const worker = readFileSync(new URL('./audio-quality.worker.ts', import.meta.url), 'utf8');
    const modules = ['./audio-quality.ts', './audio-quality-file.ts', './audio-quality-length.ts', './audio-quality-stats.ts']
      .map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
    expect(worker + modules.join('\n')).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/);
    expect(worker).toContain('base.origin !== self.location.origin');
    expect(worker).toContain("mkreadaheadfile('quality-input', blob)");
  });
});
