import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasPendingSoundscapeWork, mixSoundscape, waitForSoundscapeIdle, type Cue, type CustomSoundRule, type EffectName, type MixOptions, type SoundRuleSettings } from './soundscape';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

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
let pendingDecode: 'voice' | 'asset' | undefined;
let pendingDecodes: { promise: Promise<FakeBuffer>; resolve: () => void; reject: (reason: Error) => void }[] = [];
let pendingReads: { promise: Promise<ArrayBuffer>; resolve: () => void; reject: (reason: Error) => void }[] = [];
let pendingClose = false;
let pendingCloses: { promise: Promise<void>; resolve: () => void; reject: (reason: Error) => void }[] = [];
let assetLevel = 0.01;
let assetRightLevel = 0.01;
let assetChannels = 1;
let renderedLeftLevel = 0.1;
let renderedRightLevel = 0.1;
let voiceTailSilence = false;
let hrtfFailure: 'none' | 'create' | 'configure' = 'none';
let stereoFailure = false;
let assetDecodeFailure = 0;
let decodedAssetIds: number[] = [];

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
  setTargetAtTime(value: number) { this.values.push(value); }
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
  async decodeAudioData(bytes: ArrayBuffer) {
    const isVoice = this.decodeCount++ === 0;
    if (!isVoice) {
      const id = new Uint8Array(bytes)[0];
      decodedAssetIds.push(id);
      if (id === assetDecodeFailure && id !== 0) throw new Error('bad encoded asset');
    }
    const result = new FakeBuffer(isVoice ? voiceDuration : 4, isVoice ? 1 : assetChannels);
    if (isVoice) {
      result.sampleRate = 1000;
      result.length = Math.round(voiceDuration * result.sampleRate);
      result.data = new Float32Array(result.length).fill(0.1);
      result.rightData = new Float32Array(result.length).fill(0.1);
      if (voiceTailSilence) result.data.fill(0, Math.floor(result.length * 0.9));
    } else {
      result.data.fill(assetLevel);
      result.rightData.fill(assetRightLevel);
    }
    if (pendingDecode === (isVoice ? 'voice' : 'asset')) {
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<FakeBuffer>((ok, fail) => {
        resolve = () => ok(result);
        reject = fail;
      });
      pendingDecodes.push({ promise, resolve, reject });
      return promise;
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
  async close() {
    this.closed = true;
    if (pendingClose) {
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
      pendingCloses.push({ promise, resolve, reject });
      return promise;
    }
  }
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
const effectUrls = ['rain', 'forest', 'ocean', 'footsteps', 'door', 'page'].map((name) => `/soundscape/tinyaudio-v1/${name}.mp3`);
const voice = () => new Blob([new Uint8Array([1])], { type: 'audio/mpeg' });
const cue = (text: string, start = 0, duration = 4): Cue => ({ text, start, duration });

beforeEach(() => {
  voiceDuration = 40;
  pendingRender = false;
  syncRenderFailure = false;
  offlineConstructionFailure = false;
  renderStarts = 0;
  pendingRenders = [];
  pendingDecode = undefined;
  pendingDecodes = [];
  pendingReads = [];
  pendingClose = false;
  pendingCloses = [];
  assetLevel = 0.01;
  assetRightLevel = 0.01;
  assetChannels = 1;
  renderedLeftLevel = 0.1;
  renderedRightLevel = 0.1;
  voiceTailSilence = false;
  hrtfFailure = 'none';
  stereoFailure = false;
  assetDecodeFailure = 0;
  decodedAssetIds = [];
  offlineInstances = [];
  decoderInstances = [];
  encoded.settings.length = 0;
  encoded.blocks.length = 0;
  vi.stubGlobal('window', { AudioContext: FakeAudioContext, OfflineAudioContext: FakeOffline });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
});
afterEach(async () => {
  // A cancelled wait does not cancel physical work: settle every fake so its
  // module-level tracker and render reservation never leak into the next test.
  pendingRender = false;
  pendingDecode = undefined;
  pendingClose = false;
  pendingRenders.forEach((render) => render.resolve());
  pendingDecodes.forEach((decode) => decode.resolve());
  pendingReads.forEach((read) => read.resolve());
  pendingCloses.forEach((close) => close.resolve());
  await Promise.allSettled([...pendingRenders, ...pendingDecodes, ...pendingReads, ...pendingCloses].map((work) => work.promise));
  await waitForSoundscapeIdle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('mixSoundscape', () => {
  // Each row has its own cue and mix so cooldown/density limits cannot hide a
  // false positive or negative in the local keyword heuristic.
  it.each([
    ['소나기가 쏟아졌다.', '빗소리'],
    ['폭우가 내렸다.', '빗소리'],
    ['가랑비가 내렸다.', '빗소리'],
    ['삼림에 들어갔다.', '숲'],
    ['산림이 보였다.', '숲'],
    ['해변에서 쉬었다.', '바다'],
    ['바닷소리가 들렸다.', '바다'],
    ['그는 천천히 걸어갔다.', '발소리'],
    ['그녀는 길을 걸었다.', '발소리'],
    ['발걸음이 들렸다.', '발소리'],
    ['문이 쾅 닫혔다.', '문 여닫는 소리'],
    ['그가 문을 밀어 열었다.', '문 여닫는 소리'],
    ['책장을 한 장 넘겼다.', '책장 넘기는 소리'],
    ['페이지가 바스락거렸다.', '책장 넘기는 소리'],
    ['A downpour began.', '빗소리'],
    ['They entered the woods.', '숲'],
    ['A woodland stood nearby.', '숲'],
    ['They reached the sea.', '바다'],
    ['Waves crashed.', '바다'],
    ['She walked down the path.', '발소리'],
    ['The door creaked open.', '문 여닫는 소리'],
    ['He slammed the door.', '문 여닫는 소리'],
    ['The door was opened.', '문 여닫는 소리'],
    ['He flipped through the pages.', '책장 넘기는 소리'],
    ['The pages rustled.', '책장 넘기는 소리'],
    ['She opened her book.', '책장 넘기는 소리'],
    ['The rain did not stop.', '빗소리'],
    ['The rain did not let up.', '빗소리'],
    ["The rain hadn't stopped.", '빗소리'],
    ['The rain never stopped.', '빗소리'],
    ['The rain had never stopped.', '빗소리'],
    ['The rain had never yet stopped.', '빗소리'],
    ['The rain has not yet stopped.', '빗소리'],
    ['The rain had not yet let up.', '빗소리'],
    ['비가 멈추지 않았다.', '빗소리'],
    ['비가 그치지 않았다.', '빗소리'],
    ['비가 안 그쳤다.', '빗소리'],
    ['비가 아직 안 그쳤다.', '빗소리'],
    ['비가 안 멈췄다.', '빗소리'],
    ['비가 내릴 것 같았다.', '빗소리'],
    ['문을 열고 싶었다.', '문 여닫는 소리'],
    ['It will rain.', '빗소리'],
    ['The rain will not stop.', '빗소리'],
    ["The rain won't stop.", '빗소리'],
    ["It won't stop raining.", '빗소리'],
    ['It will not stop raining.', '빗소리'],
    ['The rain cannot stop.', '빗소리'],
    ['It cannot stop raining.', '빗소리'],
    ['It did not not rain.', '빗소리'],
    ["It didn't not rain.", '빗소리'],
    ['비가 내리지 않은 것은 아니었다.', '빗소리'],
    ['문을 열지 않은 것은 아니었다.', '문 여닫는 소리'],
    ['문을 열려고 했다.', '문 여닫는 소리'],
    ['문을 열려고 하지 않은 것은 아니었다.', '문 여닫는 소리'],
  ])('recognizes the positive cue %s', async (text, label) => {
    const result = await mixSoundscape(voice(), [cue(text)], options);
    expect(result.events.map((event) => event.label)).toEqual([label]);
  });

  it.each([
    ['비가 내렸다.', '빗소리'],
    ['문을 열었다.', '문 여닫는 소리'],
    ['그녀가 책장을 넘겼다.', '책장 넘기는 소리'],
  ])('matches decomposed Korean with the same timing as composed text: %s', async (text, label) => {
    const composed = await mixSoundscape(voice(), [cue(text)], options);
    const decomposed = await mixSoundscape(voice(), [cue(text.normalize('NFD'))], options);
    expect(decomposed.events).toEqual(composed.events);
    expect(decomposed.events.map((event) => event.label)).toEqual([label]);
  });

  it.each([
    ['비가 내릴 것 같지 않았다.', []],
    ['문을 열고 싶지 않았다.', []],
    ['비가 안 그쳤다.', ['빗소리']],
    ['비가 내릴 것 같지 않지만 문을 열었다.', ['문 여닫는 소리']],
  ])('keeps negation and continuation equivalent after NFC analysis: %s', async (text, labels) => {
    const composed = await mixSoundscape(voice(), [cue(text)], options);
    const decomposed = await mixSoundscape(voice(), [cue(text.normalize('NFD'))], options);
    expect(decomposed.events).toEqual(composed.events);
    expect(decomposed.events.map((event) => event.label)).toEqual(labels);
  });

  it.each([
    '소나기가 내리지 않았다.',
    '비가 안 내렸다.',
    '비가 내릴 것 같지 않았다.',
    '그는 비가 온다고 말하지 않았다.',
    '그녀는 문을 열었다고 말하지 않았다.',
    '그는 책장을 넘겼다고 말하지 않았다.',
    '폭우는 그쳤다.',
    '비가 멈췄다.',
    '빗소리가 멈추었다.',
    '숲이 보이지 않았다.',
    '숲에 가지 않았다.',
    '해변이 보이지 않았다.',
    '바다로 가지 않았다.',
    '파도 소리는 들리지 않았다.',
    '발소리가 나지 않았다.',
    '그는 걸어가지 않았다.',
    '그는 안 걸었다.',
    '그는 문을 안 열었다.',
    '그는 문을 열지 않았다.',
    '문을 열려고 하지 않았다.',
    '문을 열려고는 하지 않았다.',
    '문을 열려고 하지도 않았다.',
    '그녀는 책장을 넘기려고 하지 않았다.',
    '문을 열고 싶지 않았다.',
    '문을 열고 싶지는 않았다.',
    '문을 열 수 없었다.',
    '책을 펼치지 않았다.',
    '책장을 넘기지 못했다.',
    'There was no downpour.',
    'It did not rain.',
    "It won't rain.",
    'It won’t rain.',
    'It will not rain.',
    'It cannot rain.',
    "The rain won't fall.",
    'The rain cannot fall.',
    "She won't open the door.",
    'She cannot open the door.',
    'It has not yet rained.',
    "It hasn't yet rained.",
    'The rain had not yet fallen.',
    'The rain never fell.',
    "The rain wasn't falling.",
    'The rain stopped.',
    'There was no forest.',
    'They sailed without the ocean in sight.',
    'No waves crashed.',
    'She did not walk.',
    'No footsteps echoed.',
    'He did not open the door.',
    'He had not yet opened the door.',
    'He had never yet opened the door.',
    "He hadn't yet opened the door.",
    'He had not  yet opened the door.',
    "He didn't open the door.",
    'She did not say that the door opened.',
    'She never turned the page.',
    'He did not flip through the pages.',
  ])('rejects the negated cue %s', async (text) => {
    const result = await mixSoundscape(voice(), [cue(text)], options);
    expect(result.events).toEqual([]);
  });

  it.each([
    ['비가 내리고 그는 말하지 않았다.', '빗소리'],
    ['비가 내리고 그는 비가 온다고 말하지 않았다.', '빗소리'],
    ['비가 오고 문을 열지 않았다.', '빗소리'],
    ['비가 오지 않았지만 문을 열었다.', '문 여닫는 소리'],
    ['비가 내릴 것 같지 않지만 문을 열었다.', '문 여닫는 소리'],
    ['문을 열고 비가 오지 않았다.', '문 여닫는 소리'],
    ['문을 열고 아무 말도 하지 않았다.', '문 여닫는 소리'],
    ['문을 열고 싶지 않지만 책장을 넘겼다.', '책장 넘기는 소리'],
    ['책장을 넘기고 그는 말하지 않았다.', '책장 넘기는 소리'],
    ['비가 오지 않았지만 발소리가 들렸다.', '발소리'],
    ['비가 내리고 바다는 보이지 않았다.', '빗소리'],
    ['문을 열지 않고 책장을 넘겼다.', '책장 넘기는 소리'],
    ['비가 오지 않지만 바다가 보였다.', '바다'],
    ['Rain fell, but she did not open the door.', '빗소리'],
    ['rain fell, yet the door did not open', '빗소리'],
    ['Rain fell yet the door did not open.', '빗소리'],
    ['No rain yet the door opened.', '문 여닫는 소리'],
    ['The door opened yet it had not yet rained.', '문 여닫는 소리'],
    ['He did not open the door, but it rained.', '빗소리'],
    ['No rain, but footsteps echoed.', '발소리'],
    ['She opened the door and never mentioned the rain.', '문 여닫는 소리'],
    ['The rain stopped, but she opened the door.', '문 여닫는 소리'],
    ['비가 내리지 않았지만 나중에 비가 쏟아졌다.', '빗소리'],
    ['It did not rain but later it rained.', '빗소리'],
    ['He never opened the door but later opened the door.', '문 여닫는 소리'],
  ])('keeps independent positive and negative clauses separate: %s', async (text, label) => {
    const result = await mixSoundscape(voice(), [cue(text)], options);
    expect(result.events.map((event) => event.label)).toEqual([label]);
  });

  it('keeps established scene cues over inferred walking, but retains explicit footsteps', async () => {
    for (const text of ['He walked into the forest.', '그는 숲에서 걸었다.']) {
      const result = await mixSoundscape(voice(), [cue(text)], options);
      expect(result.events.map((event) => event.label)).toEqual(['숲']);
    }
    const explicit = await mixSoundscape(voice(), [cue('footsteps in the forest', 0, 30)], options);
    expect(explicit.events.map((event) => event.label)).toEqual(['발소리', '숲']);
    const absentScene = await mixSoundscape(voice(), [cue('He walked, but there was no forest.')], options);
    expect(absentScene.events.map((event) => event.label)).toEqual(['발소리']);
  });

  it.each([
    ['비가 내리고 문을 열었다.', ['빗소리', '문 여닫는 소리']],
    ['비가 안 그쳤지만 문을 열었다.', ['빗소리', '문 여닫는 소리']],
    ['Rain fell and she opened the door.', ['빗소리', '문 여닫는 소리']],
    ['Rain fell yet the door opened.', ['빗소리', '문 여닫는 소리']],
    ['비가 내렸고 발소리는 없었지만 문을 열었다.', ['빗소리', '문 여닫는 소리']],
    ['No rain, but the forest was quiet and he opened the door.', ['숲', '문 여닫는 소리']],
    ['비가 내리고 그는 천천히 걸었다.', ['빗소리', '발소리']],
    ['Rain fell. She walked.', ['빗소리', '발소리']],
    ['He walked and the forest appeared.', ['발소리', '숲']],
    ['He walked into the forest. Later he walked.', ['숲', '발소리']],
  ])('plans independent non-overlapping positives in one cue: %s', async (text, labels) => {
    const result = await mixSoundscape(voice(), [cue(text, 0, 38)], options);
    expect(result.events.map((event) => event.label)).toEqual(labels);
  });

  it('keeps identical fixed asset requests for newly recognized and negated cues', async () => {
    for (const text of ['소나기가 내렸다', '비가 오지 않았지만 문을 열었다', 'She walked', '비밀과 비용']) {
      vi.mocked(fetch).mockClear();
      await mixSoundscape(voice(), [cue(text)], options);
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
      for (const [, init] of vi.mocked(fetch).mock.calls) expect(init).toEqual({ credentials: 'same-origin', signal: undefined });
    }
  });

  it.each([
    '비밀과 비용, 비빔밥과 비상.',
    '문제와 문서, 방문객과 주문.',
    '바다표범과 파도타기.',
    '책상과 책갈피, 책장 선반과 페이지 번호.',
    'rainbow and brainstorm and rainfalling',
    'forestry and oceanic and seawater',
    'She waves goodbye.',
    'The door stood still by page 42.',
    'The open door and the closed door.',
    'The door is open.',
    '문이 열려 있었다.',
    '책이 펼쳐져 있었다.',
  ])('does not treat a substring, static object or state as an action: %s', async (text) => {
    const result = await mixSoundscape(voice(), [cue(text)], options);
    expect(result.events).toEqual([]);
  });

  it('uses the Vite base for every same-origin asset without exposing manuscript cues', async () => {
    vi.stubEnv('BASE_URL', '/narrow/');
    vi.resetModules();
    const { mixSoundscape: mixUnderBase } = await import('./soundscape');
    for (const text of ['rain', 'forest', 'quiet']) {
      vi.mocked(fetch).mockClear();
      await mixUnderBase(voice(), [cue(text)], { ...options, music: true });
      const requests = vi.mocked(fetch).mock.calls;
      expect(requests.map(([url]) => url)).toEqual([
        '/narrow/soundscape/music-calm.mp3',
        ...effectUrls.map(url => `/narrow${url}`),
      ]);
      for (const [, init] of requests) expect(init).toEqual({ credentials: 'same-origin', signal: undefined });
    }
  });

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
    expect(result.warnings).toEqual(['음향 간격·반복 제한으로 효과음 단서 2개를 생략했습니다. 서로 다른 사건도 포함될 수 있습니다.']);
  });

  it('allows one background and one action to overlap, without stacking nearby actions', async () => {
    const result = await mixSoundscape(voice(), [
      cue('비가', 0), cue('문을 열었다', 3), cue('발소리가', 6), cue('숲에', 7),
    ], options);
    expect(result.events.map((event) => event.label)).toEqual(['빗소리', '문 여닫는 소리', '숲']);
  });

  it.each([
    [[cue('문을 열었다.', 0, 2), cue('책장을 넘겼다.', 4, 2)], '문 여닫는 소리'],
    [[cue('문을 열었다.', 0, 2), cue('문을 닫았다.', 15, 2)], '문 여닫는 소리'],
    [[cue('비가 내렸다.', 0, 2), cue('비가 내렸다.', 20, 2)], '빗소리'],
  ])('reports when conservative density rules omit even separate non-overlapping candidates', async (cues, label) => {
    const result = await mixSoundscape(voice(), cues, options);
    expect(result.events.map((event) => event.label)).toEqual([label]);
    expect(result.warnings.join(' ')).toContain('효과음 단서 1개');
    expect(result.warnings.join(' ')).toContain('생략');
  });

  it('keeps overlap and crowding limits and reports the exact omitted candidate count', async () => {
    const result = await mixSoundscape(voice(), [
      cue('비가', 0, 2), cue('문을 열었다', 1, 2), cue('문을 열었다', 3, 2),
      cue('책장을 넘겼다', 7, 2), cue('바다에서', 9, 2),
    ], options);
    expect(result.events.map((event) => event.label)).toEqual(['빗소리', '문 여닫는 소리', '바다']);
    expect(result.warnings.join(' ')).toContain('효과음 단서 2개');
    const sources = offlineInstances[0].sources.slice(1);
    expect(sources[0].stopTime).toBeGreaterThan(sources[1].startTime); // ambient + action allowed
    for (let i = 1; i < sources.length; i++) expect(sources[i].startTime - sources[i - 1].startTime).toBeGreaterThanOrEqual(2);
  });

  it('allows independent groups to overlap but not effects in the same group', async () => {
    const result = await mixSoundscape(voice(), [
      cue('비가', 0, 2), cue('문을 열었다', 3, 2), cue('바다에서', 7, 2), cue('책장을 넘겼다', 10, 2),
    ], options);
    expect(result.events.map((event) => event.label)).toEqual(['빗소리', '문 여닫는 소리', '바다', '책장 넘기는 소리']);
    expect(result.warnings).toEqual([]);
    const [rain, door, ocean, page] = offlineInstances[0].sources.slice(1);
    expect(rain.stopTime).toBeGreaterThan(door.startTime);
    expect(ocean.stopTime).toBeGreaterThan(page.startTime);
    expect(rain.stopTime).toBeLessThanOrEqual(ocean.startTime);
    expect(door.stopTime).toBeLessThanOrEqual(page.startTime);
  });

  it('moves a final action earlier within its cue when needed to leave audible output', async () => {
    voiceDuration = 3;
    voiceTailSilence = true;
    const result = await mixSoundscape(voice(), [cue('문을 열었다.', 0, 3)], options);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].time).toBeLessThanOrEqual(2.2);
    const source = offlineInstances[0].sources[1];
    expect(source.stopTime - source.startTime).toBeGreaterThanOrEqual(0.799);
  });

  it('omits and explains a final effect when its cue is too short to play', async () => {
    voiceDuration = 0.5;
    const result = await mixSoundscape(voice(), [cue('문을 열었다.', 0, 0.5)], options);
    expect(result.events).toEqual([]);
    expect(offlineInstances[0].sources).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('재생 시간이 부족한 효과음');
    expect(result.warnings.join(' ')).not.toContain('단서를 찾지 못해');
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
    // Wide ambience now uses a mono-safe crossfeed matrix, not StereoPanner.
    expect(offline.panners).toEqual([]);
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
    const distanceGain = offline.sources[1].gain?.connections[0] as FakeGain;
    const soundBus = distanceGain.connections[0] as FakeGain;
    expect(soundBus.connections).toEqual([offline.destination]);
    expect(result.events).toHaveLength(1);
    expect(result.warnings.join(' ')).not.toContain('일반 스테레오 패닝');
    expect(result.warnings.join(' ')).toContain('중앙에 배치');
  });

  it('scales both encoded stereo channels equally when either side exceeds peak headroom', async () => {
    renderedLeftLevel = 2;
    renderedRightLevel = 1;
    await mixSoundscape(voice(), [], { ...options, effects: false, spatial: true });
    expect(encoded.blocks[0].left[0]).toBe(Math.round(0.84 * 32767));
    expect(encoded.blocks[0].right?.[0]).toBe(Math.round(0.42 * 32767));
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
    await expect(mixSoundscape(voice(), [cue('rain')], options)).rejects.toThrow('/soundscape/tinyaudio-v1/rain.mp3');
    expect(decoderInstances[0].closed).toBe(true);
  });

  it('fetches and consumes all effect responses but decodes only needed assets', async () => {
    const reads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => {
        reads.push(url);
        return new Uint8Array([effectUrls.indexOf(url) + 1]).buffer;
      },
    })));
    assetDecodeFailure = 6; // A broken page must not affect rain or a music-only mix.
    const rain = await mixSoundscape(voice(), [cue('rain')], options);
    expect(rain.events.map((event) => event.label)).toEqual(['빗소리']);
    expect(decodedAssetIds).toEqual([1]);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
    expect(reads).toEqual(effectUrls);
    decodedAssetIds = [];
    reads.length = 0;
    vi.mocked(fetch).mockClear();
    const none = await mixSoundscape(voice(), [], options);
    expect(none.events).toEqual([]);
    expect(decodedAssetIds).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
    expect(reads).toEqual(effectUrls);
  });

  it('ignores unused fetch failures while retaining music, and completes identical requests before required failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/page.mp3')
      ? { ok: false, status: 404 }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
    const mixed = await mixSoundscape(voice(), [cue('rain')], { ...options, music: true });
    expect(mixed.events.map((event) => event.label)).toEqual(['빗소리']);
    expect(offlineInstances[0].sources).toHaveLength(3); // voice, music, rain
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/soundscape/music-calm.mp3', ...effectUrls]);
    vi.mocked(fetch).mockClear();
    await expect(mixSoundscape(voice(), [cue('책장을 넘겼다')], { ...options, music: true }))
      .rejects.toThrow('/soundscape/tinyaudio-v1/page.mp3');
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/soundscape/music-calm.mp3', ...effectUrls]);
    expect(decoderInstances[1].closed).toBe(true);
  });

  it('completes all fixed requests before reporting a required effect or music failure', async () => {
    for (const failed of ['/soundscape/tinyaudio-v1/rain.mp3', '/soundscape/music-calm.mp3']) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url === failed
        ? { ok: false, status: 503 }
        : { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
      await expect(mixSoundscape(voice(), [cue('rain')], { ...options, music: true })).rejects.toThrow(failed);
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/soundscape/music-calm.mp3', ...effectUrls]);
    }
  });

  it('ignores unused body-read errors but reports a required body-read error after every request', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => {
        if (url.endsWith('/page.mp3')) throw new Error('body interrupted');
        return new ArrayBuffer(1);
      },
    })));
    const result = await mixSoundscape(voice(), [cue('rain')], { ...options, music: true });
    expect(result.events.map((event) => event.label)).toEqual(['빗소리']);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/soundscape/music-calm.mp3', ...effectUrls]);
    vi.mocked(fetch).mockClear();
    await expect(mixSoundscape(voice(), [cue('책장을 넘겼다')], { ...options, music: true })).rejects.toThrow('body interrupted');
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/soundscape/music-calm.mp3', ...effectUrls]);
  });

  it('reports a required decode failure only after all fixed network requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true, arrayBuffer: async () => new Uint8Array([effectUrls.indexOf(url) + 1]).buffer,
    })));
    assetDecodeFailure = 1;
    const original = voice();
    const before = Array.from(new Uint8Array(await original.arrayBuffer()));
    await expect(mixSoundscape(original, [cue('rain')], options)).rejects.toThrow('디코딩하지 못했습니다');
    expect(Array.from(new Uint8Array(await original.arrayBuffer()))).toEqual(before);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
    expect(decoderInstances[0].closed).toBe(true);
    expect(offlineInstances).toHaveLength(0);
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
    // A network fetch itself does not hold the physical-memory tracker open.
    await waitForSoundscapeIdle();
    expect(hasPendingSoundscapeWork()).toBe(false);
  });

  it.each(['voice', 'asset'] as const)('waits for the physical %s decode after cancellation', async (kind) => {
    pendingDecode = kind;
    const controller = new AbortController();
    const mixing = mixSoundscape(voice(), [cue('rain')], options, undefined, controller.signal);
    await vi.waitFor(() => expect(pendingDecodes).toHaveLength(1));
    controller.abort();
    await expect(mixing).rejects.toMatchObject({ name: 'AbortError' });

    let idle = false;
    const waiting = waitForSoundscapeIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(hasPendingSoundscapeWork()).toBe(true);
    // A rejected decoder must release the tracker just as a resolved one does.
    if (kind === 'voice') pendingDecodes[0].reject(new Error('late decode failure'));
    else pendingDecodes[0].resolve();
    await waiting;
    expect(idle).toBe(true);
    expect(hasPendingSoundscapeWork()).toBe(false);
  });

  it('also waits for decoder close after a cancelled decode, including a late close failure', async () => {
    pendingDecode = 'voice';
    pendingClose = true;
    const controller = new AbortController();
    const mixing = mixSoundscape(voice(), [], options, undefined, controller.signal);
    await vi.waitFor(() => expect(pendingDecodes).toHaveLength(1));
    controller.abort();
    await expect(mixing).rejects.toMatchObject({ name: 'AbortError' });
    expect(pendingCloses).toHaveLength(1);
    let idle = false;
    const waiting = waitForSoundscapeIdle().then(() => { idle = true; });
    pendingDecodes[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(idle).toBe(false);
    pendingCloses[0].reject(new Error('late close failure'));
    await waiting;
    expect(idle).toBe(true);
  });

  it.each(['voice', 'asset'] as const)('waits for the physical %s byte read after cancellation', async (kind) => {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<ArrayBuffer>((ok, fail) => {
      resolve = () => ok(new ArrayBuffer(1));
      reject = fail;
    });
    pendingReads.push({ promise, resolve, reject });
    const read = vi.fn(() => promise);
    const blob = voice();
    if (kind === 'voice') vi.spyOn(blob, 'arrayBuffer').mockImplementation(read);
    else vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: read })));
    const controller = new AbortController();
    const mixing = mixSoundscape(blob, [], options, undefined, controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(mixing).rejects.toMatchObject({ name: 'AbortError' });

    let idle = false;
    const waiting = waitForSoundscapeIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    if (kind === 'voice') reject(new Error('late read failure'));
    else resolve();
    await waiting;
    expect(idle).toBe(true);
    expect(decoderInstances[0].decodeCount).toBe(kind === 'voice' ? 0 : 1);
  });

  it('does not start asset decoding when its body resolves immediately before cancellation', async () => {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<ArrayBuffer>((ok, fail) => {
      resolve = () => ok(new ArrayBuffer(1));
      reject = fail;
    });
    pendingReads.push({ promise, resolve, reject });
    const read = vi.fn(() => promise);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: read })));
    const controller = new AbortController();
    const mixing = mixSoundscape(voice(), [], options, undefined, controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    resolve();
    controller.abort();
    await expect(mixing).rejects.toMatchObject({ name: 'AbortError' });
    await waitForSoundscapeIdle();
    expect(decoderInstances[0].decodeCount).toBe(1);
  });

  it('does not report idle between byte reading and the next physical decode', async () => {
    pendingDecode = 'voice';
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<ArrayBuffer>((ok, fail) => {
      resolve = () => ok(new ArrayBuffer(1));
      reject = fail;
    });
    pendingReads.push({ promise, resolve, reject });
    const blob = voice();
    const read = vi.spyOn(blob, 'arrayBuffer').mockReturnValue(promise);
    const controller = new AbortController();
    const mixing = mixSoundscape(blob, [], options, undefined, controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let idle = false;
    const waiting = waitForSoundscapeIdle().then(() => { idle = true; });
    resolve();
    await vi.waitFor(() => expect(pendingDecodes).toHaveLength(1));
    expect(idle).toBe(false);
    controller.abort();
    await expect(mixing).rejects.toMatchObject({ name: 'AbortError' });
    expect(idle).toBe(false);
    pendingDecodes[0].resolve();
    await waiting;
    expect(idle).toBe(true);
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
    let idle = false;
    const waiting = waitForSoundscapeIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    pendingRenders[0].resolve();
    await waiting;
    expect(idle).toBe(true);
  });

  it('keeps all idle waiters blocked until concurrent cancelled physical operations settle', async () => {
    pendingRender = true;
    const renderController = new AbortController();
    const rendering = mixSoundscape(voice(), [], { ...options, effects: false }, undefined, renderController.signal);
    await vi.waitFor(() => expect(pendingRenders).toHaveLength(1));
    renderController.abort();
    await expect(rendering).rejects.toMatchObject({ name: 'AbortError' });

    let firstIdle = false;
    const firstWaiter = waitForSoundscapeIdle().then(() => { firstIdle = true; });
    pendingDecode = 'voice';
    const decodeController = new AbortController();
    const decoding = mixSoundscape(voice(), [], options, undefined, decodeController.signal);
    await vi.waitFor(() => expect(pendingDecodes).toHaveLength(1));
    decodeController.abort();
    await expect(decoding).rejects.toMatchObject({ name: 'AbortError' });
    let secondIdle = false;
    const secondWaiter = waitForSoundscapeIdle().then(() => { secondIdle = true; });

    pendingRenders[0].reject(new Error('late render failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(firstIdle).toBe(false);
    expect(secondIdle).toBe(false);
    pendingDecodes[0].resolve();
    await Promise.all([firstWaiter, secondWaiter]);
    expect(firstIdle).toBe(true);
    expect(secondIdle).toBe(true);
  });

  it('rechecks idle if new work starts before a released waiter resumes', async () => {
    pendingRender = true;
    const firstController = new AbortController();
    const first = mixSoundscape(voice(), [], { ...options, effects: false }, undefined, firstController.signal);
    await vi.waitFor(() => expect(pendingRenders).toHaveLength(1));
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    let idle = false;
    const waiting = waitForSoundscapeIdle().then(() => { idle = true; });
    const nextController = new AbortController();
    let next!: Promise<unknown>;
    void pendingRenders[0].promise.then(() => {
      pendingDecode = 'voice';
      next = mixSoundscape(voice(), [], options, undefined, nextController.signal);
    });
    pendingRenders[0].resolve();
    await vi.waitFor(() => expect(pendingDecodes).toHaveLength(1));
    expect(idle).toBe(false);
    nextController.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    pendingDecodes[0].resolve();
    await waiting;
    expect(idle).toBe(true);
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

describe('custom sound rules', () => {
  const rule = (phrase: string, effect: EffectName, id = phrase.trim().normalize('NFC'), enabled = true): CustomSoundRule => ({ id, phrase, effect, enabled });
  const settings = (customRules: CustomSoundRule[] = [], disabledBuiltins: EffectName[] = []): SoundRuleSettings => ({ customRules, disabledBuiltins });
  const withRules = (soundRules: SoundRuleSettings): MixOptions => ({ ...options, soundRules });

  it('preserves default events, warnings, scheduled sources, encoded output and requests when rules are omitted or empty', async () => {
    const cues = [cue('rain', 0), cue('opened the door', 1), cue('forest', 12)];
    const original = await mixSoundscape(voice(), cues, options);
    const firstSources = offlineInstances[0].sources.map(({ startTime, stopTime }) => ({ startTime, stopTime }));
    const originalBytes = Array.from(new Uint8Array(await original.blob.arrayBuffer()));
    for (const config of [settings(), null, undefined, {}, [], 42, 'bad']) {
      vi.mocked(fetch).mockClear();
      const current = await mixSoundscape(voice(), cues, { ...options, soundRules: config } as MixOptions);
      expect(current.events).toEqual(original.events);
      expect(current.warnings).toEqual(original.warnings);
      expect(Array.from(new Uint8Array(await current.blob.arrayBuffer()))).toEqual(originalBytes);
      expect(offlineInstances.at(-1)!.sources.map(({ startTime, stopTime }) => ({ startTime, stopTime }))).toEqual(firstSources);
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
    }
  });

  it.each([
    ['rain', 'rain', 'drizzle', '빗소리'],
    ['forest', 'forest', 'thicket', '숲'],
    ['ocean', 'ocean', 'seashore', '바다'],
    ['footsteps', 'footsteps', 'pattering', '발소리'],
    ['door', 'opened the door', 'creaking portal', '문 여닫는 소리'],
    ['page', 'turned the page', 'rustling paper', '책장 넘기는 소리'],
  ] as [EffectName, string, string, string][])('disables only built-in %s while its enabled custom rule still mixes', async (effect, builtin, customPhrase, label) => {
    const config = settings([rule(customPhrase, effect)], [effect]);
    const disabled = await mixSoundscape(voice(), [cue(builtin)], withRules(config));
    expect(disabled.events).toEqual([]);
    const enabled = await mixSoundscape(voice(), [cue(customPhrase)], withRules(config));
    expect(enabled.events.map((event) => event.label)).toEqual([label]);
    expect(offlineInstances.at(-1)!.sources).toHaveLength(2);
    expect(offlineInstances.at(-1)!.sources[1].startTime).toBe(enabled.events[0].time);
    expect(offlineInstances.at(-1)!.sources[1].stopTime).toBeGreaterThan(enabled.events[0].time);
    const noLongerDisabled = await mixSoundscape(voice(), [cue(builtin)], withRules(settings()));
    expect(noLongerDisabled.events.map((event) => event.label)).toEqual([label]);
  });

  it('allows a different built-in and multiple custom effects in the same cue', async () => {
    const text = 'Rain fell. Later a mysterious creak echoed. Much later a silent clearing appeared.';
    const result = await mixSoundscape(voice(), [cue(text, 0, 38)], withRules(settings([
      rule('mysterious creak', 'door'), rule('silent clearing', 'forest'),
    ], ['ocean'])));
    expect(result.events.map((event) => event.label)).toEqual(['빗소리', '문 여닫는 소리', '숲']);
    expect(result.warnings).toEqual([]);
    expect(offlineInstances[0].sources.slice(1).map((source) => source.startTime)).toEqual(result.events.map((event) => event.time));
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
  });

  it('does not let a disabled ambient built-in suppress a different inferred walking effect', async () => {
    const result = await mixSoundscape(voice(), [cue('He walked into the forest.')], withRules(settings([], ['forest'])));
    expect(result.events.map((event) => event.label)).toEqual(['발소리']);
  });

  it('uses trim, NFC and case-insensitive substring matching with original cue timing', async () => {
    const composed = '앞부분 고요한 안개가 자욱했다';
    const config = settings([rule('  고요한 안개  '.normalize('NFD'), 'rain')], ['rain']);
    const first = await mixSoundscape(voice(), [cue(composed, 3, 25)], withRules(config));
    const second = await mixSoundscape(voice(), [cue(composed.normalize('NFD'), 3, 25)], withRules(config));
    expect(second.events).toEqual(first.events);
    expect(first.events.map((event) => event.label)).toEqual(['빗소리']);
    expect(first.events[0].time).toBeCloseTo(3 + 25 * composed.indexOf('고요한') / composed.length);
    const english = await mixSoundscape(voice(), [cue('A RAINBOW appeared.')], withRules(settings([rule('rain', 'rain')], ['rain'])));
    expect(english.events.map((event) => event.label)).toEqual(['빗소리']); // literal substring, not a word boundary
  });

  it('maps Unicode case expansion and supplementary characters back to the real cue position', async () => {
    const text = '😀 ß TRIGGER near the end';
    const result = await mixSoundscape(voice(), [cue(text, 2, 30)], withRules(settings([rule('trigger', 'door')], ['door'])));
    expect(result.events[0].time).toBeCloseTo(2 + 30 * text.indexOf('TRIGGER') / text.length);
    expect(offlineInstances[0].sources[1].startTime).toBe(result.events[0].time);
    const expanded = await mixSoundscape(voice(), [cue('A ß B', 0, 20)], withRules(settings([rule('SS', 'rain')], ['rain'])));
    expect(expanded.events[0].time).toBeCloseTo(20 * 2 / 'A ß B'.length);
    const partial = await mixSoundscape(voice(), [cue('ß')], withRules(settings([rule('s', 'rain')], ['rain'])));
    expect(partial.events).toEqual([]);
  });

  it('uses the same timing path for a custom match and the equivalent built-in', async () => {
    const text = 'The narrator paused, then opened the door.';
    const builtin = await mixSoundscape(voice(), [cue(text, 4, 25)], options);
    const custom = await mixSoundscape(voice(), [cue(text, 4, 25)], withRules(settings([rule('opened the door', 'door')], ['door'])));
    expect(custom.events).toEqual(builtin.events);
    expect(offlineInstances[0].sources[1].startTime).toBe(offlineInstances[1].sources[1].startTime);
  });

  it.each(['.*', '(a+)+$', '[abc]', 'x|y', '\\d+'])('treats regexp syntax literally: %s', async (phrase) => {
    const config = withRules(settings([rule(phrase, 'page')], ['page']));
    const absent = await mixSoundscape(voice(), [cue('abcdef x y 123 aaaaaaaaaa')], config);
    expect(absent.events).toEqual([]);
    const present = await mixSoundscape(voice(), [cue(`literal ${phrase} here`)], config);
    expect(present.events.map((event) => event.label)).toEqual(['책장 넘기는 소리']);
  });

  it('ignores duplicate and overlapping same-effect rules and built-ins without a spurious density warning', async () => {
    const config = withRules(settings([
      rule(' RAIN ', 'rain', '1'), rule('rain', 'rain', '2'), rule('ain', 'rain', '3'),
      rule('thunderstorm', 'ocean', '4'), rule('thunder', 'ocean', '5'), rule('storm', 'ocean', '6'),
    ]));
    const result = await mixSoundscape(voice(), [cue('rain, and much later thunderstorm', 0, 38)], config);
    expect(result.events.map((event) => event.label)).toEqual(['빗소리', '바다']);
    expect(result.warnings).toEqual([]);
    expect(offlineInstances[0].sources).toHaveLength(3);
  });

  it('does not merge different effects or separate occurrences, which still obey density and cooldown', async () => {
    const config = withRules(settings([rule('chime', 'door', 'chime-door'), rule('chime', 'page', 'chime-page'), rule('drizzle', 'rain')], ['rain']));
    const result = await mixSoundscape(voice(), [cue('chime', 0, 2), cue('drizzle', 5, 2), cue('drizzle', 15, 2), cue('drizzle', 36, 2)], config);
    expect(result.events.map((event) => event.label)).toEqual(['문 여닫는 소리', '빗소리', '빗소리']);
    expect(result.warnings.join(' ')).toContain('효과음 단서 2개'); // other effect at same location + rain cooldown
  });

  it('reuses local negation heuristics without treating another clause as negated', async () => {
    const config = withRules(settings([rule('drizzle', 'rain'), rule('안개', 'forest')], ['rain', 'forest']));
    for (const text of ['No drizzle.', '안개가 없었다.']) {
      expect((await mixSoundscape(voice(), [cue(text)], config)).events).toEqual([]);
    }
    const result = await mixSoundscape(voice(), [cue('No drizzle, but later drizzle returned.', 0, 38)], config);
    expect(result.events.map((event) => event.label)).toEqual(['빗소리']);
    expect(result.events[0].time).toBeGreaterThan(15);
  });

  it('ignores malformed, empty and disabled rules but retains valid settings beside them', async () => {
    const invalid = [
      null, 1, 'bad', [], {}, { id: '', phrase: 'bad', effect: 'rain', enabled: true },
      { id: 12, phrase: 'bad', effect: 'rain', enabled: true },
      { id: ' padded ', phrase: 'bad', effect: 'rain', enabled: true },
      { id: 'bad\u0000id', phrase: 'bad', effect: 'rain', enabled: true },
      { id: 'a'.repeat(129), phrase: 'bad', effect: 'rain', enabled: true },
      { id: 'x', phrase: '   ', effect: 'rain', enabled: true },
      { id: 'x', phrase: null, effect: 'rain', enabled: true },
      { id: 'x', phrase: 'bad', effect: 'music', enabled: true },
      { id: 'x', phrase: 'bad', effect: 'rain', enabled: 'true' },
      rule('bad', 'rain', 'disabled', false),
    ];
    const config = { customRules: [...invalid, rule('valid', 'door')], disabledBuiltins: ['rain', null, 'music', 1] } as unknown as SoundRuleSettings;
    const result = await mixSoundscape(voice(), [cue('rain bad valid')], withRules(config));
    expect(result.events.map((event) => event.label)).toEqual(['문 여닫는 소리']);
    const partial = await mixSoundscape(voice(), [cue('rain')], withRules({ customRules: null, disabledBuiltins: ['rain'] } as unknown as SoundRuleSettings));
    expect(partial.events).toEqual([]);
    const otherPartial = await mixSoundscape(voice(), [cue('valid')], withRules({ customRules: [rule('valid', 'door')], disabledBuiltins: 'door' } as unknown as SoundRuleSettings));
    expect(otherPartial.events.map((event) => event.label)).toEqual(['문 여닫는 소리']);
  });

  it('reserves a valid disabled rule ID and ignores subsequent rules using the same ID', async () => {
    const config = withRules(settings([rule('unused', 'rain', 'same-id', false), rule('trigger', 'door', 'same-id')]));
    expect((await mixSoundscape(voice(), [cue('trigger')], config)).events).toEqual([]);
  });

  it('examines at most the first 50 supplied entries, including invalid and disabled entries', async () => {
    const entries = Array.from({ length: 49 }, (_, i) => rule(`unused-${i}`, 'rain', `id-${i}`, false));
    entries.push(rule('number fifty', 'door', '50'));
    entries.push(rule('number fifty one', 'page', '51'));
    const config = withRules(settings(entries));
    expect((await mixSoundscape(voice(), [cue('number fifty')], config)).events.map((event) => event.label)).toEqual(['문 여닫는 소리']);
    expect((await mixSoundscape(voice(), [cue('number fifty one')], withRules(settings(entries.map((entry, index) => index === 49 ? rule('unused 50', 'door') : entry))))).events).toEqual([]);
  });

  it('accepts 80 normalized Unicode code points but ignores 81, including non-BMP characters', async () => {
    for (const char of ['가', '😀']) {
      const eighty = char.repeat(80);
      const eightyOne = char.repeat(81);
      const accepted = await mixSoundscape(voice(), [cue(eighty)], withRules(settings([rule(` ${eighty.normalize('NFD')} `, 'rain')], ['rain'])));
      expect(accepted.events.map((event) => event.label)).toEqual(['빗소리']);
      const rejected = await mixSoundscape(voice(), [cue(eightyOne)], withRules(settings([rule(eightyOne, 'rain')], ['rain'])));
      expect(rejected.events).toEqual([]);
    }
  });

  it('keeps asset requests fixed and private for custom matches, disabled rules, and no matches', async () => {
    for (const [text, config] of [
      ['secret phrase', settings([rule('secret phrase', 'page')])],
      ['rain secret phrase', settings([rule('secret phrase', 'page', 'x', false)], ['rain'])],
      ['unrelated', settings([rule('secret phrase', 'page')])],
    ] as [string, SoundRuleSettings][]) {
      vi.mocked(fetch).mockClear();
      await mixSoundscape(voice(), [cue(text)], withRules(config));
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
      for (const [, init] of vi.mocked(fetch).mock.calls) expect(init).toEqual({ credentials: 'same-origin', signal: undefined });
    }
  });

  it('decodes the selected custom effect asset and applies the normal duration and error handling', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true, arrayBuffer: async () => new Uint8Array([effectUrls.indexOf(url) + 1]).buffer,
    })));
    const config = withRules(settings([rule('secret chime', 'door')], ['door']));
    const mixed = await mixSoundscape(voice(), [cue('secret chime')], config);
    expect(mixed.events.map((event) => event.label)).toEqual(['문 여닫는 소리']);
    expect(decodedAssetIds).toEqual([5]); // door, not an unrelated asset
    expect(offlineInstances[0].sources[1].stopTime - offlineInstances[0].sources[1].startTime).toBeCloseTo(3);
    assetDecodeFailure = 5;
    vi.mocked(fetch).mockClear();
    await expect(mixSoundscape(voice(), [cue('secret chime')], config)).rejects.toThrow('/soundscape/tinyaudio-v1/door.mp3');
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
  });

  it('preserves effect-off, zero volume, final-tail and cancellation behavior for custom matches', async () => {
    const config = settings([rule('chime', 'door')]);
    for (const overrides of [{ effects: false }, { effectsVolume: 0 }]) {
      vi.mocked(fetch).mockClear();
      const result = await mixSoundscape(voice(), [cue('chime')], { ...withRules(config), ...overrides });
      expect(result.events).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    }
    voiceDuration = 0.5;
    const tooShort = await mixSoundscape(voice(), [cue('chime', 0, 0.5)], withRules(config));
    expect(tooShort.events).toEqual([]);
    expect(tooShort.warnings.join(' ')).toContain('재생 시간이 부족한 효과음');
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const controller = new AbortController();
    const mixing = mixSoundscape(voice(), [cue('chime', 0, 0.5)], withRules(config), undefined, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    await expect(mixing).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('custom rules at actual TTS chunk boundaries', () => {
  // Execute the production splitter and renderer with model doubles, then pass
  // the resulting cues unchanged into the production soundscape mixer.
  async function generatedCues(text: string, lang: 'ko' | 'en' = 'ko'): Promise<Cue[]> {
    const self = { location: { href: 'https://example.test/' }, postMessage: () => {} };
    class Tensor { constructor(public type: string, public data: unknown, public dims: number[]) {} }
    class Encoder { encodeBuffer() { return new Uint8Array([1]); } flush() { return new Uint8Array([2]); } }
    const ort = { env: { wasm: {} }, Tensor };
    const file = new URL('./tts-engine.worker.ts', import.meta.url);
    const source = readFileSync(file, 'utf8').replace(/^import .*;\n/gm, '') + '\nglobalThis.__render = render;';
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const context = vm.createContext({ self, ort, Mp3Encoder: Encoder, wasmUrl: 'model.wasm', URL, Blob, Uint8Array, Float32Array, Int16Array, BigInt64Array, Math, Array, Intl, Number, Error, AbortSignal, Response, setTimeout, navigator: {} });
    vm.runInContext(js, context, { filename: file.pathname });
    const engine = {
      backend: 'wasm', config: { ae: { sample_rate: 1000, base_chunk_size: 120 }, ttl: { chunk_compress_factor: 2, latent_dim: 2 } }, indexer: [],
      sessions: {
        duration: { run: async () => ({ duration: { data: [10] } }) },
        encoder: { run: async () => ({ text_emb: {} }) },
        vector: { run: async (args: any) => ({ denoised_latent: args.noisy_latent }) },
        vocoder: { run: async () => ({ wav_tts: { data: new Float32Array(10000) } }) },
      },
    };
    return (await context.__render(engine, { text, lang, voice: 'F1', speed: 1 }, { dp: {}, ttl: {} })).cues;
  }
  const config = (phrase: string, effect: EffectName = 'rain'): MixOptions => ({
    ...options, soundRules: { disabledBuiltins: [effect], customRules: [{ id: 'rule', phrase, effect, enabled: true }] },
  });

  it('finds a literal phrase cut by the Korean hard chunk limit and uses the first cue clock', async () => {
    const cues = await generatedCues('가'.repeat(119) + '나다' + '가'.repeat(100));
    expect(cues).toHaveLength(2);
    expect(cues[0].text.endsWith('나')).toBe(true);
    expect(cues[1].text.startsWith('다')).toBe(true);
    const result = await mixSoundscape(voice(), cues, config('나다'));
    expect(result.events).toHaveLength(1);
    expect(result.events[0].label).toBe('빗소리');
    expect(result.events[0].time).toBeCloseTo(cues[0].start + cues[0].duration * 119 / 120);
  });

  it.each([' ', '\n\n', '\t'])('does not invent a no-space match across an original %j boundary', async (gap) => {
    const cues = await generatedCues('가'.repeat(119) + '나' + gap + '다' + '가'.repeat(100));
    expect(cues.length).toBeGreaterThanOrEqual(2);
    const result = await mixSoundscape(voice(), cues, config('나다'));
    expect(result.events).toEqual([]);
  });

  it('matches a space only when the actual original space is present across the split', async () => {
    const cues = await generatedCues('가'.repeat(119) + '나 다' + '가'.repeat(100));
    const result = await mixSoundscape(voice(), cues, config('나 다'));
    expect(result.events.map(event => event.label)).toEqual(['빗소리']);
  });

  it('retains the exact number of original spaces at a chunk boundary', async () => {
    const cues = await generatedCues('가'.repeat(119) + '나  다' + '가'.repeat(100));
    expect(cues[1].sourceBefore).toBe('  ');
    expect((await mixSoundscape(voice(), cues, config('나 다'))).events).toEqual([]);
    expect((await mixSoundscape(voice(), cues, config('나  다'))).events).toHaveLength(1);
  });

  it('uses the full local clause for a split custom phrase and suppresses explicit negation', async () => {
    const cues = await generatedCues('가'.repeat(119) + '안개가 없었다.' + '가'.repeat(100));
    const result = await mixSoundscape(voice(), cues, config('안개', 'forest'));
    expect(result.events).toEqual([]);
  });

  it('preserves the exact paragraph delimiters, including across three cues', async () => {
    const cues = await generatedCues('나\n\n다\n\n라');
    expect(cues).toHaveLength(3);
    expect(cues.slice(1).map(c => c.sourceBefore)).toEqual(['\n\n', '\n\n']);
    const result = await mixSoundscape(voice(), cues, config('나\n\n다\n\n라', 'door'));
    expect(result.events.map(event => event.label)).toEqual(['문 여닫는 소리']);
    // Discrete sounds use the last cue; they do not use a fabricated merged clock.
    expect(result.events[0].time).toBeCloseTo(cues[2].start);
    expect((await mixSoundscape(voice(), cues, config('나다라'))).events).toEqual([]);
  });

  it('handles decomposed Hangul and case expansion at actual hard boundaries', async () => {
    const korean = await generatedCues('가'.repeat(118) + '나' + '다'.normalize('NFD') + '가'.repeat(100));
    expect(korean[0].text.endsWith('나')).toBe(true);
    expect((await mixSoundscape(voice(), korean, config('나다'))).events).toHaveLength(1);
    const english = await generatedCues('x'.repeat(239) + 'ßA' + 'x'.repeat(100), 'en');
    expect(english[0].text.endsWith('ß')).toBe(true);
    expect((await mixSoundscape(voice(), english, config('ssA'))).events).toHaveLength(1);
    expect((await mixSoundscape(voice(), english, config('sA'))).events).toEqual([]);
  });

  it('keeps negation across a paragraph split rather than joining a denied event', async () => {
    for (const [text, expected] of [['No dri\n\nzzle', 0], ['Some dri\n\nzzle', 1]] as const) {
      const cues = await generatedCues(text, 'en');
      expect(cues).toHaveLength(2);
      const result = await mixSoundscape(voice(), cues, config('dri\n\nzzle'));
      expect(result.events).toHaveLength(expected);
    }
  });

  it('deduplicates overlapping custom rules and gives same-effect built-ins precedence across cues', async () => {
    const cues = await generatedCues('나\n\n다');
    const overlapping: MixOptions = { ...options, soundRules: { disabledBuiltins: ['rain'], customRules: [
      { id: 'short', phrase: '나', effect: 'rain', enabled: true },
      { id: 'long', phrase: '나\n\n다', effect: 'rain', enabled: true },
    ] } };
    const result = await mixSoundscape(voice(), cues, overlapping);
    expect(result.events).toHaveLength(1);
    expect(result.warnings.join(' ')).not.toContain('간격·반복');
    const builtinCues = await generatedCues('foo\n\nrain', 'en');
    const builtIn = await mixSoundscape(voice(), builtinCues, {
      ...options, soundRules: { disabledBuiltins: [], customRules: [{ id: 'cross', phrase: 'foo\n\nrain', effect: 'rain', enabled: true }] },
    });
    expect(builtIn.events).toHaveLength(1);
    expect(builtIn.events[0].time).toBeCloseTo(builtinCues[1].start);
    expect(builtIn.warnings.join(' ')).not.toContain('간격·반복');
  });

  it('does not join legacy, malformed or time-overlapping cues and explains the limitation', async () => {
    const cases: Cue[][] = [
      [cue('나', 0, 5), cue('다', 6, 5)],
      [cue('나', 0, 5), { ...cue('다', 6, 5), sourceBefore: 'not whitespace' }],
      [cue('나', 0, 5), { ...cue('다', 4, 5), sourceBefore: '' }],
    ];
    for (const cues of cases) {
      const result = await mixSoundscape(voice(), cues, config('나다'));
      expect(result.events).toEqual([]);
      expect(result.warnings.join(' ')).toContain('사용자 규칙');
      expect(result.warnings.join(' ')).toContain('누락될 수');
    }
    const legacyMatch = await mixSoundscape(voice(), [cue('나다', 0, 4), cue('other', 6, 4)], config('나다'));
    expect(legacyMatch.events).toHaveLength(1); // Legacy in-cue matches still work.
    expect(legacyMatch.warnings.join(' ')).toContain('누락될 수');
  });

  it('leaves default built-in results unchanged when optional source metadata is present', async () => {
    const cues = await generatedCues('rain\n\nopened the door', 'en');
    const withoutMetadata = cues.map(({ text, start, duration }) => ({ text, start, duration }));
    const original = await mixSoundscape(voice(), withoutMetadata, options);
    const withMetadata = await mixSoundscape(voice(), cues, options);
    expect(withMetadata.events).toEqual(original.events);
    expect(withMetadata.warnings).toEqual(original.warnings);
  });

  it('uses normal final-tail omission for a discrete phrase ending in the last cue', async () => {
    const cues = await generatedCues('나\n\n다\n\n라');
    voiceDuration = cues[2].start + 0.5;
    const result = await mixSoundscape(voice(), cues, config('나\n\n다\n\n라', 'door'));
    expect(result.events).toEqual([]);
    expect(result.warnings.join(' ')).toContain('재생 시간이 부족한 효과음');
  });

  it('warns instead of joining a chunk whose sentence spacing was changed by the splitter', async () => {
    const cues = await generatedCues('Alpha!  Bravo! ' + 'x'.repeat(500), 'en');
    expect(cues[0].text).toBe('Alpha! Bravo!');
    expect(cues[1].sourceBefore).toBeUndefined();
    const result = await mixSoundscape(voice(), cues, config('Bravo! x'));
    expect(result.events).toEqual([]);
    expect(result.warnings.join(' ')).toContain('누락될 수');
  });

  it('keeps fixed private asset requests and cancellation with cross-cue rules', async () => {
    const cues = await generatedCues('가'.repeat(119) + '나다' + '가'.repeat(100));
    await mixSoundscape(voice(), cues, config('나다'));
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(effectUrls);
    for (const [, init] of vi.mocked(fetch).mock.calls) expect(init).toEqual({ credentials: 'same-origin', signal: undefined });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const controller = new AbortController();
    const mixing = mixSoundscape(voice(), cues, config('나다'), undefined, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    await expect(mixing).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('retains earlier cue priority when old custom and built-in candidates share a timestamp', async () => {
    const result = await mixSoundscape(voice(), [cue('chime', 0, 2), cue('rain', 0, 2)], {
      ...options, soundRules: { disabledBuiltins: [], customRules: [{ id: 'chime', phrase: 'chime', effect: 'door', enabled: true }] },
    });
    expect(result.events.map(event => event.label)).toEqual(['문 여닫는 소리']);
  });
});
