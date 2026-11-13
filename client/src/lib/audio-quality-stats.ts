import type LibAVTypes from '@libav.js/variant-obsolete';
import type { QualityReport } from './audio-quality';

/** AV_SAMPLE_FMT values are standardized by FFmpeg. LibAV's copyout supports these eight types. */
const FORMATS = {
  0: { kind: 'u8', planar: false }, 1: { kind: 's16', planar: false },
 2: { kind: 's32', planar: false }, 3: { kind: 'flt', planar: false },
 5: { kind: 'u8', planar: true }, 6: { kind: 's16', planar: true },
 7: { kind: 's32', planar: true }, 8: { kind: 'flt', planar: true },
} as const;
type SampleArray = Uint8Array | Int16Array | Int32Array | Float32Array;
const MAX_REGIONS = 1000;
const LOW_DB = -55;
const db = (amplitude: number): number | null => amplitude === 0 ? null : 20 * Math.log10(amplitude);

/** Streaming accumulator: retains only counters, two channel clip runs and at most 1000 regions. */
export class QualityAccumulator {
  private peak = 0;
  private energy = 0;
  private sampleFrames = 0;
  private windowEnergy = 0;
  private windowFrames = 0;
  private windowIndex = 0;
  private lowStart: number | null = null;
  private regions: { start: number; end: number }[] = [];
  private omittedRegions = false;
  private clipRuns: number[];
  private clipSigns: number[];
  private repeatedLimit = false;
  private levelEnergy = 0;
  private levelFrames = 0;
  private minActive = Infinity;
  private maxActive = -Infinity;
  private activeBlocks = 0;
  private overFullScale = false;

