import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtsEngine } from './tts-engine';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const options = { text: '비공개 원고', lang: 'ko' as const, voice: 'F1', speed: 1 };
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => vi.unstubAllGlobals());

describe('TtsEngine worker lifecycle', () => {
  it('passes the manuscript only to its worker, ignores UI progress exceptions, and reuses the worker', async () => {
    const engine = new TtsEngine();
    const first = engine.generate(options, () => { throw new Error('UI callback'); });
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'generate', options });
    worker.emit({ type: 'progress', message: 'processing' });
    const result = { blob: new Blob(['audio']), duration: 1, cues: [{ text: options.text, start: 0, duration: 1 }] };
    worker.emit({ type: 'result', ...result });
    await expect(first).resolves.toEqual(result);
    const second = engine.generate(options, () => {});
    expect(FakeWorker.instances).toHaveLength(1);
    worker.emit({ type: 'result', ...result });
    await expect(second).resolves.toEqual(result);
    engine.dispose();
  });
  it('rejects overlap and terminates immediately on cancel without accepting new work', async () => {
    const engine = new TtsEngine(); const first = engine.generate(options, () => {});
    await expect(engine.generate(options, () => {})).rejects.toThrow('이미 음성을 생성 중');
    engine.dispose();
    await expect(first).rejects.toThrow('취소');
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    await expect(engine.generate(options, () => {})).rejects.toThrow('종료');
  });
  it('keeps a worker after an ordinary error but replaces it after a crash', async () => {
    const engine = new TtsEngine();
    const first = engine.generate(options, () => {});
    FakeWorker.instances[0].emit({ type: 'error', message: 'recoverable' });
    await expect(first).rejects.toThrow('recoverable');
    const second = engine.generate(options, () => {});
    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0].onerror?.({ message: 'crash' } as ErrorEvent);
    await expect(second).rejects.toThrow('crash');
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    const third = engine.generate(options, () => {});
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].emit({ type: 'error', message: 'retry' });
    await expect(third).rejects.toThrow('retry'); engine.dispose();
  });
  it('rejects invalid options before starting a worker', async () => {
    const engine = new TtsEngine();
    await expect(engine.generate({ ...options, text: ' ' }, () => {})).rejects.toThrow('텍스트');
    await expect(engine.generate({ ...options, voice: 'F6' }, () => {})).rejects.toThrow('음성');
    await expect(engine.generate({ ...options, speed: NaN }, () => {})).rejects.toThrow('속도');
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
