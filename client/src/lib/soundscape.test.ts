import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mixSoundscape, type Cue, type MixOptions } from './soundscape';

const encoded = vi.hoisted(() => ({
  settings: [] as { channels: number; rate: number; bitrate: number }[],
  blocks: [] as { left: number[]; right?: number[] }[],
}));
// The real encoder and Web Audio are covered by the separate Chromium test.
vi.mock('@breezystack/lamejs', () => ({
  Mp3Encoder: class {
    constructor(channels: number, rate: number, bitrate: number) { encoded.settings.push({ channels, rate, bitrate }); }
    encodeBuffer(left: Int16Array, right?: Int16Array) {
      encoded.blocks.push({ left: Array.from(left), right: right ? Array.from(right) : undefined });
      return new Uint8Array([1, 2, 3]);
    }
    flush() { return new Uint8Array([4]); }
  },
}));

let voiceDuration = 40;
let offlineInstances: FakeOffline[] = [];
let decoderInstances: FakeAudioContext[] = [];
let pendingRender = false;
let syncRenderFailure = false;
let offlineConstructionFailure = false;
let renderStarts = 0;
let pendingRenders: { promise: Promise<FakeBuffer>; resolve: () => void; reject: (reason: Error) => void }[] = [];
let assetLevel = 0.01;
let assetRightLevel = 0.01;
let assetChannels = 1;
let renderedLeftLevel = 0.1;
let renderedRightLevel = 0.1;
let hrtfFailure: 'none' | 'create' | 'configure' = 'none';
let stereoFailure = false;

