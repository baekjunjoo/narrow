import type LibAVTypes from '@libav.js/variant-obsolete';
import type { AudioFormat, ConvertedAudio } from './audio-converter';
import { mp3DeclaredLength, mp3LengthStatus } from './audio-quality-length';
export { mp3DeclaredLength, mp3LengthStatus, parseMp3Length } from './audio-quality-length';

type LibAV = LibAVTypes.LibAV;
type Frame = LibAVTypes.Frame;
type Request = { type: 'convert'; file: File; format: AudioFormat; assetBase: string };

const MAX_OUTPUT = 128 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const READ_LIMIT = 32 * 1024;
const OUTPUT_TOO_LARGE = '변환 결과가 128 MiB를 초과합니다. 원본을 장별로 나누어 변환해 주세요.';

class ConversionError extends Error {}

const MP3_UNVERIFIED = 'MP3 원본 전체 길이 검증 불가, 결과를 청취해 확인해 주세요.';

// FLAC STREAMINFO specifies MD5, which Web Crypto does not provide. This incremental
// implementation retains only a 64-byte tail, so audiobook-sized PCM is not buffered.
const MD5_K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
export class StreamingMd5 {
  private state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  private words = new Uint32Array(16);
  private tail = new Uint8Array(64);
  private used = 0;
  private bytes = 0;

  private block(data: Uint8Array, offset: number): void {
    const view = new DataView(data.buffer, data.byteOffset + offset, 64);
    const words = this.words;
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, true);
    let [a, b, c, d] = this.state;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const sum = (a + f + MD5_K[i] + words[g]) | 0;
      const shift = MD5_S[round * 4 + i % 4];
      const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = d; d = c; c = b; b = next;
    }
    this.state[0] += a; this.state[1] += b; this.state[2] += c; this.state[3] += d;
  }

  update(data: Uint8Array): void {
    this.bytes += data.length;
    let at = 0;
    if (this.used) {
      const n = Math.min(64 - this.used, data.length);
      this.tail.set(data.subarray(0, n), this.used); this.used += n; at += n;
      if (this.used === 64) { this.block(this.tail, 0); this.used = 0; }
    }
    while (at + 64 <= data.length) { this.block(data, at); at += 64; }
    if (at < data.length) { this.tail.set(data.subarray(at), 0); this.used = data.length - at; }
  }

  digest(): Uint8Array {
    const bitLength = BigInt(this.bytes) * 8n;
    const padding = new Uint8Array(this.used < 56 ? 64 - this.used : 128 - this.used);
    padding[0] = 0x80;
    new DataView(padding.buffer).setBigUint64(padding.length - 8, bitLength, true);
    this.update(padding);
    const result = new Uint8Array(16);
    const view = new DataView(result.buffer);
    this.state.forEach((word, i) => view.setUint32(i * 4, word, true));
    return result;
  }
}

type FlacFormats = { s16: number; s16p: number; s32: number; s32p: number };
/** Hash the original integer samples, before conversion or resampling. */
export class FlacIntegrity {
  private hash = new StreamingMd5();
  private available: boolean;
  constructor(private bits: number, private channels: number, private expected: Uint8Array, private formats: FlacFormats) {
    this.available = bits >= 4 && bits <= 32 && channels >= 1 && channels <= 2 && expected.length === 16 && expected.some(byte => byte !== 0);
  }
  add(frame: Frame): void {
    if (!this.available) return;
    const s16 = frame.format === this.formats.s16 || frame.format === this.formats.s16p;
    const s32 = frame.format === this.formats.s32 || frame.format === this.formats.s32p;
    const planar = frame.format === this.formats.s16p || frame.format === this.formats.s32p;
    const width = s16 ? 16 : s32 ? 32 : 0;
    const count = frame.nb_samples ?? 0;
    const data: unknown = frame.data;
    const planes: unknown[] = planar && Array.isArray(data) ? data : [data];
    const valid = width >= this.bits && Number.isInteger(count) && count > 0 && planes.length === (planar ? this.channels : 1)
      && planes.every(plane => (s16 ? plane instanceof Int16Array : plane instanceof Int32Array) && (plane as Int16Array | Int32Array).length === count * (planar ? 1 : this.channels));
    if (!valid) { this.available = false; return; }
    const bytesPerSample = Math.ceil(this.bits / 8);
    const packed = new Uint8Array(count * this.channels * bytesPerSample);
    let at = 0;
    for (let i = 0; i < count; i++) for (let channel = 0; channel < this.channels; channel++) {
      const plane = planes[planar ? channel : 0] as Int16Array | Int32Array;
      let value = plane[planar ? i : i * this.channels + channel] >> (width - this.bits);
      for (let byte = 0; byte < bytesPerSample; byte++) { packed[at++] = value & 255; value >>= 8; }
    }
    this.hash.update(packed);
  }
  result(): 'verified' | 'mismatch' | 'unavailable' {
    if (!this.available) return 'unavailable';
    return this.hash.digest().every((byte, i) => byte === this.expected[i]) ? 'verified' : 'mismatch';
  }
}

