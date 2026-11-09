import { describe, expect, it, vi } from 'vitest';
import { connectBinaural, EFFECT_SPATIAL_PROFILES, makeMonoSafeAmbience, makeNarrationDucking } from './sound-quality';

class Param {
  value = 0;
  events: { value: number; time: number; constant: number }[] = [];
  setTargetAtTime(value: number, time: number, constant: number) {
    this.events.push({ value, time, constant });
    return this;
  }
}
class Node {
  connections: { to: Node; output: number; input: number }[] = [];
  constructor(public kind: string, private context: Context) {}
  connect(to: Node, output = 0, input = 0) {
    this.connections.push({ to, output, input });
    // Simulate the worst case: a browser throws *after* installing an edge.
    if (this.context.failEdge === `${this.kind}->${to.kind}`) {
      this.context.failEdge = '';
      throw new Error('connect failed after side effect');
    }
    return to;
  }
  disconnect() { this.connections = []; }
}
class Gain extends Node {
  gain = new Param();
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  constructor(context: Context) { super('gain', context); this.gain.value = 1; }
}
class Hrtf extends Node {
  model = 'equalpower';
  positionX = new Param();
  positionY = new Param();
  positionZ = new Param();
  distanceModel = 'inverse';
  rolloffFactor = 1;
  constructor(private ctx: Context) { super('hrtf', ctx); }
  get panningModel() { return this.model; }
  set panningModel(value: string) {
    if (this.ctx.failHrtf === 'configure') throw new Error('HRTF configuration failed');
    this.model = value;
  }
}
class Stereo extends Node {
  pan = new Param();
  constructor(ctx: Context) { super('stereo', ctx); }
}
class Buffer {
  length: number;
  numberOfChannels: number;
  duration: number;
  constructor(public channels: Float32Array[], public sampleRate = 1000) {
    this.numberOfChannels = channels.length;
    this.length = channels[0]?.length ?? 0;
    this.duration = this.length / sampleRate;
  }
  getChannelData(i: number) { return this.channels[i]; }
}
class Context {
  destination = new Node('destination', this);
  nodes: Node[] = [];
  failHrtf: 'create' | 'configure' | '' = '';
  failStereo = false;
  failEdge = '';
  add<T extends Node>(node: T): T { this.nodes.push(node); return node; }
  createGain() { return this.add(new Gain(this)); }
  createPanner() { if (this.failHrtf === 'create') throw new Error('no HRTF'); return this.add(new Hrtf(this)); }
  createStereoPanner() { if (this.failStereo) throw new Error('no stereo panner'); return this.add(new Stereo(this)); }
  createChannelSplitter() { return this.add(new Node('split', this)); }
  createChannelMerger() { return this.add(new Node('merge', this)); }
  createBuffer(count: number, length: number, rate: number) {
    return new Buffer(Array.from({ length: count }, () => new Float32Array(length)), rate);
  }
  get offline() { return this as unknown as OfflineAudioContext; }
  get base() { return this as unknown as BaseAudioContext; }
  get output() { return this.destination as unknown as AudioNode; }
}
const audio = (data: Float32Array, rate = 1000) => new Buffer([data], rate) as unknown as AudioBuffer;
const stereoBuffer = (left: Float32Array, right: Float32Array, rate = 1000) =>
  new Buffer([left, right], rate) as unknown as AudioBuffer;
const asGain = (node: Gain) => node as unknown as GainNode;
const place = (ctx: Context, gain: Gain, profile: { pan: number; wide: boolean; depth: number }, warn = vi.fn()) => {
  connectBinaural(ctx.offline, asGain(gain), profile, ctx.output, warn);
  return warn;
};

function matrix(ctx: Context, source: Gain) {
  const distance = source.connections[0].to as Gain;
  const split = distance.connections[0].to;
  expect(split.kind).toBe('split');
  const coeff = [[0, 0], [0, 0]]; // [output][input]
  for (const edge of split.connections) {
    const gain = edge.to as Gain;
    const merger = gain.connections[0];
    expect(merger.to.kind).toBe('merge');
    expect(merger.to.connections[0].to).toBe(ctx.destination);
    coeff[merger.input][edge.output] = gain.gain.value * distance.gain.value;
  }
  return coeff;
}