class FakeBuffer {
  sampleRate = 44_100;
  length = 4410;
  data = new Float32Array(this.length).fill(0.1);
  rightData = new Float32Array(this.length).fill(0.1);
  constructor(public duration = 0.1, public numberOfChannels = 1) {}
  getChannelData(index = 0) { return index === 0 ? this.data : this.rightData; }
}
class FakeParam {
  value = 0;
  values: number[] = [];
  setValueAtTime(value: number) { this.values.push(value); }
  linearRampToValueAtTime(value: number) { this.values.push(value); }
}
class FakeGain {
  gain = new FakeParam();
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  connections: unknown[] = [];
  connect<T>(destination: T) { this.connections.push(destination); return destination; }
  disconnect() { this.connections = []; }
}
class FakeNode {
  connect<T>(destination: T, _output?: number, _input?: number) { return destination; }
}
class FakePanner extends FakeNode { pan = new FakeParam(); }
class FakeHrtfPanner extends FakeNode {
  private model = 'equalpower';
  get panningModel() { return this.model; }
  set panningModel(value: string) {
    if (hrtfFailure === 'configure') throw new Error('HRTF unavailable');
    this.model = value;
  }
  distanceModel = 'inverse';
  rolloffFactor = 1;
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
}
class FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  startTime = -1;
  stopTime = -1;
  gain?: FakeGain;
  connect(gain: FakeGain) { this.gain = gain; }
  start(time: number) { this.startTime = time; }
  stop(time: number) { this.stopTime = time; }
}
class FakeAudioContext {
  decodeCount = 0;
  closed = false;
  constructor() { decoderInstances.push(this); }
  async decodeAudioData() {
    const isVoice = this.decodeCount++ === 0;
    const result = new FakeBuffer(isVoice ? voiceDuration : 4, isVoice ? 1 : assetChannels);
    if (!isVoice) {
      result.data.fill(assetLevel);
      result.rightData.fill(assetRightLevel);
    }
    return result;
  }
  createBuffer(channels: number, length: number) {
    const buffer = new FakeBuffer(length / 44_100, channels);
    buffer.length = length;
    buffer.data = new Float32Array(length);
    buffer.rightData = new Float32Array(length);
    return buffer;
  }
  async close() { this.closed = true; }
}
class FakeOffline {
  destination = {};
  sources: FakeSource[] = [];
  panners: FakePanner[] = [];
  hrtfPanners: FakeHrtfPanner[] = [];
  constructor(public channels: number, public frames: number, public rate: number) {
    if (offlineConstructionFailure) throw new Error('offline construction failed');
    offlineInstances.push(this);
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
  createGain() { return new FakeGain(); }
  createChannelSplitter() { return new FakeNode(); }
  createChannelMerger() { return new FakeNode(); }
  createStereoPanner() { if (stereoFailure) throw new Error('unsupported'); const panner = new FakePanner(); this.panners.push(panner); return panner; }
  createPanner() { if (hrtfFailure === 'create') throw new Error('unsupported'); const panner = new FakeHrtfPanner(); this.hrtfPanners.push(panner); return panner; }
  startRendering() {
    renderStarts++;
    if (syncRenderFailure) throw new Error('synchronous render failure');
    const buffer = new FakeBuffer(0.1, this.channels);
    buffer.data.fill(renderedLeftLevel);
    buffer.rightData.fill(renderedRightLevel);
    if (pendingRender) {
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<FakeBuffer>((ok, fail) => {
        resolve = () => ok(buffer);
        reject = fail;
      });
      pendingRenders.push({ promise, resolve, reject });
      return promise;
    }
    return Promise.resolve(buffer);
  }
}

const options: MixOptions = { music: false, effects: true, musicVolume: 1, effectsVolume: 1 };
const effectUrls = ['rain', 'forest', 'ocean', 'footsteps', 'door', 'page'].map((name) => `/soundscape/${name}.mp3`);
const voice = () => new Blob([new Uint8Array([1])], { type: 'audio/mpeg' });
const cue = (text: string, start = 0, duration = 4): Cue => ({ text, start, duration });

beforeEach(() => {
  voiceDuration = 40;
  pendingRender = false;
  syncRenderFailure = false;
  offlineConstructionFailure = false;
  renderStarts = 0;
  pendingRenders = [];
  assetLevel = 0.01;
  assetRightLevel = 0.01;
  assetChannels = 1;
  renderedLeftLevel = 0.1;
  renderedRightLevel = 0.1;
  hrtfFailure = 'none';
  stereoFailure = false;
  offlineInstances = [];
  decoderInstances = [];
  encoded.settings.length = 0;
  encoded.blocks.length = 0;
  vi.stubGlobal('window', { AudioContext: FakeAudioContext, OfflineAudioContext: FakeOffline });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
});
afterEach(async () => {
  // A cancelled wait does not cancel the physical render: settle the fake so
  // its module-level reservation never leaks into the next test.
  pendingRenders.forEach((render) => render.resolve());
  await Promise.allSettled(pendingRenders.map((render) => render.promise));
  await Promise.resolve();
  vi.unstubAllGlobals();
});

describe('mixSoundscape', () => {
  it('finds audible Korean and English actions within chunk bounds, throttling duplicate and nearby scenes', async () => {
    const result = await mixSoundscape(voice(), [
      cue('비가 내렸습니다.', 0),
      cue('문을 열었다.', 1), // too close to the first cue
      cue('창가에서 책을 천천히 펼쳤습니다.', 8),
      cue('The rainbow is pretty.', 14),
      cue('He walked into the forest.', 16),
      cue('Rain began again.', 20), // same effect under 30 seconds
      cue('비는 계속 내렸다.', 34),
    ], options);
    expect(result.events.map((e) => e.label)).toEqual(['빗소리', '책장 넘기는 소리', '숲', '빗소리']);
    expect(result.events[1].time).toBeGreaterThanOrEqual(8);
    expect(result.events[1].time).toBeLessThan(12);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
    expect(result.blob.type).toBe('audio/mpeg');
    expect(result.warnings).toEqual([]);
  });

  it('recognizes concrete book and page actions but not mentions, negation or substring false positives', async () => {
    const absent = await mixSoundscape(voice(), [cue('비밀과 바다표범, 책장 표면과 page 42. A rainbow. No rain. 비가 오지 않았다. 책을 펼치지 않았다.')], options);
    expect(absent.events).toEqual([]);
    expect(absent.warnings.join(' ')).toContain('단서를 찾지 못해');
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
    const present = await mixSoundscape(voice(), [cue('She opened an old book.', 0), cue('He turned the page.', 31)], options);
    expect(present.events.map((e) => e.label)).toEqual(['책장 넘기는 소리', '책장 넘기는 소리']);
  });

  it('fetches the same fixed effect URLs for rain, forest, and no cues without sending manuscript text', async () => {
    const calls: unknown[][] = [];
    for (const cues of [[cue('rain')], [cue('forest')], [], [cue('a quiet room')]]) {
      vi.mocked(fetch).mockClear();
      await mixSoundscape(voice(), cues, options);
      const requests = vi.mocked(fetch).mock.calls;
      calls.push(requests.map(([url]) => url));
      for (const [, init] of requests) {
        expect(init).toEqual({ credentials: 'same-origin', signal: undefined });
      }
    }
    expect(calls).toEqual([effectUrls, effectUrls, effectUrls, effectUrls]);
  });

  it('loads the music setting first and the same effects regardless of cues', async () => {
    for (const text of ['rain', 'forest', 'quiet']) {
      vi.mocked(fetch).mockClear();
      await mixSoundscape(voice(), [cue(text)], { ...options, music: true });
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/soundscape/music-calm.mp3', ...effectUrls]);
    }
  });

  it('recognizes the example rain and book cues and the particle 만 without substring false positives', async () => {
    voiceDuration = 110;
    const result = await mixSoundscape(voice(), [
      cue('빗소리가 들려왔습니다', 0), cue('오래된 책을 천천히 펼쳤습니다', 8),
      cue('빗방울만 떨어졌다', 32), cue('비만 내렸다', 64),
    ], options);
    expect(result.events.map((event) => event.label)).toEqual(['빗소리', '책장 넘기는 소리', '빗소리', '빗소리']);
    const original = await mixSoundscape(voice(), [cue('빗소리만 남았습니다')], options);
    expect(original.events.map((event) => event.label)).toEqual(['빗소리']);
    const absent = await mixSoundscape(voice(), [cue('비밀과 빗소리만화')], options);
    expect(absent.events).toEqual([]);
  });

  it('understands the requested Korean particles and common English effects', async () => {
    voiceDuration = 190;
    const texts = ['비가', '비는', '비를', '비 오는', '빗소리', 'rain', '숲에', '바다에서', 'footsteps', 'opening the door', '책장을 넘겼다'];
    const result = await mixSoundscape(voice(), texts.map((text, i) => cue(text, i * 16, 3)), options);
    // The six rain mentions are subject to the per-kind 30-second cooldown.
    expect(result.events.map((event) => event.label)).toEqual([
      '빗소리', '빗소리', '빗소리', '숲', '바다', '발소리', '문 여닫는 소리', '책장 넘기는 소리',
    ]);
  });

  it('uses low fixed gains and makes a faded looping bed, without fetching disabled effects', async () => {
    const result = await mixSoundscape(voice(), [cue('비가 온다')], { ...options, music: true, effects: false, musicVolume: 1 });
    const offline = offlineInstances[0];
    expect(offline.channels).toBe(1);
    expect(offline.rate).toBe(44_100);
    expect(offline.sources).toHaveLength(2);
    expect(offline.sources[0].gain?.gain.value).toBe(0.9);
    expect(offline.sources[1].loop).toBe(true);
    expect(Math.max(...offline.sources[1].gain!.gain.values)).toBeCloseTo(0.065);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/soundscape/music-calm.mp3']);
    expect(result.events).toEqual([]);
  });

  it('leaves omitted and explicitly disabled spatial options as the same mono mix', async () => {
    const first = await mixSoundscape(voice(), [cue('비가')], { ...options, music: true });
    const second = await mixSoundscape(voice(), [cue('비가')], { ...options, music: true, spatial: false });
    expect(offlineInstances.map((item) => item.channels)).toEqual([1, 1]);
    expect(offlineInstances.map((item) => item.panners.length)).toEqual([0, 0]);
    expect(encoded.settings.map((item) => [item.channels, item.bitrate])).toEqual([[1, 128], [1, 128]]);
    expect(encoded.blocks.every((block) => block.right === undefined)).toBe(true);
    expect(first.events).toEqual(second.events);
    expect(Array.from(new Uint8Array(await first.blob.arrayBuffer()))).toEqual(Array.from(new Uint8Array(await second.blob.arrayBuffer())));
  });

  it('renders stereo with centered mono narration, a narrowed stereo music bed and fixed effect locations', async () => {
    voiceDuration = 50;
    const result = await mixSoundscape(voice(), [
      cue('비가', 0), cue('숲에', 7), cue('바다에서', 14),
      cue('발소리가', 21), cue('문을 열었다', 28), cue('책장을 넘겼다', 35),
    ], { ...options, music: true, spatial: true });
    const offline = offlineInstances[0];
    expect(offline.channels).toBe(2);
    expect(offline.sources[0].gain?.channelCount).toBe(1);
    expect(offline.sources[0].gain?.channelCountMode).toBe('explicit');
    expect(offline.sources[0].gain?.channelInterpretation).toBe('speakers');
    expect(offline.sources[1].buffer?.numberOfChannels).toBe(2);
    expect(offline.sources[1].loop).toBe(true);
    expect(offline.sources.slice(2, 5).map((source) => source.gain?.channelCount)).toEqual([2, 2, 2]);
    expect(offline.sources.slice(5).map((source) => source.gain?.channelCount)).toEqual([1, 1, 1]);
    expect(offline.panners.map((panner) => panner.pan.value)).toEqual([-0.12, 0.12]);
    expect(offline.hrtfPanners.map((panner) => [panner.panningModel, panner.positionX.value, panner.positionY.value, panner.positionZ.value, panner.rolloffFactor])).toEqual([
      ['HRTF', -0.75, 0, -1, 0], ['HRTF', 0.75, 0, -1, 0], ['HRTF', 0, 0, -1, 0],
    ]);
    expect(result.warnings.join(' ')).toContain('창작적 자동 배치');
    expect(result.events.map((event) => event.label)).toEqual(['빗소리', '숲', '바다', '발소리', '문 여닫는 소리', '책장 넘기는 소리']);
    expect(encoded.settings).toEqual([{ channels: 2, rate: 44100, bitrate: 192 }]);
    expect(encoded.blocks.map((block) => block.left.length)).toEqual([1152, 1152, 1152, 954]);
    expect(encoded.blocks.every((block) => block.right?.length === block.left.length)).toBe(true);
  });

  it.each(['create', 'configure'] as const)('falls back to stereo pan when HRTF %s fails, warning without losing effects', async (failure) => {
    hrtfFailure = failure;
    const result = await mixSoundscape(voice(), [cue('발소리가'), cue('문을 열었다', 8), cue('책장을 넘겼다', 16)], { ...options, spatial: true });
    const offline = offlineInstances[0];
    expect(offline.panners.map((p) => p.pan.value)).toEqual([-0.25, 0.25, 0]);
    expect(offline.sources.slice(1).map((source) => source.gain?.connections.length)).toEqual([1, 1, 1]);
    expect(result.events).toHaveLength(3);
    expect(result.warnings.filter((w) => w.includes('일반 스테레오 패닝'))).toHaveLength(1);
  });

  it('keeps sound centered and warns if both HRTF and stereo panning are unavailable', async () => {
    hrtfFailure = 'create';
    stereoFailure = true;
    const result = await mixSoundscape(voice(), [cue('발소리가')], { ...options, spatial: true });
    const offline = offlineInstances[0];
    expect(offline.sources[1].gain?.connections).toEqual([offline.destination]);
    expect(result.events).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('HRTF를 사용할 수 없어');
    expect(result.warnings.join(' ')).toContain('중앙에 배치');
  });

  it('scales both encoded stereo channels equally when either side exceeds peak headroom', async () => {
    renderedLeftLevel = 2;
    renderedRightLevel = 1;
    await mixSoundscape(voice(), [], { ...options, effects: false, spatial: true });
    expect(encoded.blocks[0].left[0]).toBe(Math.round(0.98 * 32767));
    expect(encoded.blocks[0].right?.[0]).toBe(Math.round(0.49 * 32767));
  });

  it('rejects a non-boolean spatial option', async () => {
    await expect(mixSoundscape(voice(), [], { ...options, spatial: 'on' } as unknown as MixOptions)).rejects.toThrow('음향 설정');
    expect(decoderInstances).toHaveLength(0);
  });

  it('applies a fixed attenuation on top of the user-selected effect volume', async () => {
    await mixSoundscape(voice(), [cue('발소리가 났다')], { ...options, effectsVolume: 0.5 });
    expect(Math.max(...offlineInstances[0].sources[1].gain!.gain.values)).toBeCloseTo(0.075 * 0.5);
  });

  it('further attenuates unexpectedly loud assets instead of drowning out the voice', async () => {
    assetLevel = 0.5;
    await mixSoundscape(voice(), [cue('발소리가 났다')], { ...options, effectsVolume: 1 });
    expect(Math.max(...offlineInstances[0].sources[1].gain!.gain.values)).toBeCloseTo(0.01);
  });

  it('checks each stereo asset channel even when opposing phases cancel in mono', async () => {
    assetChannels = 2;
    assetLevel = 0.5;
    assetRightLevel = -0.5;
    await mixSoundscape(voice(), [cue('비가')], { ...options, spatial: true });
    expect(Math.max(...offlineInstances[0].sources[1].gain!.gain.values)).toBeCloseTo(0.01);
  });

  it('does not fetch or report events for zero volume or switched-off audio', async () => {
    const result = await mixSoundscape(voice(), [cue('비가')], { ...options, music: true, musicVolume: 0, effectsVolume: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.events).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('reports bad cue times without placing effects outside narration', async () => {
    const result = await mixSoundscape(voice(), [cue('비', -1), cue('rain', 50), cue('비가', 39, 5)], options);
    expect(result.warnings[0]).toContain('2개');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].time).toBeGreaterThanOrEqual(39);
    expect(result.events[0].time).toBeLessThan(40);
    expect(offlineInstances[0].sources[1].stopTime).toBeLessThanOrEqual(40);
  });

  it('rejects narration over 10 minutes before creating the offline timeline or fetching assets', async () => {
    voiceDuration = 600.01;
    await expect(mixSoundscape(voice(), [cue('rain')], options)).rejects.toThrow('최대 10분');
    expect(offlineInstances).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(decoderInstances[0].closed).toBe(true);
  });

  it('reports missing or invalid files rather than silently omitting requested sounds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(mixSoundscape(voice(), [cue('rain')], options)).rejects.toThrow('/soundscape/rain.mp3');
    expect(decoderInstances[0].closed).toBe(true);
  });

  it('rejects invalid volume settings before starting audio', async () => {
    await expect(mixSoundscape(voice(), [], { ...options, musicVolume: 1.2 })).rejects.toThrow('0에서 1');
    expect(decoderInstances).toHaveLength(0);
  });

  it('honors cancellation during fetch and closes its decoder', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const controller = new AbortController();
    const progress = vi.fn();
    const promise = mixSoundscape(voice(), [cue('rain')], options, progress, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(decoderInstances[0].closed).toBe(true);
    expect(offlineInstances).toHaveLength(0);
    expect(progress.mock.calls.map(([message]) => message)).not.toContain('오디오 믹싱이 완료되었습니다.');
  });

  it('returns cancellation immediately even if offline rendering cannot be stopped', async () => {
    pendingRender = true;
    const controller = new AbortController();
    const progress = vi.fn();
    const promise = mixSoundscape(voice(), [], { ...options, effects: false }, progress, controller.signal);
    await vi.waitFor(() => expect(offlineInstances).toHaveLength(1));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(decoderInstances[0].closed).toBe(true);
    expect(progress.mock.calls.map(([message]) => message)).not.toContain('오디오 믹싱이 완료되었습니다.');
  });

  it('does not create the next offline context until the cancelled physical render settles', async () => {
    pendingRender = true;
    const controller = new AbortController();
    const first = mixSoundscape(voice(), [], { ...options, effects: false }, undefined, controller.signal);
    await vi.waitFor(() => expect(pendingRenders).toHaveLength(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const progress = vi.fn();
    const second = mixSoundscape(voice(), [], { ...options, effects: false }, progress);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith('이전 오디오 작업이 끝나기를 기다리고 있어요'));
    expect(offlineInstances).toHaveLength(1);
    expect(renderStarts).toBe(1);

    pendingRender = false;
    pendingRenders[0].resolve();
    expect((await second).blob.type).toBe('audio/mpeg');
    expect(offlineInstances).toHaveLength(2);
    expect(renderStarts).toBe(2);
  });

  it('honors abort while queued and lets a later request proceed after the active render', async () => {
    pendingRender = true;
    const first = mixSoundscape(voice(), [], { ...options, effects: false });
    await vi.waitFor(() => expect(pendingRenders).toHaveLength(1));
    const controller = new AbortController();
    const progress = vi.fn();
    const second = mixSoundscape(voice(), [], { ...options, effects: false }, progress, controller.signal);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith('이전 오디오 작업이 끝나기를 기다리고 있어요'));
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(decoderInstances[1].closed).toBe(true);

    const thirdProgress = vi.fn();
    const third = mixSoundscape(voice(), [], { ...options, effects: false }, thirdProgress);
    await vi.waitFor(() => expect(thirdProgress).toHaveBeenCalledWith('이전 오디오 작업이 끝나기를 기다리고 있어요'));
    expect(offlineInstances).toHaveLength(1);
    expect(renderStarts).toBe(1);
    pendingRender = false;
    pendingRenders[0].resolve();
    await expect(first).resolves.toMatchObject({ blob: expect.any(Blob) });
    await expect(third).resolves.toMatchObject({ blob: expect.any(Blob) });
    expect(renderStarts).toBe(2);
  });

  it('releases the slot when a physical render rejects, even after cancellation', async () => {
    pendingRender = true;
    const controller = new AbortController();
    const first = mixSoundscape(voice(), [], { ...options, effects: false }, undefined, controller.signal);
    await vi.waitFor(() => expect(pendingRenders).toHaveLength(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const progress = vi.fn();
    const second = mixSoundscape(voice(), [], { ...options, effects: false }, progress);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith('이전 오디오 작업이 끝나기를 기다리고 있어요'));
    expect(offlineInstances).toHaveLength(1);
    pendingRender = false;
    pendingRenders[0].reject(new Error('physical render failed'));
    await expect(second).resolves.toMatchObject({ blob: expect.any(Blob) });
    expect(renderStarts).toBe(2);
  });

  it('reports a render failure and lets the next queued render proceed', async () => {
    pendingRender = true;
    const first = mixSoundscape(voice(), [], { ...options, effects: false });
    const failure = expect(first).rejects.toThrow('physical render failed');
    await vi.waitFor(() => expect(pendingRenders).toHaveLength(1));
    const progress = vi.fn();
    const second = mixSoundscape(voice(), [], { ...options, effects: false }, progress);
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith('이전 오디오 작업이 끝나기를 기다리고 있어요'));
    expect(offlineInstances).toHaveLength(1);
    pendingRender = false;
    pendingRenders[0].reject(new Error('physical render failed'));
    await failure;
    await expect(second).resolves.toMatchObject({ blob: expect.any(Blob) });
    expect(renderStarts).toBe(2);
  });

  it('releases the slot if startRendering throws synchronously', async () => {
    syncRenderFailure = true;
    await expect(mixSoundscape(voice(), [], { ...options, effects: false })).rejects.toThrow('synchronous render failure');
    syncRenderFailure = false;
    await expect(mixSoundscape(voice(), [], { ...options, effects: false })).resolves.toMatchObject({ blob: expect.any(Blob) });
    expect(renderStarts).toBe(2);
  });

  it('releases the slot if offline context construction fails', async () => {
    offlineConstructionFailure = true;
    await expect(mixSoundscape(voice(), [], { ...options, effects: false })).rejects.toThrow('offline construction failed');
    offlineConstructionFailure = false;
    await expect(mixSoundscape(voice(), [], { ...options, effects: false })).resolves.toMatchObject({ blob: expect.any(Blob) });
    expect(renderStarts).toBe(1);
  });

  it('releases the slot if cancelled after acquisition and before context creation', async () => {
    const controller = new AbortController();
    const progress = (message: string) => {
      if (message === '낭독과 음향을 브라우저에서 믹싱합니다…') controller.abort();
    };
    await expect(mixSoundscape(voice(), [], { ...options, effects: false }, progress, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(offlineInstances).toHaveLength(0);
    await expect(mixSoundscape(voice(), [], { ...options, effects: false })).resolves.toMatchObject({ blob: expect.any(Blob) });
    expect(renderStarts).toBe(1);
  });
});
