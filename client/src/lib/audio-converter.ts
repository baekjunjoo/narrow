export type AudioFormat = 'mp3' | 'wav' | 'flac';

export interface ConvertedAudio {
  blob: Blob;
  warnings: string[];
  inputChannels: number;
  outputChannels: number;
  inputSampleRate: number;
  outputSampleRate: number;
}

type WorkerResponse =
  | { type: 'progress'; message: string }
  | { type: 'success'; result: ConvertedAudio }
  | { type: 'error'; message: string };

/** One worker, one conversion at a time. Disposing is permanent. */
export class AudioConverter {
  private worker: Worker | null = null;
  private pending: { resolve: (value: ConvertedAudio) => void; reject: (reason: Error) => void; report: (message: string) => void } | null = null;
  private disposed = false;

  async convert(file: File, format: AudioFormat, report: (message: string) => void): Promise<ConvertedAudio> {
    if (this.disposed) throw new Error('변환기가 종료되었습니다. 새 변환기를 만들어 주세요.');
    if (this.pending) throw new Error('다른 파일을 변환 중입니다. 완료 후 다시 시도해 주세요.');
    if (!file || file.size === 0) throw new Error('원본 파일이 비어 있습니다.');
    if (!['mp3', 'wav', 'flac'].includes(format)) throw new Error('지원하지 않는 출력 형식입니다.');

    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./audio-converter.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        throw new Error('오디오 변환기를 시작하지 못했습니다. 브라우저를 확인해 주세요.');
      }
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const pending = this.pending;
        if (!pending) return;
        const data = event.data;
        if (data.type === 'progress') {
          // A UI callback must not compromise the conversion lifecycle.
          try { pending.report(data.message); } catch { /* ignored */ }
        } else if (data.type === 'success') {
          this.pending = null;
          pending.resolve(data.result);
        } else if (data.type === 'error') {
          this.pending = null;
          pending.reject(new Error(data.message));
        }
      };
      this.worker.onerror = () => this.failWorker('변환 중 오류가 발생했습니다. 파일과 브라우저를 확인해 주세요.');
      this.worker.onmessageerror = () => this.failWorker('변환 결과를 읽지 못했습니다. 다시 시도해 주세요.');
    }

    return new Promise<ConvertedAudio>((resolve, reject) => {
      this.pending = { resolve, reject, report };
      try {
        const assetBase = new URL(`${import.meta.env.BASE_URL}libav/`, window.location.href).href;
        this.worker!.postMessage({ type: 'convert', file, format, assetBase });
      } catch {
        this.pending = null;
        reject(new Error('파일을 변환기에 전달하지 못했습니다.'));
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
    pending?.reject(new Error('변환이 취소되었습니다.'));
  }
}
