export interface QualityReport {
  duration: number;
  channels: number;
  sampleRate: number;
  peakDb: number | null;
  rmsDb: number | null;
  silentRegions: { start: number; end: number }[];
  issues: { level: 'warning' | 'info'; message: string }[];
}

type WorkerResponse =
  | { type: 'progress'; message: string }
  | { type: 'success'; result: QualityReport }
  | { type: 'error'; message: string };

/** One worker, one analysis at a time; disposing is permanent. */
export class AudioQualityAnalyzer {
  private worker: Worker | null = null;
  private disposed = false;
  private pending: { resolve: (value: QualityReport) => void; reject: (error: Error) => void; report?: (message: string) => void } | null = null;

  async analyze(blob: Blob, report?: (message: string) => void): Promise<QualityReport> {
    if (this.disposed) throw new Error('품질 검사기가 종료되었습니다. 새 검사기를 만들어 주세요.');
    if (this.pending) throw new Error('다른 파일을 검사 중입니다. 완료 후 다시 시도해 주세요.');
    if (!(blob instanceof Blob) || !blob.size) throw new Error('검사할 오디오 파일이 비어 있거나 올바르지 않습니다.');
    if (typeof Worker === 'undefined') throw new Error('이 브라우저는 오디오 검사 Worker를 지원하지 않습니다.');
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./audio-quality.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        throw new Error('오디오 품질 검사기를 시작하지 못했습니다. 브라우저를 확인해 주세요.');
      }
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const pending = this.pending;
        if (!pending) return;
        const data = event.data;
        if (data.type === 'progress') {
          try { pending.report?.(data.message); } catch { /* UI callbacks cannot break analysis. */ }
        } else if (data.type === 'success') {
          this.pending = null;
          pending.resolve(data.result);
        } else if (data.type === 'error') {
          this.pending = null;
          pending.reject(new Error(data.message));
        }
      };
      this.worker.onerror = () => this.failWorker('오디오 검사 중 Worker 오류가 발생했습니다. 브라우저와 파일을 확인해 주세요.');
      this.worker.onmessageerror = () => this.failWorker('오디오 검사 결과를 읽지 못했습니다. 다시 시도해 주세요.');
    }
    return new Promise<QualityReport>((resolve, reject) => {
      this.pending = { resolve, reject, report };
      try {
        const assetBase = new URL(`${import.meta.env.BASE_URL}libav/`, window.location.href).href;
        this.worker!.postMessage({ type: 'analyze', blob, assetBase });
      } catch {
        this.failWorker('오디오 파일을 검사기에 전달하지 못했습니다.');
      }
    });
  }

  private failWorker(message: string): void {
    this.worker?.terminate();
    this.worker = null;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error(message));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error('오디오 검사가 취소되었습니다.'));
  }
}
