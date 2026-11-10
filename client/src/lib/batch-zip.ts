export interface ZipEntry {
  name: string;
  blob: Blob;
}

/** Maximum size of the complete ZIP, including all ZIP metadata. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

// Avoid the ZIP64 sentinel values, even though the byte limit is much smaller.
const MAX_ENTRIES = 0xfffe;
const ZIP32_MAX = 0xfffffffe;
const END_SIZE = 22;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const CRC_SLICE_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface PreparedEntry {
  entry: ZipEntry;
  nameBytes: Uint8Array<ArrayBuffer>;
  size: number;
  offset: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("ZIP 생성이 취소되었습니다.", "AbortError");
}

/** Truncate at a Unicode code-point boundary, measured in UTF-8 bytes. */
function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const next = encoder.encode(character).length;
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

function isReservedName(name: string): boolean {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$|conin\$|conout\$)(?:\.|$)/i.test(
    name
  );
}

/** A single, portable, non-hidden file name, never a path. */
function safeName(input: string): { base: string; extension: string } {
  if (typeof input !== "string")
    throw new TypeError("ZIP 파일명은 문자열이어야 합니다.");
  // The round trip replaces lone surrogates, so collision checks match encoded bytes.
  let name = decoder
    .decode(encoder.encode(input.normalize("NFKC")))
    .replace(
      /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f\ufeff<>:"/\\|?*\u2044\u2215]/g,
      "_"
    )
    .trim()
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/u, "")
    .trim();
  if (!name) name = "file";
  if (isReservedName(name)) {
    name = `_${name}`;
  }
  const dot = name.lastIndexOf(".");
  // Keep normal extensions when truncating, leaving space for collision suffixes.
  const extension =
    dot > 0 ? truncateUtf8(name.slice(dot), 32).replace(/[.\s]+$/u, "") : "";
  let base = truncateUtf8(dot > 0 ? name.slice(0, dot) : name, 200).replace(
    /[.\s]+$/u,
    ""
  );
  if (!base) base = "file";
  // Truncation itself can expose a device name, e.g. "CON   ...".
  if (isReservedName(`${base}${extension}`)) base = `_${base}`;
  return { base, extension };
}

function collisionKey(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

class NameRegistry {
  private used = new Set<string>();
  private next = new Map<string, number>();

  allocate(input: string): Uint8Array<ArrayBuffer> {
    const { base, extension } = safeName(input);
    const original = `${base}${extension}`;
    const key = collisionKey(original);
    let name = original;
    if (this.used.has(key)) {
      let n = this.next.get(key) ?? 2;
      do {
        name = `${base} (${n++})${extension}`;
      } while (this.used.has(collisionKey(name)));
      this.next.set(key, n);
    }
    this.used.add(collisionKey(name));
    return encoder.encode(name);
  }
}

function blobSize(entry: ZipEntry): number {
  if (
    !entry ||
    !entry.blob ||
    !Number.isSafeInteger(entry.blob.size) ||
    entry.blob.size < 0
  ) {
    throw new TypeError("ZIP 항목의 Blob 크기가 올바르지 않습니다.");
  }
  return entry.blob.size;
}

function entryOverhead(nameBytes: Uint8Array): number {
  if (nameBytes.length > 0xffff)
    throw new RangeError("ZIP 파일명이 너무 깁니다.");
  return LOCAL_SIZE + CENTRAL_SIZE + 2 * nameBytes.length;
}

/**
 * Greedily preserves input order. Limits include EOCD, both headers, and UTF-8
 * name bytes. An item that cannot fit by itself is returned in tooLarge.
 * A requested limit above 100 MiB is capped so every group can be made by
 * makeZip. Invalid/non-integer limits throw. Groups also respect ZIP32's
 * non-ZIP64 file-count limit. Entries are not renamed or mutated here.
 */
export function partitionZipEntries(
  entries: ZipEntry[],
  limit = MAX_ARCHIVE_BYTES
): { groups: ZipEntry[][]; tooLarge: ZipEntry[] } {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("ZIP 크기 제한은 0 이상의 안전한 정수여야 합니다.");
  }
  const effectiveLimit = Math.min(limit, MAX_ARCHIVE_BYTES);
  const groups: ZipEntry[][] = [];
  const tooLarge: ZipEntry[] = [];
  let group: ZipEntry[] = [];
  let size = END_SIZE;
  let names = new NameRegistry();

  for (const entry of entries) {
    const payloadSize = blobSize(entry);
    const soloName = new NameRegistry().allocate(entry.name);
    const soloOverhead = entryOverhead(soloName);
    if (payloadSize > effectiveLimit - END_SIZE - soloOverhead) {
      tooLarge.push(entry);
      continue;
    }
    let nameBytes = names.allocate(entry.name);
    let overhead = entryOverhead(nameBytes);
    if (
      group.length === MAX_ENTRIES ||
      payloadSize > effectiveLimit - size - overhead
    ) {
      if (group.length) groups.push(group);
      group = [];
      size = END_SIZE;
      names = new NameRegistry();
      nameBytes = names.allocate(entry.name);
      overhead = entryOverhead(nameBytes);
    }
    group.push(entry);
    size += payloadSize + overhead;
  }
  if (group.length) groups.push(group);
  return { groups, tooLarge };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[n] = value >>> 0;
  }
  return table;
})();