describe('narration ducking bus', () => {
  it('follows voice energy with smooth bounded attack and release while the voice stays dry', () => {
    const ctx = new Context();
    const samples = new Float32Array(6000);
    samples.fill(0.1, 600, 1600);
    samples.fill(0.04, 1720, 2300); // a 120ms gap is bridged
    samples.fill(0.1, 4000, 4400);
    const voiceGain = ctx.createGain();
    voiceGain.connect(ctx.destination);
    const bus = makeNarrationDucking(ctx.offline, audio(samples)) as unknown as Gain;
    expect(bus.connections.map((e) => e.to)).toEqual([ctx.destination]);
    expect(voiceGain.connections.map((e) => e.to)).toEqual([ctx.destination]);
    expect(voiceGain.gain.value).toBe(1);
    expect(voiceGain.gain.events).toEqual([]);
    expect(bus.gain.value).toBe(1);
    const events = bus.gain.events;
    expect(events[0].time).toBeGreaterThanOrEqual(0.54);
    expect(events[0].time).toBeLessThanOrEqual(0.6);
    expect(events[0].value).toBeCloseTo(0.68);
    expect(events[0].constant).toBe(0.07);
    expect(events.some((event) => event.value > 0.68 && event.value < 0.75)).toBe(true);
    expect(events.some((event) => event.value === 1 && event.time > 2.3)).toBe(true);
    expect(events.some((event) => event.value === 1 && event.time >= 1.6 && event.time < 1.85)).toBe(false);
    expect(events.every((event) => event.value >= 0.68 && event.value <= 1)).toBe(true);
    expect(events.filter((event) => event.value === 1).every((event) => event.constant === 0.3)).toBe(true);
  });

  it('detects quiet narration but ignores empty, silent and non-finite samples', () => {
    const ctx = new Context();
    const quiet = new Float32Array(1200);
    quiet.fill(0.0005, 200, 800);
    quiet[0] = NaN;
    quiet[1] = Infinity;
    const bus = makeNarrationDucking(ctx.offline, audio(quiet)) as unknown as Gain;
    expect(bus.gain.events.some((event) => event.value < 1)).toBe(true);
    for (const data of [new Float32Array(0), new Float32Array(800), new Float32Array(800).fill(NaN)]) {
      const silent = makeNarrationDucking(ctx.offline, audio(data)) as unknown as Gain;
      expect(silent.gain.value).toBe(1);
      expect(silent.gain.events).toEqual([]);
    }
  });

  it('uses per-channel energy rather than cancelling opposite-phase voice channels', () => {
    const ctx = new Context();
    const left = new Float32Array(1000).fill(0.03);
    const right = new Float32Array(1000).fill(-0.03);
    const bus = makeNarrationDucking(ctx.offline, stereoBuffer(left, right)) as unknown as Gain;
    expect(bus.gain.events[0].value).toBeCloseTo(0.68);
  });

  it('bounds automation over ten minutes', () => {
    const ctx = new Context();
    const data = new Float32Array(600_000);
    for (let i = 0; i < data.length; i += 600) data.fill(0.08, i, i + 300);
    const bus = makeNarrationDucking(ctx.offline, audio(data)) as unknown as Gain;
    expect(bus.gain.events.length).toBeGreaterThan(100);
    expect(bus.gain.events.length).toBeLessThanOrEqual(5001);
    for (let i = 1; i < bus.gain.events.length; i++) {
      expect(bus.gain.events[i].time - bus.gain.events[i - 1].time).toBeGreaterThanOrEqual(0.119999);
    }
  });
});

