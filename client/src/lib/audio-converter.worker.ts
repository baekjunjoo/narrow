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

async function flacSampleCount(file: File): Promise<number> {
  // STREAMINFO is the first metadata block; a total of zero means unknown.
  const b = new Uint8Array(await file.slice(0, 42).arrayBuffer());
  if (b.length < 42 || (b[4] & 0x7f) !== 0 || ((b[5] << 16) | (b[6] << 8) | b[7]) !== 34) {
    throw new ConversionError('FLAC 파일의 정보가 잘렸거나 손상되었습니다.');
  }
  const view = new DataView(b.buffer);
  return (view.getUint32(18) & 15) * 2 ** 32 + view.getUint32(22);
}

async function convert(request: Request): Promise<ConvertedAudio> {
  const { file, format, assetBase } = request;
  if (!file || file.size === 0) throw new ConversionError('원본 파일이 비어 있습니다.');
  if (!['mp3', 'wav', 'flac'].includes(format)) throw new ConversionError('지원하지 않는 출력 형식입니다.');
  progress('원본 오디오 형식을 확인하고 있습니다.');
  const inputFormat = await sniff(file);
  const expectedSamples = inputFormat === 'flac' ? await flacSampleCount(file) : 0;
  const mp3Length = inputFormat === 'mp3' ? await mp3DeclaredLength(file) : null;
  const base = new URL(assetBase);
  if (base.origin !== self.location.origin) throw new ConversionError('변환 라이브러리를 안전하게 불러올 수 없습니다.');
  progress('오디오 변환기를 준비하고 있습니다.');
  const url = new URL('libav-6.10.9.0-obsolete.mjs', base).href;
  const imported: { default: LibAVTypes.LibAVWrapper } = await import(/* @vite-ignore */ url);
  const libav = await imported.default.LibAV({ noworker: true, base: base.href });
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
    if (expectedSamples && decodedSamples !== expectedSamples) throw new ConversionError('FLAC 파일이 잘렸거나 손상되어 전체 오디오를 읽지 못했습니다.');
    if (inputFormat === 'mp3') {
      const lengthStatus = mp3LengthStatus(mp3Length, decodedSamples, sampleRate);
      if (lengthStatus === 'short') throw new ConversionError('MP3 파일이 잘렸거나 손상되어 선언된 길이보다 오디오가 크게 부족합니다. 원본을 확인해 주세요.');
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
