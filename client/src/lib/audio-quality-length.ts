export type Mp3Length = { samples: number; sampleRate: number; samplesPerFrame: number; gaplessSamples?: number };
/** Decode only legal, non-free-format Layer III headers. */
export function mp3FrameHeader(b: Uint8Array, at: number): { sampleRate: number; samplesPerFrame: number; size: number; sideInfo: number; crc: boolean; version: number } | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3;
  const layer = (b[at + 1] >> 1) & 3;
  const bitrateIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3 || (b[at + 3] & 3) === 2) return null;
  const mpeg1 = version === 3;
  const bitrates = mpeg1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRate = [44100, 48000, 32000][rateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const size = Math.floor((mpeg1 ? 144 : 72) * bitrates[bitrateIndex] * 1000 / sampleRate) + ((b[at + 2] >> 1) & 1);
  const mono = (b[at + 3] >> 6) === 3;
  return { sampleRate, samplesPerFrame: mpeg1 ? 1152 : 576, size, sideInfo: mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17), crc: !(b[at + 1] & 1), version };
}

/** Parse a Xing/Info or VBRI count only at the expected offset in the first frame. */
export function parseMp3Length(b: Uint8Array): Mp3Length | null {
  const text = (at: number, s: string) => at >= 0 && at + s.length <= b.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  const u32 = (at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, false);
  for (let at = 0; at + 4 <= b.length; at++) {
    const header = mp3FrameHeader(b, at);
    if (!header || at + header.size > b.length) continue;
    // A scan through leading junk must not mistake a random sync for the first frame.
    // The frame exactly at the post-ID3 start is usable even if its successor is damaged.
    const nextAt = at + header.size;
    if (at !== 0 && nextAt + 4 <= b.length) {
      const next = mp3FrameHeader(b, nextAt);
      if (!next || next.version !== header.version || next.sampleRate !== header.sampleRate) continue;
    } else if (at !== 0) continue;
    const end = at + header.size;
    for (const xing of [at + 4 + header.sideInfo, ...(header.crc ? [at + 6 + header.sideInfo] : [])]) {
      if (xing + 12 > end || !(text(xing, 'Xing') || text(xing, 'Info'))) continue;
      const flags = u32(xing + 4);
      // The known optional fields must fit in this frame, and a frame count must be present.
      const length = 8 + ((flags & 1) ? 4 : 0) + ((flags & 2) ? 4 : 0) + ((flags & 4) ? 100 : 0) + ((flags & 8) ? 4 : 0);
      if ((flags & ~15) || !(flags & 1) || xing + length > end) return null;
      const count = u32(xing + 8);
      if (!count) return null;
      const samples = count * header.samplesPerFrame;
      // LAME-compatible extensions encode delay and padding in two 12-bit fields.
      // Only interpret recognized encoder tags with all those bytes inside the frame.
      const encoder = xing + length;
      let gaplessSamples: number | undefined;
      if (encoder + 24 <= end && (text(encoder, 'LAME') || text(encoder, 'Lavc') || text(encoder, 'Lavf'))) {
        const delay = (b[encoder + 21] << 4) | (b[encoder + 22] >> 4);
        const padding = ((b[encoder + 22] & 15) << 8) | b[encoder + 23];
        if (delay + padding < samples) gaplessSamples = delay + padding;
      }
      return { samples, sampleRate: header.sampleRate, samplesPerFrame: header.samplesPerFrame, ...(gaplessSamples === undefined ? {} : { gaplessSamples }) };
    }
    const vbri = at + 36;
    if (vbri + 18 <= end && text(vbri, 'VBRI')) {
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const count = u32(vbri + 14);
      if (view.getUint16(vbri + 4, false) === 1 && u32(vbri + 10) >= header.size && count) {
        return { samples: count * header.samplesPerFrame, sampleRate: header.sampleRate, samplesPerFrame: header.samplesPerFrame };
      }
    }
    // Only the first valid audio frame can carry a reliable duration declaration.
    return null;
  }
  return null;
}

export async function mp3DeclaredLength(file: Blob): Promise<Mp3Length | null> {
  const tag = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  let offset = 0;
  if (tag.length >= 3 && tag[0] === 0x49 && tag[1] === 0x44 && tag[2] === 0x33) {
    if (tag.length < 10 || tag[3] < 2 || tag[3] > 4 || [...tag.subarray(6, 10)].some(n => n & 0x80)) return null;
    offset = 10 + tag[6] * 2 ** 21 + tag[7] * 2 ** 14 + tag[8] * 2 ** 7 + tag[9];
    if (offset > file.size) return null;
  }
  // Jump over even a very large ID3 tag; never read it or the whole audio file.
  // Extra bytes allow a maximum-size Layer III frame and the following header.
  const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 64 * 1024 + 1500)).arrayBuffer());
  return parseMp3Length(bytes);
}

/** Use declared gapless trim where available, otherwise the two 12-bit maxima. */
export function mp3LengthStatus(declared: Mp3Length | null, decodedSamples: number, sampleRate: number): 'unknown' | 'short' | 'ok' {
  if (!declared || declared.sampleRate !== sampleRate) return 'unknown';
  const tolerance = (declared.gaplessSamples ?? 2 * 4095) + 2 * declared.samplesPerFrame;
  if (declared.samples <= tolerance) return 'unknown';
  return decodedSamples < declared.samples - tolerance ? 'short' : 'ok';
}
