import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import LibAV from '@libav.js/variant-obsolete';
import type LibAVTypes from '@libav.js/variant-obsolete';
import { inspectAudioFile } from './audio-quality-file';
import { QualityAccumulator, sourceS32BitDepth } from './audio-quality-stats';

// Two 8 kHz mono 24-bit FLAC fixtures (one second, constant signed limits),
// generated with ffmpeg from PCM and with FLAC padding removed.
const flacPositive = 'ZkxhQwAAACICQAJAAAAMAAAMAfQBcAAAH0DwnVJvYwfJfiPwOI3lOADjhAAALg0AAABMYXZmNjAuMTYuMTAwAQAAABUAAABlbmNvZGVyPUxhdmY2MC4xNi4xMDD/+CQMAJ4Af///7oX/+CQMAZkAf///l+3/+CQMApAAf///HFX/+CQMA5cAf///ZT3/+CQMBIIAf///iyD/+CQMBYUAf///8kj/+CQMBowAf///efD/+CQMB4sAf///AJj/+CQMCKYAf///Jc//+CQMCaEAf///XKf/+CQMCqgAf///1x//+CQMC68Af///rnf/+CQMDLoAf///QGr/+JQMDVcAf///FKg=';
const flacNegative = 'ZkxhQwAAACICQAJAAAAMAAAMAfQBcAAAH0D5T04suCmjZbn/07XqYgmahAAALg0AAABMYXZmNjAuMTYuMTAwAQAAABUAAABlbmNvZGVyPUxhdmY2MC4xNi4xMDD/+CQMAJ4BAAADfI7/+CQMAZkBAAADBeb/+CQMApABAAADjl7/+CQMA5cBAAAD9zb/+CQMBIIBAAADGSv/+CQMBYUBAAADYEP/+CQMBowBAAAD6/v/+CQMB4sBAAADkpP/+CQMCKYBAAADt8T/+CQMCaEBAAADzqz/+CQMCqgBAAADRRT/+CQMC68BAAADPHz/+CQMDLoBAAAD0mH/+JQMDVcBAAADhqM=';
function wav24(sample: number): Blob {
  const count = 8000, b = new Uint8Array(44 + count * 3), v = new DataView(b.buffer);
  const ascii = (at: number, s: string) => b.set(new TextEncoder().encode(s), at);
  ascii(0, 'RIFF'); v.setUint32(4, b.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 24000, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
  ascii(36, 'data'); v.setUint32(40, count * 3, true);
  for (let i = 0; i < count; i++) { b[44 + i * 3] = sample; b[45 + i * 3] = sample >> 8; b[46 + i * 3] = sample >> 16; }
  return new Blob([b]);
}

async function decode(blob: Blob) {
  const inspection = await inspectAudioFile(blob);
  const bits = await sourceS32BitDepth(blob, inspection.format);
  const av = await LibAV.LibAV({ noworker: true });
  let ctx = 0, dc = 0, dp = 0, df = 0;
  try {
    await av.mkreadaheadfile('quality-test', blob);
    const opened = await av.ff_init_demuxer_file('quality-test', inspection.format); ctx = opened[0];
    const stream = opened[1].find(s => s.codec_type === av.AVMEDIA_TYPE_AUDIO)!;
    const rate = await av.AVCodecParameters_sample_rate(stream.codecpar), channels = await av.AVCodecParameters_channels(stream.codecpar);
    [, dc, dp, df] = await av.ff_init_decoder(stream.codec_id, { codecpar: stream.codecpar, time_base: [stream.time_base_num, stream.time_base_den] });
    const acc = new QualityAccumulator(rate, channels, bits);
    let first: number | undefined, firstFormat: number | undefined;
    const consume = (frames: LibAVTypes.Frame[]) => {
      for (const frame of frames) {
        if (first === undefined) {
          firstFormat = frame.format;
          const data = Array.isArray(frame.data) ? frame.data[0] : frame.data;
          first = data[0];
        }
        acc.add(frame);
      }
    };
    while (true) {
      const [status, packets] = await av.ff_read_frame_multi(ctx, dp, { limit: 32768 });
      for (const packet of packets[stream.index] || []) consume(await av.ff_decode_multi(dc, dp, df, [packet], false));
      if (status === av.AVERROR_EOF) break;
      expect(status).toBe(-av.EAGAIN);
    }
    consume(await av.ff_decode_multi(dc, dp, df, [], true));
    return { bits, first, firstFormat, result: acc.finish() };
  } finally {
    if (dc) await av.ff_free_decoder(dc, dp, df);
    if (ctx) await av.avformat_close_input_js(ctx);
    await av.unlinkreadaheadfile('quality-test'); av.terminate();
  }
}

describe('24-bit PCM through LibAV', () => {
  it.each([
    ['WAV positive', wav24(8388607), 2147483392, true],
    ['WAV negative', wav24(-8388608), -2147483648, true],
    ['WAV positive near limit', wav24(8388606), 2147483136, false],
    ['WAV negative near limit', wav24(-8388607), -2147483392, false],
    ['FLAC positive', new Blob([Buffer.from(flacPositive, 'base64')]), 2147483392, true],
    ['FLAC negative', new Blob([Buffer.from(flacNegative, 'base64')]), -2147483648, true],
  ])('%s uses the original bit depth without misidentifying near limits', async (_name, blob, first, clipped) => {
    const decoded = await decode(blob);
    expect(decoded.bits).toBe(24);
    expect([2, 7]).toContain(decoded.firstFormat);
    expect(decoded.first).toBe(first);
    expect(decoded.result.duration).toBe(1);
    expect(decoded.result.issues.some(issue => issue.message.includes('클리핑 의심'))).toBe(clipped);
    expect(decoded.result.issues.some(issue => issue.message.includes('S32') && issue.message.includes('24비트'))).toBe(false);
  }, 30000);
});

async function wavWithJunk(position: 'before' | 'after'): Promise<Blob> {
  const original = new Uint8Array(await wav24(8388607).arrayBuffer());
  const junk = new Uint8Array(4097 * 8);
  for (let i = 0; i < 4097; i++) junk.set([0x4a, 0x55, 0x4e, 0x4b], i * 8);
  const header = original.slice(0, 12);
  new DataView(header.buffer).setUint32(4, original.length + junk.length - 8, true);
  return position === 'before'
    ? new Blob([header, junk, original.slice(12)])
    : new Blob([header, original.slice(12, 36), junk, original.slice(36)]);
}

describe('bounded 24-bit detection limitation', () => {
  it.each(['before', 'after'] as const)('warns when 4097 JUNK chunks %s fmt make the bit depth unknown', async position => {
    const blob = await wavWithJunk(position);
    const decoded = await decode(blob);
    expect(decoded.bits).toBeNull();
    expect([2, 7]).toContain(decoded.firstFormat);
    expect(decoded.first).toBe(2147483392);
    expect(decoded.result.duration).toBe(1);
    expect(decoded.result.issues.some(issue => issue.message.includes('클리핑 의심'))).toBe(false);
    expect(decoded.result.issues).toContainEqual(expect.objectContaining({
      level: 'warning', message: expect.stringMatching(/S32.*24비트.*양의.*놓칠/),
    }));
  }, 30000);
});

function wavOther(type: 's16' | 'float'): Blob {
  const width = type === 's16' ? 2 : 4, count = 8000;
  const b = new Uint8Array(44 + count * width), v = new DataView(b.buffer);
  const ascii = (at: number, s: string) => b.set(new TextEncoder().encode(s), at);
  ascii(0, 'RIFF'); v.setUint32(4, b.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, type === 'float' ? 3 : 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000 * width, true); v.setUint16(32, width, true); v.setUint16(34, width * 8, true);
  ascii(36, 'data'); v.setUint32(40, count * width, true);
  for (let i = 0; i < count; i++) {
    if (type === 's16') v.setInt16(44 + i * width, 1000, true);
    else v.setFloat32(44 + i * width, 0.25, true);
  }
  return new Blob([b]);
}

describe('formats without a 24-bit uncertainty warning', () => {
  it.each([
    ['16-bit WAV', wavOther('s16'), [1, 6]],
    ['float WAV', wavOther('float'), [3, 8]],
    ['MP3', new Blob([readFileSync(new URL('../../public/voice-previews/ko/F1.mp3', import.meta.url))]), [1, 6, 3, 8]],
  ] as const)('%s', async (_name, blob, formats) => {
    const decoded = await decode(blob);
    expect(formats).toContain(decoded.firstFormat);
    expect(decoded.bits).toBe('other');
    expect(decoded.result.issues.some(issue => issue.message.includes('S32') && issue.message.includes('24비트'))).toBe(false);
  }, 30000);
});
