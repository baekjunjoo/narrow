import type LibAVTypes from '@libav.js/variant-obsolete';
import type { QualityReport } from './audio-quality';
import { inspectAudioFile } from './audio-quality-file';
import { mp3LengthStatus } from './audio-quality-length';
import { QualityAccumulator } from './audio-quality-stats';

type Request = { type: 'analyze'; blob: Blob; assetBase: string };
const READ_LIMIT = 32 * 1024;
const MAX_PACKET = 8 * 1024 * 1024;

function progress(message: string): void { self.postMessage({ type: 'progress', message }); }

async function analyze(request: Request): Promise<QualityReport> {
  const { blob, assetBase } = request;
  if (!(blob instanceof Blob) || !blob.size) throw new Error('검사할 오디오 파일이 비어 있습니다.');
  progress('파일 형식과 선언된 길이를 확인하고 있습니다.');
  const inspection = await inspectAudioFile(blob);
  const base = new URL(assetBase);
  if (base.origin !== self.location.origin) throw new Error('검사 라이브러리를 안전하게 불러올 수 없습니다.');
  progress('로컬 오디오 검사기를 준비하고 있습니다.');
  // Only same-origin app assets are fetched. The user's Blob is never sent to a network endpoint.
  const url = new URL('libav-6.10.9.0-obsolete.mjs', base).href;
  const imported: { default: LibAVTypes.LibAVWrapper } = await import(/* @vite-ignore */ url);
  const libav = await imported.default.LibAV({ noworker: true, base: base.href });
  let inputCreated = false, inputContext = 0, dc = 0, dp = 0, df = 0;
  try {
    await libav.mkreadaheadfile('quality-input', blob);
    inputCreated = true;
    const [ctx, streams] = await libav.ff_init_demuxer_file('quality-input', inspection.format);
    inputContext = ctx;
    const stream = streams.find(s => s.codec_type === libav.AVMEDIA_TYPE_AUDIO);
    if (!stream) throw new Error('읽을 수 있는 오디오 트랙이 없습니다.');
    const channels = await libav.AVCodecParameters_channels(stream.codecpar);
    const sampleRate = await libav.AVCodecParameters_sample_rate(stream.codecpar);
    if (channels > 2) throw new Error(`원본은 ${channels}채널입니다. 3채널 이상의 오디오는 임의로 합치지 않으므로 검사할 수 없습니다.`);
    if (channels < 1 || !Number.isInteger(sampleRate) || sampleRate < 10) throw new Error('원본의 채널 또는 샘플레이트를 확인할 수 없습니다.');
    const layout = channels === 1 ? 4 : 3;
    const originalLayout = await libav.AVCodecParameters_channel_layoutmask(stream.codecpar);
    if (channels === 2 && originalLayout && originalLayout !== 3) throw new Error('일반적인 좌우 스테레오가 아닌 채널 배치는 검사할 수 없습니다.');
    [, dc, dp, df] = await libav.ff_init_decoder(stream.codec_id, { codecpar: stream.codecpar, time_base: [stream.time_base_num, stream.time_base_den] });
    const stats = new QualityAccumulator(sampleRate, channels);
    let samples = 0, mp3Int16 = false, emptyReads = 0, packetCount = 0;
    const consume = (frames: LibAVTypes.Frame[]) => {
      for (const frame of frames) {
        const actualChannels = libav.ff_channels(frame) || channels;
        const actualRate = frame.sample_rate || sampleRate;
        const actualLayout = libav.ff_channel_layout(frame) || layout;
        if (actualChannels !== channels || actualRate !== sampleRate || (channels === 2 && actualLayout !== 3)) throw new Error('검사 중 채널 또는 샘플레이트가 변경되어 중단했습니다.');
        stats.add(frame);
        samples += frame.nb_samples || 0;
        if (inspection.format === 'mp3' && (frame.format === libav.AV_SAMPLE_FMT_S16 || frame.format === libav.AV_SAMPLE_FMT_S16P)) mp3Int16 = true;
      }
    };
    progress('오디오를 순차 디코딩하며 음량과 저음량 구간을 검사하고 있습니다.');
    while (true) {
      const [status, byStream] = await libav.ff_read_frame_multi(inputContext, dp, { limit: READ_LIMIT });
      const packets = byStream[stream.index] || [];
      for (const packet of packets) {
        if ((packet.flags || 0) & libav.AV_PKT_FLAG_CORRUPT) throw new Error('손상된 오디오 패킷이 감지되었습니다.');
        if (packet.data.byteLength > MAX_PACKET) throw new Error('오디오 패킷이 너무 커서 안전하게 검사할 수 없습니다.');
        // Decode one packet at a time to avoid collecting file-sized PCM arrays.
        consume(await libav.ff_decode_multi(dc, dp, df, [packet], false));
        if (++packetCount % 4096 === 0) progress('오디오를 순차 검사하고 있습니다. 긴 파일은 시간이 걸릴 수 있습니다.');
      }
      if (status === libav.AVERROR_EOF) break;
      if (status !== -libav.EAGAIN) throw new Error('원본을 읽는 중 오류가 발생했습니다. 파일이 손상되었는지 확인해 주세요.');
      emptyReads = packets.length ? 0 : emptyReads + 1;
      if (emptyReads > 128) throw new Error('원본 오디오를 더 이상 읽을 수 없어 검사를 중단했습니다.');
    }
    progress('남은 오디오와 검사 결과를 확인하고 있습니다.');
    consume(await libav.ff_decode_multi(dc, dp, df, [], true));
    if (!samples) throw new Error('읽을 수 있는 오디오 샘플이 없습니다.');
    if (inspection.samples !== null && samples !== inspection.samples) {
      throw new Error(`${inspection.format.toUpperCase()} 파일이 잘렸거나 손상되어 선언된 샘플 수와 실제 디코딩 길이가 일치하지 않습니다.`);
    }
    const result = stats.finish();
    for (const message of inspection.warnings) result.issues.push({ level: 'warning', message });
    if (inspection.format === 'mp3') {
      const status = mp3LengthStatus(inspection.mp3, samples, sampleRate);
      if (status === 'short') throw new Error('MP3가 잘렸거나 손상되어 선언된 길이보다 디코딩된 오디오가 크게 부족합니다.');
      if (status === 'unknown') result.issues.push({ level: 'warning', message: 'MP3의 신뢰할 수 있는 선언 길이가 없거나 너무 짧아 원본 전체 길이를 검증할 수 없습니다.' });
      else result.issues.push({ level: 'info', message: 'MP3 선언 프레임 수와 디코딩 길이를 지연·패딩 허용 오차 내에서 비교했습니다. 모든 손상을 검출하는 검사는 아닙니다.' });
      if (mp3Int16) result.issues.push({ level: 'warning', message: 'MP3 디코더가 16비트 정수 샘플을 반환해 피크가 이미 포화되었을 수 있습니다. 원본의 true peak나 확정적인 클리핑 여부는 알 수 없습니다.' });
    }
    result.issues.push({ level: 'info', message: '디코더가 감지하지 못하는 손상이나 누락도 있을 수 있습니다. 이 검사는 완전한 무결성 검증이 아닙니다.' });
    return result;
  } finally {
    const safely = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* preserve the real error */ } };
    if (dc) await safely(() => libav.ff_free_decoder(dc, dp, df));
    if (inputContext) await safely(() => libav.avformat_close_input_js(inputContext));
    if (inputCreated) await safely(() => libav.unlinkreadaheadfile('quality-input'));
    try { libav.terminate(); } catch { /* preserve the real error */ }
  }
}

let active = false;
self.onmessage = async (event: MessageEvent<Request>) => {
  if (event.data?.type !== 'analyze') return;
  if (active) { self.postMessage({ type: 'error', message: '다른 파일을 검사 중입니다.' }); return; }
  active = true;
  try {
    const result = await analyze(event.data);
    self.postMessage({ type: 'success', result });
  } catch (error) {
    // Decode errors must reach the UI rather than masquerade as a successful report.
    const detail = error instanceof Error ? error.message : '';
    const explanation = /[가-힣]/.test(detail) ? detail : `파일을 읽거나 디코딩하지 못했습니다. 손상되었거나 지원되지 않는 형식일 수 있습니다.${detail ? ` (${detail})` : ''}`;
    self.postMessage({ type: 'error', message: `오디오 검사 실패: ${explanation}` });
  } finally { active = false; }
};
