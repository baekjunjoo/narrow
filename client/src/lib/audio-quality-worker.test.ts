import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mp3DeclaredLength, mp3LengthStatus } from './audio-quality-length';

// Run the real worker handler against local LibAV assets; no server or network is used.
describe('quality worker MP3 byte declaration', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it('reports a one-byte declaration mismatch without claiming a large decoded shortfall', async () => {
    const bytes = readFileSync(new URL('../../public/voice-previews/ko/F1.mp3', import.meta.url));
    const original = new Blob([bytes]);
    const cut = original.slice(0, original.size - 1);
    const declaration = await mp3DeclaredLength(cut);
    expect(declaration?.truncatedBytes).toBe(true);
    expect(mp3LengthStatus(declaration, declaration!.samples, declaration!.sampleRate)).toBe('short');
    const messages: any[] = [];
    const scope: any = { location: { origin: 'null' }, postMessage: (message: unknown) => messages.push(message) };
    vi.stubGlobal('self', scope);
    await import('./audio-quality.worker');
    const assetBase = pathToFileURL(resolve('node_modules/@libav.js/variant-obsolete/dist') + '/').href;
    await scope.onmessage({ data: { type: 'analyze', blob: original, assetBase } });
    expect(messages.at(-1)?.type).toBe('success');
    expect(messages.at(-1).result.issues.some((issue: { message: string }) => /S32.*24비트/.test(issue.message))).toBe(false);
    messages.length = 0;
    await scope.onmessage({ data: { type: 'analyze', blob: cut, assetBase } });
    expect(messages.at(-1)?.type).toBe('error');
    expect(messages.at(-1).message).toMatch(/바이트.*길이.*불일치/);
    expect(messages.at(-1).message).not.toContain('디코딩된 오디오가 크게 부족');
  }, 30000);
});

describe('quality worker unknown S32 source', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it.each(['before', 'after'] as const)('reports the 24-bit positive-limit limitation with 4097 JUNK chunks %s fmt', async position => {
    const count = 8000, wave = new Uint8Array(44 + count * 3), view = new DataView(wave.buffer);
    const put = (at: number, text: string) => wave.set(new TextEncoder().encode(text), at);
    put(0, 'RIFF'); put(8, 'WAVE'); put(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
    view.setUint32(28, 24000, true); view.setUint16(32, 3, true); view.setUint16(34, 24, true);
    put(36, 'data'); view.setUint32(40, count * 3, true);
    for (let i = 0; i < count; i++) wave.set([0xff, 0xff, 0x7f], 44 + i * 3);
    const junk = new Uint8Array(4097 * 8);
    for (let i = 0; i < 4097; i++) junk.set([0x4a, 0x55, 0x4e, 0x4b], i * 8);
    view.setUint32(4, wave.length + junk.length - 8, true);
    const blob = position === 'before' ? new Blob([wave.slice(0, 12), junk, wave.slice(12)]) : new Blob([wave.slice(0, 36), junk, wave.slice(36)]);
    const messages: any[] = [];
    const scope: any = { location: { origin: 'null' }, postMessage: (message: unknown) => messages.push(message) };
    vi.stubGlobal('self', scope);
    await import('./audio-quality.worker');
    const assetBase = pathToFileURL(resolve('node_modules/@libav.js/variant-obsolete/dist') + '/').href;
    await scope.onmessage({ data: { type: 'analyze', blob, assetBase } });
    expect(messages.at(-1)?.type).toBe('success');
    expect(messages.at(-1).result.issues).toContainEqual(expect.objectContaining({
      level: 'warning', message: expect.stringMatching(/S32.*24비트.*양의.*놓칠/),
    }));
  }, 30000);
});
