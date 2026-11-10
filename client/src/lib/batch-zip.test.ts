import { describe, expect, it, vi } from "vitest";
import {
  MAX_ARCHIVE_BYTES,
  makeZip,
  partitionZipEntries,
  type ZipEntry,
} from "./batch-zip";

interface ParsedEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  flags: number;
  offset: number;
}

// Independent bit-at-a-time implementation, not the production CRC table.
function referenceCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Independently inspect both copies of every record and all offsets and sizes.
async function parseZip(blob: Blob): Promise<ParsedEntry[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  expect(view.getUint16(end + 4, true)).toBe(0);
  expect(view.getUint16(end + 6, true)).toBe(0);
  const count = view.getUint16(end + 10, true);
  expect(view.getUint16(end + 8, true)).toBe(count);
  expect(view.getUint16(end + 20, true)).toBe(0);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  expect(directoryOffset + directorySize).toBe(end);
  const parsed: ParsedEntry[] = [];
  let directory = directoryOffset;
  let localEnd = 0;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(directory, true)).toBe(0x02014b50);
    expect(view.getUint16(directory + 6, true)).toBe(20);
    const flags = view.getUint16(directory + 8, true);
    expect(flags).toBe(0x0800);
    expect(view.getUint16(directory + 10, true)).toBe(0);
    const crc = view.getUint32(directory + 16, true);
    const length = view.getUint32(directory + 20, true);
    expect(view.getUint32(directory + 24, true)).toBe(length);
    const nameLength = view.getUint16(directory + 28, true);
    expect(view.getUint16(directory + 30, true)).toBe(0);
    expect(view.getUint16(directory + 32, true)).toBe(0);
    const offset = view.getUint32(directory + 42, true);
    expect(offset).toBe(localEnd);
    const nameBytes = bytes.slice(directory + 46, directory + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint16(offset + 4, true)).toBe(20);
    expect(view.getUint16(offset + 6, true)).toBe(flags);
    expect(view.getUint16(offset + 8, true)).toBe(0);
    expect(view.getUint16(offset + 10, true)).toBe(0);
    expect(view.getUint16(offset + 12, true)).toBe(0x0021);
    expect(view.getUint32(offset + 14, true)).toBe(crc);
    expect(view.getUint32(offset + 18, true)).toBe(length);
    expect(view.getUint32(offset + 22, true)).toBe(length);
    expect(view.getUint16(offset + 26, true)).toBe(nameLength);
    expect(view.getUint16(offset + 28, true)).toBe(0);
    expect(bytes.slice(offset + 30, offset + 30 + nameLength)).toEqual(
      nameBytes
    );
    const data = bytes.slice(
      offset + 30 + nameLength,
      offset + 30 + nameLength + length
    );
    expect(referenceCrc32(data)).toBe(crc);
    localEnd = offset + 30 + nameLength + length;
    parsed.push({ name, data, crc, flags, offset });
    directory += 46 + nameLength;
  }
  expect(localEnd).toBe(directoryOffset);
  expect(directory).toBe(end);
  return parsed;
}

function entry(name: string, contents: BlobPart = ""): ZipEntry {
  return { name, blob: new Blob([contents]) };
}

// This metadata-only test double is never read or included in a resulting ZIP.
function sizedEntry(name: string, size: number): ZipEntry {
  const blob = new Blob();
  Object.defineProperty(blob, "size", { value: size });
  return { name, blob };
}