/** Read bounded RIFF headers, not audio data; unknown layouts are warned, not guessed. */
export async function inspectWav(file: Blob): Promise<{ samples: number | null; warnings: string[] }> {
  const read = async (at: number, n: number) => new Uint8Array(await file.slice(at, at + n).arrayBuffer());
  const match = (b: Uint8Array, at: number, text: string) => at + text.length <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
  const bad = () => new ConversionError('WAV 파일의 청크 또는 샘플 데이터가 잘렸거나 손상되었습니다. 원본을 확인해 주세요.');
  const head = await read(0, 12);
  if (head.length !== 12 || !match(head, 8, 'WAVE') || !(match(head, 0, 'RIFF') || match(head, 0, 'RF64'))) throw bad();
  const rf64 = match(head, 0, 'RF64');
  let end = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true) + 8;
  let rfData: number | null = null;
  let rfSamples = 0n;
  if (rf64) {
    const ds = await read(12, 36);
    if (ds.length < 36 || !match(ds, 0, 'ds64')) throw bad();
    const dv = new DataView(ds.buffer, ds.byteOffset, ds.byteLength);
    if (dv.getUint32(4, true) < 28) throw bad();
    const riffSize = dv.getBigUint64(8, true), dataSize = dv.getBigUint64(16, true);
    if (riffSize > BigInt(Number.MAX_SAFE_INTEGER - 8) || dataSize > BigInt(Number.MAX_SAFE_INTEGER)) throw bad();
    end = Number(riffSize) + 8;
    rfData = Number(dataSize);
    rfSamples = dv.getBigUint64(24, true);
  }
  if (end < 12 || end > file.size) throw bad();
  let at = 12, chunks = 0, blockAlign = 0, pcm = false, incomplete = false;
  let fmtCount = 0, clearPcmAlignment = false;
  const dataSizes: number[] = [];
  while (at < end) {
    if (++chunks > 4096) { incomplete = true; break; }
    const h = await read(at, Math.min(8, end - at));
    if (h.length < 8) throw bad();
    let size = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(4, true);
    if (rf64 && size === 0xffffffff) {
      if (match(h, 0, 'data') && rfData !== null && !dataSizes.length) size = rfData;
      else { incomplete = true; break; } // An RF64 table entry is needed for this unusual chunk.
    }
    const rawEnd = at + 8 + size;
    if (!Number.isSafeInteger(rawEnd) || rawEnd > end || rawEnd > file.size) throw bad();
    // Some otherwise usable WAV writers omit a final odd-byte pad.
    const next = rawEnd + (size % 2 && rawEnd < end ? 1 : 0);
    if (next > end) throw bad();
    if (match(h, 0, 'fmt ')) {
      fmtCount++;
      const fmt = await read(at + 8, Math.min(size, 40));
      if (fmt.length < 16) throw bad();
      const v = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
      const tag = v.getUint16(0, true);
      blockAlign = v.getUint16(12, true);
      pcm = tag === 1 || tag === 3;
      // WAVE_FORMAT_EXTENSIBLE PCM/float GUID: 0000000{1,3}-0000-0010-8000-00aa00389b71.
      if (tag === 0xfffe && fmt.length >= 40 && v.getUint16(16, true) >= 22) {
        const guidTail = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        const subtype = v.getUint32(24, true);
        pcm = (subtype === 1 || subtype === 3) && guidTail.every((byte, i) => fmt[28 + i] === byte);
      }
      const channels = v.getUint16(2, true), bits = v.getUint16(14, true);
      clearPcmAlignment = pcm && channels > 0 && bits > 0 && blockAlign === channels * Math.ceil(bits / 8);
    }
    if (match(h, 0, 'data')) dataSizes.push(size);
    at = next;
  }
  if (pcm && (!blockAlign || dataSizes.some(size => size % blockAlign !== 0))) throw bad();
  const clearRfPcm = fmtCount === 1 && clearPcmAlignment;
  const samples = !incomplete && pcm && blockAlign && dataSizes.length === 1 && (!rfSamples || clearRfPcm) ? dataSizes[0] / blockAlign : null;
  const warnings = samples === null ? ['WAV 원본의 전체 샘플 수를 확인할 수 없어 길이 검증이 제한됩니다.'] : [];
  if (rfSamples) {
    if (samples === null || !clearRfPcm || rfSamples > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(samples)) {
      warnings.push('RF64 ds64에 선언된 샘플 수와 실제 샘플 수의 일치 여부를 확인할 수 없습니다.');
    } else if (Number(rfSamples) !== samples) {
      throw new ConversionError('RF64 ds64의 샘플 수와 PCM 데이터 크기가 일치하지 않습니다. 원본이 손상되었는지 확인해 주세요.');
    }
  }
  return { samples, warnings };
}

