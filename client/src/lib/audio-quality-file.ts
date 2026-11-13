import { mp3DeclaredLength, mp3FrameHeader, type Mp3Length } from './audio-quality-length';

export type FileInspection = { format: 'mp3' | 'wav' | 'flac'; samples: number | null; mp3: Mp3Length | null; warnings: string[] };
const bytes = async (blob: Blob, start: number, end: number) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
const ascii = (b: Uint8Array, at: number, text: string) => at + text.length <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** Inspects only bounded headers/chunk headers, never materializes the source Blob. */
export async function inspectAudioFile(blob: Blob): Promise<FileInspection> {
  if (!blob.size) throw new Error('원본 파일이 비어 있습니다.');
  const head = await bytes(blob, 0, 12);
  if ((ascii(head, 0, 'RIFF') || ascii(head, 0, 'RF64')) && ascii(head, 8, 'WAVE')) return inspectWav(blob, head);
  if (ascii(head, 0, 'fLaC')) {
    const b = await bytes(blob, 0, 42);
    if (b.length < 42 || (b[4] & 0x7f) !== 0 || ((b[5] << 16) | (b[6] << 8) | b[7]) !== 34) throw new Error('FLAC STREAMINFO가 잘렸거나 손상되었습니다.');
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const samples = (v.getUint32(18) & 15) * 2 ** 32 + v.getUint32(22);
    return { format: 'flac', samples: samples || null, mp3: null, warnings: samples ? [] : ['FLAC에 전체 샘플 수가 없어 원본 전체 길이를 검증할 수 없습니다.'] };
  }
  let offset = 0;
  if (ascii(head, 0, 'ID3')) {
    if (head.length < 10 || head[3] < 2 || head[3] > 4 || [...head.subarray(6, 10)].some(n => n & 0x80)) throw new Error('MP3 ID3 헤더가 손상되었습니다.');
    offset = 10 + head[6] * 2 ** 21 + head[7] * 2 ** 14 + head[8] * 2 ** 7 + head[9];
    if (offset > blob.size) throw new Error('MP3 태그가 잘렸거나 손상되었습니다.');
  } else if (!(head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
    throw new Error('지원하지 않는 파일이거나 손상된 파일입니다. MP3, WAV, FLAC 파일을 선택해 주세요.');
  }
  const probe = await bytes(blob, offset, Math.min(blob.size, offset + 64 * 1024 + 1500));
  let found = false;
  for (let at = 0; at + 4 <= probe.length; at++) {
    const frame = mp3FrameHeader(probe, at);
    if (!frame || at + frame.size > probe.length) continue;
    if (at) {
      const next = mp3FrameHeader(probe, at + frame.size);
      if (!next || next.sampleRate !== frame.sampleRate || next.version !== frame.version) continue;
    }
    found = true; break;
  }
  if (!found) throw new Error('유효한 MP3 오디오 프레임을 찾지 못했습니다. 파일이 손상되었을 수 있습니다.');
  return { format: 'mp3', samples: null, mp3: await mp3DeclaredLength(blob), warnings: [] };
}

async function inspectWav(blob: Blob, head: Uint8Array): Promise<FileInspection> {
  const rf64 = ascii(head, 0, 'RF64');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let end = view.getUint32(4, true) + 8;
  let rfData: number | null = null;
  if (rf64) {
    const ds = await bytes(blob, 12, 48);
    if (ds.length < 36 || !ascii(ds, 0, 'ds64') || new DataView(ds.buffer, ds.byteOffset, ds.byteLength).getUint32(4, true) < 28) throw new Error('RF64 크기 정보가 잘렸거나 손상되었습니다.');
    const dv = new DataView(ds.buffer, ds.byteOffset, ds.byteLength);
    const riffSize = dv.getBigUint64(8, true), dataSize = dv.getBigUint64(16, true);
    if (riffSize > BigInt(Number.MAX_SAFE_INTEGER - 8) || dataSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('RF64 길이를 안전하게 확인할 수 없습니다.');
    end = Number(riffSize) + 8; rfData = Number(dataSize);
  }
  if (end > blob.size || end < 12) throw new Error('WAV RIFF 파일이 잘렸거나 손상되었습니다.');
  let at = 12, chunks = 0, blockAlign = 0, tag = 0, dataSize: number | null = null;
  let incompleteScan = false;
  while (at < end) {
    if (++chunks > 4096) { incompleteScan = true; break; }
    const h = await bytes(blob, at, Math.min(at + 8, end));
    if (h.length < 8) throw new Error('WAV 청크 헤더가 잘렸거나 손상되었습니다.');
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(4, true);
    if (rf64 && ascii(h, 0, 'data') && size === 0xffffffff && rfData !== null) size = rfData;
    const next = at + 8 + size + (size % 2);
    if (!Number.isSafeInteger(next) || next > end) throw new Error('WAV 청크가 잘렸거나 선언된 RIFF 길이를 벗어났습니다.');
    if (ascii(h, 0, 'fmt ')) {
      const fmt = await bytes(blob, at + 8, at + 8 + Math.min(size, 16));
      if (fmt.length < 16) throw new Error('WAV 형식 정보가 잘렸거나 손상되었습니다.');
      const fv = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
      tag = fv.getUint16(0, true); blockAlign = fv.getUint16(12, true);
    }
    if (ascii(h, 0, 'data')) {
      if (dataSize !== null) incompleteScan = true; // Decoder behavior for multiple data chunks varies.
      else dataSize = size;
    }
    at = next;
  }
  const warnings: string[] = [];
  let samples: number | null = null;
  if (!incompleteScan && dataSize !== null && blockAlign > 0 && (tag === 1 || tag === 3)) {
    if (dataSize % blockAlign) throw new Error('WAV 데이터가 샘플 프레임 중간에서 잘렸습니다.');
    samples = dataSize / blockAlign;
  } else warnings.push('WAV 원본의 전체 샘플 수를 확인할 수 없어 길이 검증이 제한됩니다.');
  if (incompleteScan) warnings.push('WAV의 모든 청크를 확인하지 못했습니다.');
  return { format: 'wav', samples, mp3: null, warnings };
}