describe("makeZip", () => {
  it("stores WAV, MP3, Unicode names and zero-length files byte-for-byte with matching ZIP32 records and CRC", async () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 255, 0, 0x57, 0x41, 0x56, 0x45, 1, 2, 3,
    ]);
    const mp3 = new Uint8Array([
      0x49, 0x44, 0x33, 4, 0, 0, 255, 251, 0, 255, 8, 7, 6,
    ]);
    const zip = await makeZip([
      entry("한글 😀.wav", wav),
      entry("音声.mp3", mp3),
      entry("empty.wav"),
      entry("check.bin", "123456789"),
    ]);
    expect(zip.type).toBe("application/zip");
    const files = await parseZip(zip);
    expect(files.map(file => file.name)).toEqual([
      "한글 😀.wav",
      "音声.mp3",
      "empty.wav",
      "check.bin",
    ]);
    expect(files[0].data).toEqual(wav);
    expect(files[1].data).toEqual(mp3);
    expect(files[2].data).toHaveLength(0);
    expect(files[2].crc).toBe(0);
    expect(files[3].crc).toBe(0xcbf43926);
  });

  it("creates a valid empty archive", async () => {
    const zip = await makeZip([]);
    expect(zip.size).toBe(22);
    expect(await parseZip(zip)).toEqual([]);
  });

  it("neutralizes traversal, separators, controls, reserved names, collisions and long names", async () => {
    const names = [
      "../escape.wav",
      "C:\\tmp\\track.mp3",
      "/absolute.wav",
      "..\\..\\outside.wav",
      "dir／file.mp3",
      "dir∕file.mp3",
      "CON.mp3",
      "con.MP3",
      "NUL",
      "LPT１.wav",
      "control\u0000\u202e.wav",
      ".hidden.wav",
      "...",
      "foo. ",
      "Résumé.mp3",
      "Re\u0301sume\u0301.mp3",
      "résumé.MP3",
      "same.mp3",
      "same (2).mp3",
      "same.mp3",
      "SAME.MP3",
      "\ud800.mp3",
      "\udfff.mp3",
      "가".repeat(300) + ".mp3",
      "a." + "x".repeat(30) + ".ending",
      "CON" + " ".repeat(197) + "x",
      "straße.mp3",
      "STRASSE.mp3",
    ];
    const files = await parseZip(
      await makeZip(names.map((name, index) => entry(name, String(index))))
    );
    const safe = files.map(file => file.name);
    expect(safe[0]).toBe("_escape.wav");
    expect(safe).toContain("_CON.mp3");
    expect(safe).toContain("_LPT1.wav");
    expect(safe).toContain("same (3).mp3");
    expect(safe).toContain("SAME (4).MP3");
    expect(safe).toContain("Résumé (2).mp3");
    expect(safe).toContain("_CON");
    expect(safe).toContain("STRASSE (2).mp3");
    const keys = safe.map(name =>
      name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC")
    );
    expect(new Set(keys).size).toBe(names.length);
    for (const name of safe) {
      expect(name).not.toMatch(/[\/\\\x00-\x1f\x7f-\x9f<>:"|?*\u202a-\u202e]/u);
      expect(name).not.toMatch(/^\.|[.\s]$/u);
      expect(name).not.toMatch(
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
      );
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(240);
    }
  });

  it("calculates CRC through bounded Blob streams without reading the whole Blob", async () => {
    const bytes = Uint8Array.from(
      { length: 600_111 },
      (_, i) => (i * 71 + (i >>> 8)) & 255
    );
    const blob = new Blob([bytes]);
    const arrayBuffer = vi.spyOn(blob, "arrayBuffer").mockImplementation(() => {
      throw new Error("whole Blob read");
    });
    const slice = vi.spyOn(blob, "slice");
    const files = await parseZip(await makeZip([{ name: "large.wav", blob }]));
    expect(files[0].data).toEqual(bytes);
    expect(files[0].crc).toBe(referenceCrc32(bytes));
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(slice).toHaveBeenCalledTimes(3);
    for (const [start, end] of slice.mock.calls) {
      expect((end as number) - (start as number)).toBeLessThanOrEqual(
        256 * 1024
      );
    }
  });

  it("rejects pre-aborted work without opening a stream", async () => {
    const controller = new AbortController();
    controller.abort();
    const blob = new Blob(["audio"]);
    const slice = vi.spyOn(blob, "slice");
    await expect(
      makeZip([{ name: "a.mp3", blob }], controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(slice).not.toHaveBeenCalled();
  });

  it("cancels the active reader and rejects promptly even if the source cancellation never settles", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const blob = new Blob(["audio"]);
    vi.spyOn(blob, "slice").mockImplementation(
      () =>
        ({
          stream: () => new ReadableStream<Uint8Array>({ cancel }),
        }) as Blob
    );
    const pending = makeZip([{ name: "a.mp3", blob }], controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects an inconsistent source stream", async () => {
    const blob = new Blob(["123"]);
    vi.spyOn(blob, "slice").mockImplementation(() => new Blob(["12"]));
    await expect(makeZip([{ name: "a.wav", blob }])).rejects.toThrow(/크기/);
  });

  it("rejects 100 MiB of payload before reading, because ZIP metadata also occupies space", async () => {
    const large = sizedEntry("large.mp3", MAX_ARCHIVE_BYTES);
    const slice = vi.spyOn(large.blob, "slice");
    await expect(makeZip([large])).rejects.toThrow(
      /100 MiB.*partitionZipEntries/
    );
    expect(slice).not.toHaveBeenCalled();
  });

  it("rejects ZIP32 overflow and too many entries before reading", async () => {
    await expect(makeZip([sizedEntry("huge.mp3", 0xffffffff)])).rejects.toThrow(
      /ZIP32/
    );
    const empty = entry("a.mp3");
    await expect(
      makeZip(Array.from({ length: 0xffff }, () => empty))
    ).rejects.toThrow(/파일 수/);
  });
});

describe("partitionZipEntries", () => {
  it("accounts for EOCD, both UTF-8 filenames and collision suffixes at the exact boundary", async () => {
    const entries = [
      entry("음성.mp3", "one"),
      entry("음성.mp3", "two"),
      entry("last.wav", "z"),
    ];
    const twoSize = (await makeZip(entries.slice(0, 2))).size;
    const exact = partitionZipEntries(entries, twoSize);
    expect(exact.groups).toEqual([entries.slice(0, 2), entries.slice(2)]);
    expect(exact.tooLarge).toEqual([]);
    for (const group of exact.groups)
      expect((await makeZip(group)).size).toBeLessThanOrEqual(twoSize);
    const justTooSmall = partitionZipEntries(entries, twoSize - 1);
    expect(justTooSmall.groups).toEqual([
      [entries[0]],
      [entries[1], entries[2]],
    ]);
    for (const group of justTooSmall.groups)
      expect((await makeZip(group)).size).toBeLessThanOrEqual(twoSize - 1);
  });

  it("returns oversized single entries separately, preserving relative order without empty groups", async () => {
    const entries = [
      entry("a", "1"),
      entry("huge", "x".repeat(200)),
      entry("b", "2"),
      entry("big", "y".repeat(300)),
    ];
    const limit = (await makeZip([entries[0], entries[2]])).size;
    const result = partitionZipEntries(entries, limit);
    expect(result.groups).toEqual([[entries[0], entries[2]]]);
    expect(result.tooLarge).toEqual([entries[1], entries[3]]);
    expect((await makeZip(result.groups[0])).size).toBe(limit);
    expect(partitionZipEntries([entry("a")], 21)).toEqual({
      groups: [],
      tooLarge: [entry("a")],
    });
    expect(partitionZipEntries([], 0)).toEqual({ groups: [], tooLarge: [] });
  });

  it("resets collision numbering on a new group and ignores oversized entries for naming", async () => {
    const a = entry("same.mp3", "1");
    const big = entry("same.mp3", "x".repeat(200));
    const b = entry("same.mp3", "2");
    const limit = (await makeZip([a])).size;
    const result = partitionZipEntries([a, big, b], limit);
    expect(result.groups).toEqual([[a], [b]]);
    expect(result.tooLarge).toEqual([big]);
    for (const group of result.groups) {
      expect((await parseZip(await makeZip(group)))[0].name).toBe("same.mp3");
      expect((await makeZip(group)).size).toBe(limit);
    }
  });

  it("enforces the default hard 100 MiB cap including overhead even when a larger limit is requested", () => {
    const name = "a";
    const overhead = 22 + 30 + 46 + 2 * new TextEncoder().encode(name).length;
    const fitsExactly = sizedEntry(name, MAX_ARCHIVE_BYTES - overhead);
    const tooBig = sizedEntry(name, MAX_ARCHIVE_BYTES - overhead + 1);
    expect(
      partitionZipEntries([fitsExactly, tooBig], MAX_ARCHIVE_BYTES * 2)
    ).toEqual({ groups: [[fitsExactly]], tooLarge: [tooBig] });
    expect(partitionZipEntries([fitsExactly, tooBig])).toEqual({
      groups: [[fitsExactly]],
      tooLarge: [tooBig],
    });
  });

  it("splits before the ZIP64 file-count sentinel", () => {
    const entries = Array.from({ length: 0xffff }, (_, i) => entry(`${i}.wav`));
    const result = partitionZipEntries(entries);
    expect(result.tooLarge).toEqual([]);
    expect(result.groups.map(group => group.length)).toEqual([0xfffe, 1]);
    expect(result.groups.flat()).toEqual(entries);
  }, 20_000);

  it("rejects invalid limits and Blob sizes instead of rounding or overflowing", async () => {
    for (const limit of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => partitionZipEntries([], limit)).toThrow(RangeError);
    }
    for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = sizedEntry("x", size);
      expect(() => partitionZipEntries([invalid])).toThrow(TypeError);
      await expect(makeZip([invalid])).rejects.toThrow(TypeError);
    }
  });
});