/** Libav returns packed FLT as Float32Array and planar FLTP as Float32Array[]. */
export function checkFloatFrame(frame: Frame, channels: number, flt: number, fltp: number): void {
  if (frame.format !== flt && frame.format !== fltp) return;
  const samples = frame.nb_samples;
  const planes: unknown = frame.format === fltp ? frame.data : [frame.data];
  if (typeof samples !== 'number' || !Number.isInteger(samples) || samples <= 0 || !Array.isArray(planes) || planes.length !== (frame.format === fltp ? channels : 1)) {
    throw new ConversionError('디코딩된 부동소수점 오디오 데이터를 확인할 수 없습니다. 원본을 확인해 주세요.');
  }
  const planeLength = frame.format === fltp ? samples : samples * channels;
  for (const plane of planes) {
    if (!(plane instanceof Float32Array) || plane.length !== planeLength) throw new ConversionError('디코딩된 부동소수점 오디오 데이터를 확인할 수 없습니다. 원본을 확인해 주세요.');
    for (const sample of plane) {
      if (!Number.isFinite(sample)) throw new ConversionError('원본에 NaN 또는 Infinity 오디오 샘플이 있습니다. 원본을 수정한 후 다시 변환해 주세요.');
      if (sample < -1 || sample > 1) throw new ConversionError('원본에 0 dBFS를 초과하는 부동소수점 오디오 샘플이 있어 클리핑을 방지하기 위해 중단했습니다. 원본 음량을 조정한 후 다시 변환해 주세요.');
    }
  }
}

/** Random-access writes preserve muxer header rewrites, without a file-sized copy. */
export class ChunkWriter {
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private length = 0;
  overflow = false;

  write(position: number, data: Uint8Array | Int8Array): void {
    const end = position + data.byteLength;
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(end) || end > MAX_OUTPUT) {
      this.overflow = true;
      throw new ConversionError(OUTPUT_TOO_LARGE);
    }
    this.length = Math.max(this.length, end);
    while (this.chunks.length < Math.ceil(end / CHUNK_SIZE)) this.chunks.push(new Uint8Array(CHUNK_SIZE));
    let i = 0;
    while (i < data.length) {
      const absolute = position + i;
      const offset = absolute % CHUNK_SIZE;
      const n = Math.min(data.length - i, CHUNK_SIZE - offset);
      this.chunks[Math.floor(absolute / CHUNK_SIZE)].set(data.subarray(i, i + n), offset);
      i += n;
    }
  }

  blob(type: string): Blob {
    const parts = this.chunks.map((chunk, i) => chunk.subarray(0, Math.min(CHUNK_SIZE, this.length - i * CHUNK_SIZE)));
    return new Blob(parts, { type });
  }
}

function progress(message: string): void {
  self.postMessage({ type: 'progress', message });
}

