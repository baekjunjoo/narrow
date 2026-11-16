import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

function wav(): File {
  const samples = 8000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  return new File([bytes], 'sample.wav', { type: 'audio/wav' });
}

const tempDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('worker LibAV asset directory', () => {
  it.each([
    ['quality', ''], ['quality', 'narrow'],
    ['converter', ''], ['converter', 'narrow'],
  ] as const)('initializes %s under /%s with a single separator', async (kind, prefix) => {
    vi.resetModules();
    const root = mkdtempSync(join(tmpdir(), 'narravo-libav-'));
    tempDirectories.push(root);
    const libavDirectory = join(root, prefix, 'libav');
    mkdirSync(dirname(libavDirectory), { recursive: true });
    symlinkSync(resolve('client/public/libav'), libavDirectory, 'dir');
    const assetBase = pathToFileURL(`${libavDirectory}/`).href;
    const wrapperUrl = new URL('libav-6.10.9.0-obsolete.mjs', assetBase).href;
    const wrapper = await import(/* @vite-ignore */ wrapperUrl);
    const init = vi.spyOn(wrapper.default, 'LibAV');
    const messages: Array<{ type: string; message?: string }> = [];
    const worker = { location: { origin: 'null' }, postMessage: (message: { type: string; message?: string }) => messages.push(message), onmessage: undefined as undefined | ((event: { data: unknown }) => Promise<void>) };
    vi.stubGlobal('self', worker);
    if (kind === 'quality') await import('./audio-quality.worker');
    else await import('./audio-converter.worker');
    expect(worker.onmessage).toBeTypeOf('function');
    const file = wav();
    await worker.onmessage!({ data: kind === 'quality'
      ? { type: 'analyze', blob: file, assetBase }
      : { type: 'convert', file, format: 'wav', assetBase } });
    expect(messages.find(message => message.type === 'error')).toBeUndefined();
    expect(messages.some(message => message.type === 'success')).toBe(true);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ noworker: true, base: assetBase.slice(0, -1) }));
    const options = init.mock.calls[0][0] as { base: string };
    const requestedModule = `${options.base}/libav-6.10.9.0-obsolete.wasm.mjs`;
    expect(new URL(requestedModule).pathname).not.toContain('//');
  }, 30000);

  it.each(['quality', 'converter'] as const)('rejects cross-origin %s libraries', async (kind) => {
    vi.resetModules();
    const messages: Array<{ type: string; message?: string }> = [];
    const worker = { location: { origin: 'https://example.test' }, postMessage: (message: { type: string; message?: string }) => messages.push(message), onmessage: undefined as undefined | ((event: { data: unknown }) => Promise<void>) };
    vi.stubGlobal('self', worker);
    if (kind === 'quality') await import('./audio-quality.worker');
    else await import('./audio-converter.worker');
    const file = wav();
    const assetBase = 'https://other.test/narrow/libav/';
    await worker.onmessage!({ data: kind === 'quality'
      ? { type: 'analyze', blob: file, assetBase }
      : { type: 'convert', file, format: 'wav', assetBase } });
    expect(messages.find(message => message.type === 'error')?.message).toContain('안전하게 불러올 수 없습니다');
    expect(messages.some(message => message.type === 'success')).toBe(false);
  });
});