/** Read bounded Blob slices; never materialize the whole input or ZIP in JS. */
async function crc32(
  blob: Blob,
  expectedSize: number,
  signal?: AbortSignal
): Promise<number> {
  let crc = 0xffffffff;
  for (let offset = 0; offset < expectedSize; offset += CRC_SLICE_BYTES) {
    throwIfAborted(signal);
    const length = Math.min(CRC_SLICE_BYTES, expectedSize - offset);
    const reader = blob
      .slice(offset, offset + length)
      .stream()
      .getReader();
    let onAbort: (() => void) | undefined;
    const aborted =
      signal &&
      new Promise<never>((_, reject) => {
        onAbort = () => {
          // Cancel immediately, including a pending read, but don't wait for a
          // potentially slow underlying cancellation before rejecting the caller.
          try {
            void reader.cancel().catch(() => {});
          } catch {
            /* already closed */
          }
          reject(new DOMException("ZIP 생성이 취소되었습니다.", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    let consumed = 0;
    try {
      while (true) {
        const read = reader.read();
        const result = aborted
          ? await Promise.race([read, aborted])
          : await read;
        throwIfAborted(signal);
        if (result.done) break;
        const chunk = result.value;
        consumed += chunk.byteLength;
        if (consumed > length)
          throw new Error("Blob 스트림의 크기가 일치하지 않습니다.");
        for (let i = 0; i < chunk.length; i++) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ chunk[i]) & 0xff];
        }
      }
      if (consumed !== length)
        throw new Error("Blob 스트림의 크기가 일치하지 않습니다.");
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {
        /* a pending read may still be settling */
      }
    }
  }
  throwIfAborted(signal);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(
  item: PreparedEntry,
  crc: number
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(LOCAL_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // ZIP 2.0
  view.setUint16(6, 0x0800, true); // UTF-8 filename
  view.setUint16(8, 0, true); // STORE
  view.setUint16(12, 0x0021, true); // 1980-01-01, 00:00:00
  view.setUint32(14, crc, true);
  view.setUint32(18, item.size, true);
  view.setUint32(22, item.size, true);
  view.setUint16(26, item.nameBytes.length, true);
  return bytes;
}

function centralHeader(
  item: PreparedEntry,
  crc: number
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(CENTRAL_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(14, 0x0021, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, item.size, true);
  view.setUint32(24, item.size, true);
  view.setUint16(28, item.nameBytes.length, true);
  view.setUint32(42, item.offset, true);
  return bytes;
}

/**
 * Build an uncompressed UTF-8 ZIP32 Blob. Inputs remain local and their bytes
 * are used unchanged. Unsafe names are sanitized and collisions get numbered
 * within the archive. Oversized archives must be split with partitionZipEntries.
 */
export async function makeZip(
  entries: ZipEntry[],
  signal?: AbortSignal
): Promise<Blob> {
  throwIfAborted(signal);
  if (entries.length > MAX_ENTRIES) {
    throw new RangeError(
      "ZIP 파일 수가 너무 많습니다. partitionZipEntries로 나누어 주세요."
    );
  }
  const names = new NameRegistry();
  const prepared: PreparedEntry[] = [];
  let localBytes = 0;
  let centralBytes = 0;
  for (const entry of entries) {
    throwIfAborted(signal);
    const size = blobSize(entry);
    const nameBytes = names.allocate(entry.name);
    entryOverhead(nameBytes); // validates the 16-bit name length
    const localLength = LOCAL_SIZE + nameBytes.length + size;
    const centralLength = CENTRAL_SIZE + nameBytes.length;
    if (
      size > ZIP32_MAX ||
      localBytes > ZIP32_MAX ||
      localLength > ZIP32_MAX - localBytes ||
      centralLength > ZIP32_MAX - centralBytes
    ) {
      throw new RangeError(
        "ZIP32 크기 제한을 초과했습니다. 파일을 나누어 주세요."
      );
    }
    if (
      localLength + centralLength >
      MAX_ARCHIVE_BYTES - END_SIZE - localBytes - centralBytes
    ) {
      throw new RangeError(
        "ZIP 전체 크기가 100 MiB를 초과합니다. partitionZipEntries로 나누어 주세요."
      );
    }
    prepared.push({
      entry: { name: entry.name, blob: entry.blob },
      nameBytes,
      size,
      offset: localBytes,
    });
    localBytes += localLength;
    centralBytes += centralLength;
  }
  if (
    localBytes > ZIP32_MAX ||
    centralBytes > ZIP32_MAX ||
    localBytes + centralBytes + END_SIZE > ZIP32_MAX
  ) {
    throw new RangeError(
      "ZIP32 크기 제한을 초과했습니다. 파일을 나누어 주세요."
    );
  }

  const parts: BlobPart[] = [];
  const directory: BlobPart[] = [];
  for (const item of prepared) {
    throwIfAborted(signal);
    const crc = await crc32(item.entry.blob, item.size, signal);
    parts.push(localHeader(item, crc), item.nameBytes, item.entry.blob);
    directory.push(centralHeader(item, crc), item.nameBytes);
  }
  throwIfAborted(signal);
  const end = new Uint8Array(END_SIZE);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, prepared.length, true);
  view.setUint16(10, prepared.length, true);
  view.setUint32(12, centralBytes, true);
  view.setUint32(16, localBytes, true);
  const zip = new Blob([...parts, ...directory, end], {
    type: "application/zip",
  });
  if (zip.size !== localBytes + centralBytes + END_SIZE) {
    throw new Error("ZIP 크기가 계산된 크기와 일치하지 않습니다.");
  }
  return zip;
}
