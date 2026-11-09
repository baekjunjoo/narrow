export interface TtsOptions {
  text: string;
  lang: 'ko' | 'en';
  voice: string;
  speed: number;
}

/** PCM timeline in seconds: start includes preceding pauses; duration excludes them. */
export interface TtsCue {
  text: string;
  start: number;
  duration: number;
}

export interface TtsResult {
  blob: Blob;
  duration: number;
  cues: TtsCue[];
}

type WorkerReply =
  | { type: 'progress'; message: string; percent?: number }
  | ({ type: 'result' } & TtsResult)
  | { type: 'error'; message: string };

/** Local Supertonic 3 inference. A single instance handles one request at a time. */
export class TtsEngine {
  private worker: Worker | null = null;
  private disposed = false;
  private pending: { reject: (error: Error) => void } | null = null;

  async generate(
    options: TtsOptions,
    progress: (message: string, percent?: number) => void,
  ): Promise<TtsResult> {
    if (this.disposed) throw new Error('이미 종료된 음성 엔진입니다. 새 엔진을 만들어 주세요.');
    if (this.pending) throw new Error('이미 음성을 생성 중입니다. 완료 후 다시 시도해 주세요.');
    if (typeof options.text !== 'string' || !options.text.trim()) throw new Error('읽을 텍스트를 입력해 주세요.');
    if (options.lang !== 'ko' && options.lang !== 'en') throw new Error('한국어 또는 영어만 지원합니다.');
    if (!/^[FM][1-5]$/.test(options.voice)) throw new Error('음성은 F1~F5 또는 M1~M5여야 합니다.');
    if (!Number.isFinite(options.speed) || options.speed < 0.5 || options.speed > 2) {
      throw new Error('읽기 속도는 0.5~2.0이어야 합니다.');
    }
    if (typeof Worker === 'undefined') throw new Error('이 브라우저는 Web Worker를 지원하지 않습니다.');

    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./tts-engine.worker.ts', import.meta.url), { type: 'module' });
      } catch (error) {
        throw new Error(`음성 엔진을 시작할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      this.pending = { reject };
      const cleanup = () => {
        this.pending = null;
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };
      const workerFailed = (message: string) => {
        cleanup();
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        reject(new Error(message));
      };
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        if (reply.type === 'progress') {
          try { progress(reply.message, reply.percent); } catch { /* UI callbacks must not break inference. */ }
        } else if (reply.type === 'result') {
          cleanup();
          resolve({ blob: reply.blob, duration: reply.duration, cues: reply.cues });
        } else if (reply.type === 'error') {
          // The worker deliberately remains alive: failed downloads can be retried.
          cleanup();
          reject(new Error(reply.message));
        }
      };
      worker.onerror = (event) => workerFailed(`음성 엔진 Worker 오류: ${event.message || '알 수 없는 오류'}. 다시 시도해 주세요.`);
      worker.onmessageerror = () => workerFailed('음성 엔진과 통신하지 못했습니다. 다시 시도해 주세요.');
      try {
        worker.postMessage({ type: 'generate', options });
      } catch (error) {
        workerFailed(`음성 생성을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Stops inference and immediately rejects the in-flight operation, if any. */
  dispose(): void {
    this.disposed = true;
    const pending = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    pending?.reject(new Error('음성 생성이 취소되었습니다.'));
  }
}