  constructor(readonly sampleRate: number, readonly channels: number) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || ![1, 2].includes(channels)) throw new Error('채널 또는 샘플레이트를 확인할 수 없습니다.');
    this.clipRuns = Array(channels).fill(0);
    this.clipSigns = Array(channels).fill(0);
  }

  add(frame: LibAVTypes.Frame): void {
    const format = FORMATS[frame.format as keyof typeof FORMATS];
    const n = frame.nb_samples;
    if (!format) throw new Error('이 오디오의 샘플 형식은 안전하게 검사할 수 없습니다.');
    if (!Number.isInteger(n) || !n || n < 0) throw new Error('디코딩된 오디오 프레임의 길이가 올바르지 않습니다.');
    const count = n as number;
    const planes: unknown[] = format.planar ? frame.data : [frame.data];
    const valid = (x: unknown): x is SampleArray => format.kind === 'u8' ? x instanceof Uint8Array : format.kind === 's16' ? x instanceof Int16Array : format.kind === 's32' ? x instanceof Int32Array : x instanceof Float32Array;
    if (!Array.isArray(planes) || planes.length !== (format.planar ? this.channels : 1) || planes.some(p => !valid(p) || p.length !== count * (format.planar ? 1 : this.channels))) {
      throw new Error('디코딩된 오디오 샘플 데이터가 손상되었거나 지원되지 않습니다.');
    }
    const data = planes as SampleArray[];
    for (let i = 0; i < count; i++) {
      let frameEnergy = 0;
      for (let ch = 0; ch < this.channels; ch++) {
        const raw = format.planar ? data[ch][i] : data[0][i * this.channels + ch];
        const sample = format.kind === 'u8' ? (raw - 128) / 128 : format.kind === 's16' ? raw / 32768 : format.kind === 's32' ? raw / 2147483648 : raw;
        if (!Number.isFinite(sample)) throw new Error('오디오에 NaN 또는 Infinity 샘플이 있어 검사할 수 없습니다.');
        const abs = Math.abs(sample);
        this.peak = Math.max(this.peak, abs);
        if (abs > 1) this.overFullScale = true;
        // Count only consecutive samples at the same positive/negative digital limit, per channel.
        const sign = format.kind === 'u8' ? (raw === 0 ? -1 : raw === 255 ? 1 : 0)
          : format.kind === 's16' ? (raw === -32768 ? -1 : raw === 32767 ? 1 : 0)
          : format.kind === 's32' ? (raw === -2147483648 ? -1 : raw === 2147483647 ? 1 : 0)
          : (sample === -1 ? -1 : sample === 1 ? 1 : 0);
        this.clipRuns[ch] = sign && sign === this.clipSigns[ch] ? this.clipRuns[ch] + 1 : sign ? 1 : 0;
        this.clipSigns[ch] = sign;
        if (this.clipRuns[ch] >= 3) this.repeatedLimit = true;
        frameEnergy += sample * sample;
      }
      this.energy += frameEnergy;
      this.windowEnergy += frameEnergy;
      this.levelEnergy += frameEnergy;
      this.sampleFrames++;
      this.windowFrames++;
      this.levelFrames++;
      // Rounded sample boundaries preserve 100 ms timing even for rates not divisible by 10.
      if (this.sampleFrames >= Math.round((this.windowIndex + 1) * this.sampleRate / 10)) this.closeWindow();
      if (this.levelFrames === this.sampleRate * 5) this.closeLevelBlock();
    }
  }

  private closeWindow(): void {
    if (!this.windowFrames) return;
    const start = (this.sampleFrames - this.windowFrames) / this.sampleRate;
    const rms = Math.sqrt(this.windowEnergy / (this.windowFrames * this.channels));
    const low = rms < 10 ** (LOW_DB / 20);
    if (low && this.lowStart === null) this.lowStart = start;
    if (!low && this.lowStart !== null) { this.saveRegion(this.lowStart, start); this.lowStart = null; }
    this.windowEnergy = 0;
    this.windowFrames = 0;
    this.windowIndex++;
  }

  private saveRegion(start: number, end: number): void {
    if (end - start < 3 - 1e-9) return;
    if (this.regions.length < MAX_REGIONS) this.regions.push({ start, end });
    else this.omittedRegions = true;
  }

  private closeLevelBlock(): void {
    const rms = Math.sqrt(this.levelEnergy / (this.levelFrames * this.channels));
    const level = db(rms);
    // Only full 5-second blocks with audible energy qualify; silence is excluded.
    if (level !== null && level >= -45) {
      this.minActive = Math.min(this.minActive, level);
      this.maxActive = Math.max(this.maxActive, level);
      this.activeBlocks++;
    }
    this.levelEnergy = 0;
    this.levelFrames = 0;
  }

  finish(): QualityReport {
    if (!this.sampleFrames) throw new Error('읽을 수 있는 오디오 샘플이 없습니다.');
    this.closeWindow();
    const duration = this.sampleFrames / this.sampleRate;
    if (this.lowStart !== null) this.saveRegion(this.lowStart, duration);
    const peakDb = db(this.peak);
    const rmsDb = db(Math.sqrt(this.energy / (this.sampleFrames * this.channels)));
    const issues: QualityReport['issues'] = [
      { level: 'info', message: '저음량 구간: 양 채널을 함께 집계한 100ms 창의 RMS가 -55 dBFS 미만인 구간이 3초 이상 지속될 때 표시합니다. 경계는 약 0.1초 단위이며 마지막 창은 더 짧을 수 있습니다.' },
      { level: 'info', message: '전체 RMS는 가중하지 않은 평균이며 LUFS가 아닙니다. 샘플 피크는 true peak가 아닙니다. 원고 누락·발음과 배경음 비율 또는 적합성은 판별하지 못하므로 직접 청취해 주세요.' },
      { level: 'info', message: '구간별 음량 차이는 완전한 5초 구간의 전체 채널 RMS가 -45 dBFS 이상인 구간 2개 이상을 비교하고 차이가 12 dB 이상일 때 경고하는 실험적 휴리스틱입니다. 음성 판별이나 LUFS·loudness range 측정이 아니며 정상 연출과 속삭임에도 경고될 수 있습니다.' },
    ];
    if (this.activeBlocks < 2) issues.push({ level: 'info', message: '비교 가능한 5초 활동 구간이 2개 미만이라 구간별 음량 차이를 판단하지 않았습니다.' });
    if (peakDb === null) issues.push({ level: 'warning', message: '디코딩된 오디오가 모두 디지털 무음입니다.' });
    else {
      if (rmsDb !== null && rmsDb < -35) issues.push({ level: 'warning', message: '전체 RMS가 -35 dBFS 미만으로 매우 작습니다. 청취해 음량을 확인해 주세요.' });
      if (peakDb >= -1) issues.push({ level: 'warning', message: '디지털 샘플 피크가 0 dBFS 부근입니다. 이것만으로 클리핑이나 true peak 초과를 확정할 수 없습니다.' });
      if (this.overFullScale) issues.push({ level: 'warning', message: '부동소수점 샘플이 0 dBFS를 초과합니다. 출력 과정에서 포화될 수 있습니다.' });
      if (this.repeatedLimit) issues.push({ level: 'warning', message: '같은 채널의 동일한 디지털 상한 또는 하한 샘플이 3회 이상 연속되어 클리핑 의심이 있습니다. 확정 판정은 아닙니다.' });
    }
    if (this.regions.length) issues.push({ level: 'warning', message: '3초 이상 지속된 저음량 또는 무음 의심 구간이 있습니다. 의도된 휴지나 배경음일 수 있으니 청취해 확인해 주세요.' });
    if (this.omittedRegions) issues.push({ level: 'warning', message: `저음량 구간이 많아 처음 ${MAX_REGIONS}개만 표시합니다.` });
    if (this.activeBlocks >= 2 && this.maxActive - this.minActive >= 12) issues.push({ level: 'warning', message: '구간별 음량 차이 의심: 5초 단위 전체 채널 RMS가 -45 dBFS 이상인 활동 구간 중 최대와 최소가 12 dB 이상 차이납니다. 실험적 휴리스틱으로 연출·속삭임에서도 나타날 수 있으며 LUFS 또는 loudness range 측정이 아닙니다.' });
    return { duration, channels: this.channels, sampleRate: this.sampleRate, peakDb, rmsDb, silentRegions: this.regions, issues };
  }
}
