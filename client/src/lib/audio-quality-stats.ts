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

type SourceS32Bits = 24 | 'other' | null;

/** Confirm 24-bit sources for which LibAV left-aligns integer samples in S32.
 * 'other' means 24-bit PCM is ruled out or inapplicable (e.g. MP3).
 * This deliberately does not infer bit depth from sample values. Read only
 * bounded headers; an unrecognized or ambiguous header remains unknown.
 * The worker first validates the file using inspectAudioFile.
 */
export async function sourceS32BitDepth(blob: Blob, format: 'wav' | 'flac' | 'mp3'): Promise<SourceS32Bits> {
  const read = async (start: number, length: number) => new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
  const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (format === 'flac') {
    const b = await read(0, 42);
    if (b.length < 42 || !ascii(b, 0, 'fLaC') || (b[4] & 0x7f) !== 0 || b[5] !== 0 || b[6] !== 0 || b[7] !== 34) return null;
    const bits = (((b[20] & 1) << 4) | (b[21] >> 4)) + 1;
    return bits < 4 ? null : bits === 24 ? 24 : 'other';
  }
  if (format === 'mp3') return 'other';
  const head = await read(0, 12);
  if (head.length < 12 || !(ascii(head, 0, 'RIFF') || ascii(head, 0, 'RF64')) || !ascii(head, 8, 'WAVE')) return null;
  const rf64 = ascii(head, 0, 'RF64');
  let end = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true) + 8;
  let rfData: number | null = null;
  if (rf64) {
    const ds = await read(12, 36);
    if (ds.length < 36 || !ascii(ds, 0, 'ds64')) return null;
    const v = new DataView(ds.buffer, ds.byteOffset, ds.byteLength);
    if (v.getUint32(4, true) < 28) return null;
    const riffSize = v.getBigUint64(8, true), dataSize = v.getBigUint64(16, true);
    if (riffSize > BigInt(Number.MAX_SAFE_INTEGER - 8) || dataSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    end = Number(riffSize) + 8; rfData = Number(dataSize);
  }
  if (end > blob.size || end < 12) return null;
  let at = 12, chunks = 0, result: SourceS32Bits = null, formatChunks = 0;
  while (at < end) {
    if (++chunks > 4096 || at + 8 > end) return null;
    const h = await read(at, 8);
    if (h.length !== 8) return null;
    let size = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(4, true);
    if (rf64 && ascii(h, 0, 'data') && size === 0xffffffff && rfData !== null) size = rfData;
    const next = at + 8 + size + (size % 2);
    if (!Number.isSafeInteger(next) || next > end) return null;
    if (ascii(h, 0, 'fmt ')) {
      if (++formatChunks > 1) return null;
      const fmt = await read(at + 8, Math.min(size, 40));
      if (fmt.length < 16) return null;
      const v = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
      const tag = v.getUint16(0, true), channels = v.getUint16(2, true), bits = v.getUint16(14, true);
      if (!channels || ![8, 16, 24, 32, 64].includes(bits) || v.getUint16(12, true) !== channels * bits / 8) return null;
      if (tag === 1 && bits !== 64) result = bits === 24 ? 24 : 'other';
      else if (tag === 3 && (bits === 32 || bits === 64)) result = 'other';
      // WAVE_FORMAT_EXTENSIBLE: 24 valid bits and KSDATAFORMAT_SUBTYPE_PCM GUID.
      else if (tag === 0xfffe && fmt.length >= 40 && v.getUint16(16, true) >= 22 &&
          v.getUint32(24, true) === 1 && v.getUint16(28, true) === 0 && v.getUint16(30, true) === 0x0010 &&
          fmt.slice(32, 40).every((x, i) => x === [0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71][i])) {
        const validBits = v.getUint16(18, true);
        if (!validBits || validBits > bits || bits === 64) return null;
        if (validBits === 24 && bits === 24) result = 24;
        else if (validBits !== 24) result = 'other';
        else return null; // 24 valid bits in a wider container: alignment is not confirmed here.
      }
      else return null;
    }
    at = next;
  }
  return formatChunks === 1 ? result : null;
}

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
  private unknownS32 = false;

  constructor(readonly sampleRate: number, readonly channels: number, readonly sourceS32Bits: SourceS32Bits = null) {
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
    if (format.kind === 's32' && this.sourceS32Bits === null) this.unknownS32 = true;
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
          : format.kind === 's32' ? (raw === -2147483648 ? -1 : raw === (this.sourceS32Bits === 24 ? 2147483392 : 2147483647) ? 1 : 0)
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
    if (this.unknownS32) issues.push({ level: 'warning', message: 'S32 샘플의 원본이 24비트인지 확인할 수 없어 32비트 양의 최댓값을 기준으로 검사합니다. 원본이 24비트라면 양의 디지털 최댓값 연속을 놓칠 수 있습니다.' });
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