describe('spatial defaults and matrix', () => {
  it('uses the original directions and graded nearby-to-distant depths', () => {
    const p = EFFECT_SPATIAL_PROFILES;
    expect([p.rain.pan, p.forest.pan, p.ocean.pan, p.footsteps.pan, p.door.pan, p.page.pan]).toEqual([-0.12, 0.12, 0, -0.25, 0.25, 0]);
    expect(p.page.depth).toBeLessThan(p.door.depth);
    expect(p.door.depth).toBeLessThan(p.footsteps.depth);
    expect([p.rain.wide, p.forest.wide, p.ocean.wide, p.footsteps.wide, p.door.wide, p.page.wide]).toEqual([true, true, true, false, false, false]);
  });

  it.each([-0.12, 0, 0.12])('uses a safe matrix and exact mono downmix at pan %s', (pan) => {
    const ctx = new Context();
    const source = ctx.createGain();
    const warn = place(ctx, source, { pan, wide: true, depth: 0.5 });
    const coeff = matrix(ctx, source);
    expect(warn).not.toHaveBeenCalled();
    expect(source.channelCount).toBe(2);
    expect(source.channelCountMode).toBe('explicit');
    expect(source.channelInterpretation).toBe('speakers');
    const attenuation = 0.85 * (1 - 0.22 * 0.5);
    expect(coeff[0][0] + coeff[1][0]).toBeCloseTo(attenuation, 12);
    expect(coeff[0][1] + coeff[1][1]).toBeCloseTo(attenuation, 12);
    expect(coeff.flat().every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(coeff.every((row) => row[0] + row[1] <= 1)).toBe(true);
    for (const [l, r] of [[1, 0], [0, 1], [0.7, -0.2], [1, -1], [1, 1]]) {
      const outL = coeff[0][0] * l + coeff[0][1] * r;
      const outR = coeff[1][0] * l + coeff[1][1] * r;
      expect((outL + outR) / 2).toBeCloseTo(attenuation * (l + r) / 2, 12);
    }
    if (pan === 0) expect((coeff[0][0] - coeff[1][0]) / attenuation).toBeCloseTo(0.45, 12);
    if (pan < 0) expect(coeff[0][0] + coeff[0][1]).toBeGreaterThan(coeff[1][0] + coeff[1][1]);
    if (pan > 0) expect(coeff[1][0] + coeff[1][1]).toBeGreaterThan(coeff[0][0] + coeff[0][1]);
  });

  it('uses audio analysis to replace an anti-phase stereo asset without summing or boosting it', () => {
    const ctx = new Context();
    const left = new Float32Array(2000).fill(0.2);
    const right = new Float32Array(2000).fill(-0.3);
    const original = stereoBuffer(left, right);
    const result = makeMonoSafeAmbience(ctx.base, original);
    expect(result).not.toBe(original);
    expect(result.numberOfChannels).toBe(1);
    expect(result.getChannelData(0)[0]).toBeCloseTo(-0.3);
    expect(original.getChannelData(0)[0]).toBeCloseTo(0.2);
    const ordinary = stereoBuffer(left, new Float32Array(2000).fill(0.1));
    expect(makeMonoSafeAmbience(ctx.base, ordinary)).toBe(ordinary);
    expect(makeMonoSafeAmbience(ctx.base, audio(left))).toEqual(audio(left));
    const veryShort = stereoBuffer(new Float32Array(50).fill(0.2), new Float32Array(50).fill(-0.2));
    expect(makeMonoSafeAmbience(ctx.base, veryShort).numberOfChannels).toBe(1);
  });

  it('retains later left-only and right-only audio after an anti-phase section', () => {
    const ctx = new Context();
    const left = new Float32Array(3000);
    const right = new Float32Array(3000);
    left.fill(0.5, 0, 2000);
    right.fill(-0.5, 0, 1000);
    right.fill(0.5, 2000, 3000);
    const result = makeMonoSafeAmbience(ctx.base, stereoBuffer(left, right));
    const mono = result.getChannelData(0);
    expect(result.numberOfChannels).toBe(1);
    expect(mono[500]).toBeCloseTo(0.5);
    expect(mono[1500]).toBeCloseTo(0.25);
    expect(mono[2500]).toBeCloseTo(0.25);
  });
});

describe('discrete HRTF and fallbacks', () => {
  it('places mono sources forward, and attenuates more with distance', () => {
    const levels: number[] = [];
    for (const name of ['page', 'door', 'footsteps'] as const) {
      const ctx = new Context();
      const source = ctx.createGain();
      const profile = EFFECT_SPATIAL_PROFILES[name];
      const warn = place(ctx, source, profile);
      const distance = source.connections[0].to as Gain;
      const panner = distance.connections[0].to as Hrtf;
      expect(source.channelCount).toBe(1);
      expect(source.channelCountMode).toBe('explicit');
      expect(source.channelInterpretation).toBe('speakers');
      expect(panner.panningModel).toBe('HRTF');
      expect(panner.positionX.value).toBeCloseTo(profile.pan * 3);
      expect(panner.positionY.value).toBe(0);
      expect(panner.positionZ.value).toBe(-1);
      expect(panner.rolloffFactor).toBe(0);
      expect(panner.connections[0].to).toBe(ctx.destination);
      expect(distance.gain.value).toBeLessThanOrEqual(1);
      expect(distance.gain.value).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
      levels.push(distance.gain.value);
    }
    expect(levels[0]).toBeGreaterThan(levels[1]);
    expect(levels[1]).toBeGreaterThan(levels[2]);
  });

  it.each(['create', 'configure'] as const)('uses stereo fallback for HRTF %s failure and warns once per context', (failure) => {
    const ctx = new Context();
    ctx.failHrtf = failure;
    const warn = vi.fn();
    for (const profile of [EFFECT_SPATIAL_PROFILES.door, EFFECT_SPATIAL_PROFILES.footsteps]) {
      const source = ctx.createGain();
      place(ctx, source, profile, warn);
      expect(source.connections).toHaveLength(1);
      const distance = source.connections[0].to as Gain;
      const pan = distance.connections[0].to as Stereo;
      expect(pan.kind).toBe('stereo');
      expect(pan.pan.value).toBe(profile.pan);
      expect(pan.connections[0].to).toBe(ctx.destination);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(false);
  });

  it('removes ghost connections when HRTF and stereo both throw after connecting', () => {
    const ctx = new Context();
    ctx.failEdge = 'hrtf->destination';
    const source = ctx.createGain();
    const warn = place(ctx, source, EFFECT_SPATIAL_PROFILES.footsteps);
    const failed = ctx.nodes.find((node) => node.kind === 'hrtf')!;
    expect(failed.connections).toEqual([]);
    expect(source.connections).toHaveLength(1);
    expect(source.connections[0].to.connections[0].to.kind).toBe('stereo');
    expect(warn).toHaveBeenCalledTimes(1);

    const ctx2 = new Context();
    ctx2.failHrtf = 'create';
    ctx2.failEdge = 'stereo->destination';
    const source2 = ctx2.createGain();
    const warn2 = place(ctx2, source2, EFFECT_SPATIAL_PROFILES.door);
    const failed2 = ctx2.nodes.find((node) => node.kind === 'stereo')!;
    expect(failed2.connections).toEqual([]);
    expect(source2.connections).toHaveLength(1);
    expect(source2.connections[0].to.connections.map((edge) => edge.to)).toEqual([ctx2.destination]);
    expect(warn2.mock.calls).toEqual([[true]]);
  });

  it('centers when both spatial APIs are unsupported, with bounded depth gain', () => {
    const ctx = new Context();
    ctx.failHrtf = 'create';
    ctx.failStereo = true;
    const warn = vi.fn();
    for (let i = 0; i < 2; i++) {
      const source = ctx.createGain();
      place(ctx, source, EFFECT_SPATIAL_PROFILES.door, warn);
      const distance = source.connections[0].to as Gain;
      expect(distance.connections.map((edge) => edge.to)).toEqual([ctx.destination]);
      expect(distance.gain.value).toBeLessThanOrEqual(1);
    }
    expect(warn.mock.calls).toEqual([[true]]);
  });

  it('removes partially connected matrix paths before a centered wide fallback', () => {
    const ctx = new Context();
    ctx.failEdge = 'merge->destination';
    const source = ctx.createGain();
    const warn = place(ctx, source, EFFECT_SPATIAL_PROFILES.rain);
    expect(ctx.nodes.find((node) => node.kind === 'merge')?.connections).toEqual([]);
    expect(source.connections).toHaveLength(1);
    expect(source.connections[0].to.connections.map((edge) => edge.to)).toEqual([ctx.destination]);
    expect((source.connections[0].to as Gain).channelCount).toBe(1);
    expect((source.connections[0].to as Gain).channelCountMode).toBe('explicit');
    expect(warn.mock.calls).toEqual([[true]]);
  });
});