async function sniff(file: File): Promise<'mp3' | 'wav' | 'flac'> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const match = (at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
  if ((match(0, 'RIFF') || match(0, 'RF64')) && match(8, 'WAVE')) {
    // Ordinary RIFF files declare their exact total size. Reject obvious truncation.
    if (match(0, 'RIFF')) {
      const size = new DataView(b.buffer).getUint32(4, true) + 8;
      if (size > file.size) throw new ConversionError('WAV 파일이 잘렸거나 손상되었습니다. 원본을 확인해 주세요.');
    }
    return 'wav';
  }
  if (match(0, 'fLaC')) return 'flac';
  // ID3-tagged MP3 or a raw MPEG audio frame. Demuxer and decoder still validate the content.
  if (match(0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  throw new ConversionError('지원하지 않는 파일이거나 손상된 파일입니다. MP3, WAV, FLAC 파일을 선택해 주세요.');
}

async function flacInfo(file: File): Promise<{ samples: number; bits: number; md5: Uint8Array }> {
  // STREAMINFO is the first metadata block; a total of zero means unknown.
  const b = new Uint8Array(await file.slice(0, 42).arrayBuffer());
  if (b.length < 42 || (b[4] & 0x7f) !== 0 || ((b[5] << 16) | (b[6] << 8) | b[7]) !== 34) {
    throw new ConversionError('FLAC 파일의 정보가 잘렸거나 손상되었습니다.');
  }
  const view = new DataView(b.buffer);
  return { samples: (view.getUint32(18) & 15) * 2 ** 32 + view.getUint32(22), bits: ((b[20] & 1) << 4 | b[21] >> 4) + 1, md5: b.slice(26, 42) };
}

async function convert(request: Request): Promise<ConvertedAudio> {
  const { file, format, assetBase } = request;
  if (!file || file.size === 0) throw new ConversionError('원본 파일이 비어 있습니다.');
  if (!['mp3', 'wav', 'flac'].includes(format)) throw new ConversionError('지원하지 않는 출력 형식입니다.');
  progress('원본 오디오 형식을 확인하고 있습니다.');
  const inputFormat = await sniff(file);
  const wav = inputFormat === 'wav' ? await inspectWav(file) : null;
  const flac = inputFormat === 'flac' ? await flacInfo(file) : null;
  const expectedSamples = flac ? flac.samples : wav?.samples ?? 0;
  const mp3Length = inputFormat === 'mp3' ? await mp3DeclaredLength(file) : null;
  const base = new URL(assetBase);
  if (base.origin !== self.location.origin) throw new ConversionError('변환 라이브러리를 안전하게 불러올 수 없습니다.');
  progress('오디오 변환기를 준비하고 있습니다.');
  const url = new URL('libav-6.10.9.0-obsolete.mjs', base).href;
  const imported: { default: LibAVTypes.LibAVWrapper } = await import(/* @vite-ignore */ url);
  // LibAV itself adds the separator before its module filename.
  const libav = await imported.default.LibAV({ noworker: true, base: base.href.replace(/\/$/, '') });
  let inputCreated = false, outputCreated = false;
  let inputContext = 0, dc = 0, dp = 0, df = 0, ec = 0, ef = 0, ep = 0, outContext = 0, outputIO = 0, graph = 0;
  const writer = new ChunkWriter();
  try {
    await libav.mkreadaheadfile('input', file);
    inputCreated = true;
    // The format comes from the file signature, not its name or extension.
    const [ctx, streams] = await libav.ff_init_demuxer_file('input', inputFormat);
    inputContext = ctx;
    const stream = streams.find(s => s.codec_type === libav.AVMEDIA_TYPE_AUDIO);
    if (!stream) throw new ConversionError('읽을 수 있는 오디오가 없습니다. 원본 파일을 확인해 주세요.');
    const channels = await libav.AVCodecParameters_channels(stream.codecpar);
    const sampleRate = await libav.AVCodecParameters_sample_rate(stream.codecpar);
    if (channels > 2) throw new ConversionError(`원본은 ${channels}채널입니다. 3채널 이상은 임의로 합치지 않으므로 변환할 수 없습니다.`);
    if (channels < 1 || !Number.isInteger(sampleRate) || sampleRate <= 0) throw new ConversionError('원본의 채널 또는 샘플레이트를 확인할 수 없습니다.');
    const layout = channels === 1 ? 4 : 3;
    const originalLayout = await libav.AVCodecParameters_channel_layoutmask(stream.codecpar);
    if (channels === 2 && originalLayout && originalLayout !== 3) throw new ConversionError('일반적인 좌우 스테레오가 아닌 채널 배치는 변환할 수 없습니다.');
    const warnings: string[] = [];
    if (wav) warnings.push(...wav.warnings);
    if (flac && !flac.samples) warnings.push('FLAC 원본에 전체 샘플 수가 없어 선언된 전체 길이를 검증할 수 없습니다.');
    const flacIntegrity = flac ? new FlacIntegrity(flac.bits, channels, flac.md5, { s16: libav.AV_SAMPLE_FMT_S16, s16p: libav.AV_SAMPLE_FMT_S16P, s32: libav.AV_SAMPLE_FMT_S32, s32p: libav.AV_SAMPLE_FMT_S32P }) : null;
    if (inputFormat === 'mp3') warnings.push('MP3 원본은 손실 압축되어 있으며, 변환으로 손실된 음질을 복원할 수 없습니다. 이 디코더는 16비트 정밀도로 출력합니다.');
    if (format === 'mp3') warnings.push('MP3 인코딩 지연과 패딩 때문에 재생기와 파일 길이에 따라 재생 길이가 원본과 조금 다를 수 있습니다.');
    let outputRate = sampleRate;
    // 192 kbps is valid for MPEG-1 Layer III only; the lower MPEG-2 rates cannot encode it.
    if (format === 'mp3' && ![32000, 44100, 48000].includes(sampleRate)) {
      outputRate = [32000, 44100, 48000].reduce((best, rate) => Math.abs(rate - sampleRate) < Math.abs(best - sampleRate) ? rate : best);
      warnings.push(`MP3 192kbps에서 지원하지 않는 ${sampleRate}Hz를 ${outputRate}Hz로 리샘플링했습니다.`);
    }
    [, dc, dp, df] = await libav.ff_init_decoder(stream.codec_id, { codecpar: stream.codecpar, time_base: [stream.time_base_num, stream.time_base_den] });
    const sampleFmt = format === 'mp3' ? libav.AV_SAMPLE_FMT_FLTP : libav.AV_SAMPLE_FMT_S32;
    const codecName = format === 'mp3' ? 'libmp3lame' : format === 'wav' ? 'pcm_s24le' : 'flac';
    let frameSize = 0;
    [, ec, ef, ep, frameSize] = await libav.ff_init_encoder(codecName, {
      ctx: { sample_rate: outputRate, sample_fmt: sampleFmt, channel_layout: layout, channels, ...(format === 'mp3' ? { bit_rate: 192000 } : {}) },
      time_base: [1, outputRate],
    });
    await libav.mkwriterdev('output');
    outputCreated = true;
    libav.onwrite = (_name, pos, data) => writer.write(pos, data);
    [outContext, , outputIO] = await libav.ff_init_muxer({ filename: 'output', format_name: format, open: true }, [[ec, 1, outputRate]]);
    let ret = await libav.avformat_write_header(outContext, 0);
    if (ret < 0) throw new ConversionError('출력 파일의 헤더를 만들지 못했습니다.');
    progress('오디오를 변환하고 있습니다. 파일 크기에 따라 시간이 걸릴 수 있습니다.');

    let src = 0, sink = 0, decodedFrames = 0, decodedSamples = 0;
    const processFrames = async (frames: Frame[], finish: boolean) => {
      if (!graph && frames.length) {
        const first = frames[0];
        const actualChannels = libav.ff_channels(first) || channels;
        const actualRate = first.sample_rate || sampleRate;
        const actualLayout = libav.ff_channel_layout(first) || layout;
        if (actualChannels !== channels || actualRate !== sampleRate || (channels === 2 && actualLayout !== 3)) throw new ConversionError('원본의 오디오 채널이나 샘플레이트를 안전하게 유지할 수 없습니다.');
        [graph, src, sink] = await libav.ff_init_filter_graph('anull',
          { sample_rate: sampleRate, sample_fmt: first.format, channel_layout: layout, time_base: [1, sampleRate] },
          { sample_rate: outputRate, sample_fmt: sampleFmt, channel_layout: layout, ...(frameSize ? { frame_size: frameSize } : {}) });
      }
      if (!graph) return;
      decodedFrames += frames.length;
      for (const frame of frames) {
        decodedSamples += frame.nb_samples || 0;
        if ((frame.sample_rate && frame.sample_rate !== sampleRate) || (libav.ff_channels(frame) && libav.ff_channels(frame) !== channels) || (channels === 2 && libav.ff_channel_layout(frame) && libav.ff_channel_layout(frame) !== 3)) {
          throw new ConversionError('변환 중 원본 오디오의 채널이나 샘플레이트가 변경되어 중단했습니다.');
        }
        checkFloatFrame(frame, channels, libav.AV_SAMPLE_FMT_FLT, libav.AV_SAMPLE_FMT_FLTP);
        flacIntegrity?.add(frame);
      }
      const filtered = await libav.ff_filter_multi(src, sink, df, frames, finish);
      const packets = await libav.ff_encode_multi(ec, ef, ep, filtered, finish);
      if (packets.length) await libav.ff_write_multi(outContext, ep, packets);
      if (writer.overflow) throw new ConversionError(OUTPUT_TOO_LARGE);
    };

    while (true) {
      const [status, byStream] = await libav.ff_read_frame_multi(inputContext, dp, { limit: READ_LIMIT });
      const packets = byStream[stream.index] || [];
      const frames = await libav.ff_decode_multi(dc, dp, df, packets, false);
      await processFrames(frames, false);
      if (status === libav.AVERROR_EOF) break;
      if (status !== -libav.EAGAIN) throw new ConversionError('원본을 읽는 중 오류가 발생했습니다. 파일이 손상되었는지 확인해 주세요.');
    }
    progress('남은 오디오와 파일 헤더를 마무리하고 있습니다.');
    const finalFrames = await libav.ff_decode_multi(dc, dp, df, [], true);
    await processFrames(finalFrames, true);
    if (!decodedFrames) throw new ConversionError('원본에 변환할 수 있는 오디오가 없습니다.');
    if (expectedSamples && decodedSamples !== expectedSamples) throw new ConversionError(`${inputFormat.toUpperCase()} 파일이 잘렸거나 손상되어 전체 오디오를 읽지 못했습니다.`);
    if (flacIntegrity) {
      const integrity = flacIntegrity.result();
      if (integrity === 'mismatch') throw new ConversionError('FLAC 원본의 오디오 체크섬이 일치하지 않습니다. 파일이 손상되었는지 확인해 주세요.');
      if (integrity === 'unavailable') warnings.push('FLAC 원본의 오디오 무결성(MD5)을 검증할 수 없습니다. 파일이 손상되었을 수 있으므로 결과를 청취해 확인해 주세요.');
      else warnings.push('FLAC 프레임 CRC는 검증하지 않아 디코딩된 오디오에 영향을 주지 않는 일부 손상을 감지하지 못할 수 있습니다.');
    }
    if (inputFormat === 'mp3') {
      const lengthStatus = mp3LengthStatus(mp3Length, decodedSamples, sampleRate);
      if (lengthStatus === 'short') throw new ConversionError('MP3 파일이 잘렸거나 손상되어 선언된 데이터 또는 오디오 길이와 일치하지 않습니다. 원본을 확인해 주세요.');
      if (lengthStatus === 'unknown') warnings.push(MP3_UNVERIFIED);
    }
    ret = await libav.av_write_trailer(outContext);
    if (ret < 0) throw new ConversionError('출력 파일을 마무리하지 못했습니다.');
    if (writer.overflow) throw new ConversionError(OUTPUT_TOO_LARGE);
    const mime = format === 'mp3' ? 'audio/mpeg' : format === 'wav' ? 'audio/wav' : 'audio/flac';
    return { blob: writer.blob(mime), warnings, inputChannels: channels, outputChannels: channels, inputSampleRate: sampleRate, outputSampleRate: outputRate };
  } catch (error) {
    if (writer.overflow) throw new ConversionError(OUTPUT_TOO_LARGE);
    throw error;
  } finally {
    // Cleanup is best-effort even if a codec operation itself failed.
    const safely = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* retain original error */ } };
    if (graph) await safely(() => libav.avfilter_graph_free_js(graph));
    if (outContext) await safely(() => libav.ff_free_muxer(outContext, outputIO));
    if (ec) await safely(() => libav.ff_free_encoder(ec, ef, ep));
    if (dc) await safely(() => libav.ff_free_decoder(dc, dp, df));
    if (inputContext) await safely(() => libav.avformat_close_input_js(inputContext));
    if (outputCreated) await safely(() => libav.unlink('output'));
    if (inputCreated) await safely(() => libav.unlinkreadaheadfile('input'));
    libav.terminate();
  }
}

let active = false;
if (typeof self !== 'undefined' && typeof document === 'undefined') self.onmessage = async (event: MessageEvent<Request>) => {
  if (event.data?.type !== 'convert') return;
  if (active) {
    self.postMessage({ type: 'error', message: '다른 파일을 변환 중입니다.' });
    return;
  }
  active = true;
  try {
    const result = await convert(event.data);
    self.postMessage({ type: 'success', result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof ConversionError ? error.message : '오디오를 변환하지 못했습니다. 파일이 손상되었거나 지원하지 않는 형식인지 확인해 주세요.' });
  } finally {
    active = false;
  }
};
