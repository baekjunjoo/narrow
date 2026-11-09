import { describe, expect, it, vi } from 'vitest';
import { createCueTiming } from './sound-timing';

type Segment = [number, number, number];
function makeAudio(duration: number, segments: Segment[], options: { sampleRate?: number; stereo?: boolean } = {}) {
  const sampleRate = options.sampleRate ?? 1000;
  const length = Math.round(duration * sampleRate);
  const left = new Float32Array(length);
  for (const [start, end, amplitude] of segments) {
    for (let i = Math.max(0, Math.round(start * sampleRate)); i < Math.min(length, Math.round(end * sampleRate)); i++) {
      // An audible, non-DC signal with deterministic frame RMS.
      left[i] = amplitude * Math.sin(2 * Math.PI * 73 * i / sampleRate);
    }
  }
  const channels = options.stereo ? [left, left.map((n) => -n)] : [left];
  const getChannelData = vi.fn((channel: number) => channels[channel]);
  const buffer = { sampleRate, length, duration: length / sampleRate, numberOfChannels: channels.length, getChannelData } as unknown as AudioBuffer;
  return { buffer, channels, getChannelData };
}

describe('createCueTiming', () => {
  it('improves over uniform wall-clock timing on known speech progress, not a real alignment claim', () => {
    const text = '빗소리 숲 바다 발소리';
    const cue = { text, start: 0, duration: 6 };
    const timing = createCueTiming(cue, makeAudio(6, [[0.6, 1.8, 0.3], [4.2, 5.4, 0.3]]).buffer);
    expect(timing.reliable).toBe(true);
    // All nine Korean syllables advance at the same rate in this synthetic reference.
    const cases = [
      { word: '빗소리', expected: 0.6 },
      { word: '숲', expected: 1.4 },
      { word: '바다', expected: 1.6666667 },
      { word: '발소리', expected: 4.6 },
    ];
    let oldError = 0;
    let newError = 0;
    for (const { word, expected } of cases) {
      const index = text.indexOf(word);
      const actual = timing.locate(index, word.length, false);
      expect(actual).toBeCloseTo(expected, 1);
      expect(actual < 1.8 || actual >= 4.2).toBe(true);
      oldError += Math.abs(cue.duration * index / text.length - expected);
      newError += Math.abs(actual - expected);
    }
    expect(newError).toBeLessThan(oldError * 0.15);
  });

  it('uses a discrete expression end and snaps to a nearby actual pause; ambience uses its start', () => {
    const text = '문을 열었다. rain';
    const timing = createCueTiming({ text, start: 0, duration: 4.5 },
      makeAudio(4.5, [[0.3, 1.8, 0.3], [3, 4.2, 0.3]]).buffer);
    expect(timing.reliable).toBe(true);
    const expression = '문을 열었다';
    expect(timing.locate(0, expression.length, true)).toBeCloseTo(1.86, 2);
    expect(timing.locate(0, expression.length, false)).toBeCloseTo(0.3, 2);
    expect(timing.locate(text.indexOf('rain'), 4, false)).toBeCloseTo(3, 2);
  });

  it('does not snap to a short gap or an unbroken signal', () => {
    const text = '열기 비가';
    const shortGap = createCueTiming({ text, start: 0, duration: 3 },
      makeAudio(3, [[0.3, 1.2, 0.3], [1.35, 2.25, 0.3]]).buffer);
    expect(shortGap.reliable).toBe(true);
    expect(shortGap.locate(0, 2, true)).toBeCloseTo(1.2, 2);
    // A modulated, continuous signal can be analyzed, but offers no pause.
    const noGap = createCueTiming({ text, start: 0, duration: 3 },
      makeAudio(3, [[0, 1.5, 0.16], [1.5, 3, 0.32]]).buffer);
    expect(noGap.reliable).toBe(true);
    expect(noGap.locate(0, 2, true)).toBeCloseTo(1.5, 2);
  });

  it('breaks pause eligibility at an audible short breath rather than snapping onto it', () => {
    const text = '열기 비가';
    const timing = createCueTiming({ text, start: 0, duration: 4.2 },
      makeAudio(4.2, [[0.3, 1.8, 0.3], [1.8, 1.89, 0.03], [2.4, 3.9, 0.3]]).buffer);
    expect(timing.reliable).toBe(true);
    const found = timing.locate(0, 2, true);
    expect(found).toBeGreaterThanOrEqual(1.94);
    expect(found).toBeLessThanOrEqual(2.2);
    expect(found - 1.8).toBeLessThanOrEqual(0.4);
  });

  it('handles Korean, English, whitespace, punctuation, and JS UTF-16 surrogate offsets', () => {
    const text = '비😀  rain, 숲!';
    const plain = '비rain숲';
    const audio = makeAudio(5, [[0.3, 1.8, 0.3], [3, 4.5, 0.3]]).buffer;
    const timing = createCueTiming({ text, start: 0, duration: 5 }, audio);
    const reference = createCueTiming({ text: plain, start: 0, duration: 5 }, audio);
    expect(timing.reliable).toBe(true);
    expect(timing.locate(text.indexOf('rain'), 4, false)).toBeCloseTo(reference.locate(1, 4, false), 8);
    expect(timing.locate(text.indexOf('숲'), 1, false)).toBeCloseTo(reference.locate(5, 1, false), 8);
    // A caller's offset inside the surrogate pair must not count half an emoji.
    expect(timing.locate(1, 0, false)).toBeCloseTo(timing.locate(2, 0, false), 8);
    expect(timing.locate(1, 1, true)).toBeCloseTo(timing.locate(1, 2, true), 8);
  });

  it('keeps snapping local and never fills a long silent region with background events', () => {
    const text = 'abcd efgh';
    const timing = createCueTiming({ text, start: 0, duration: 8 },
      makeAudio(8, [[0.3, 1.5, 0.3], [6, 7.2, 0.3]]).buffer);
    expect(timing.reliable).toBe(true);
    expect(timing.locate(text.indexOf('efgh'), 4, false)).toBeCloseTo(6, 2);
    expect(timing.locate(0, 4, true)).toBeCloseTo(1.56, 2);
    // End after both segments is closer than 0.4 s to the trailing quiet.
    expect(timing.locate(text.indexOf('efgh'), 4, true)).toBeCloseTo(7.26, 2);
  });

  it('uses RMS across channels even when opposite-phase stereo would cancel', () => {
    const mono = makeAudio(3, [[0.3, 1.2, 0.3], [1.8, 2.7, 0.3]]);
    const stereo = makeAudio(3, [[0.3, 1.2, 0.3], [1.8, 2.7, 0.3]], { stereo: true });
    const cue = { text: 'rain forest', start: 0, duration: 3 };
    const one = createCueTiming(cue, mono.buffer);
    const two = createCueTiming(cue, stereo.buffer);
    expect(two.reliable).toBe(true);
    expect(two.locate(5, 6, false)).toBeCloseTo(one.locate(5, 6, false), 8);
    for (let i = 0; i < 20; i++) two.locate(i % cue.text.length, 0, false);
    expect(stereo.getChannelData).toHaveBeenCalledTimes(2);
  });

  it('analyzes each absolute cue interval separately in the same decoded buffer', () => {
    const audio = makeAudio(10, [[0.3, 1.2, 0.3], [1.8, 2.7, 0.3], [6.3, 7.2, 0.3], [7.8, 8.7, 0.3]]).buffer;
    const a = createCueTiming({ text: '열기 비가', start: 0, duration: 3 }, audio);
    const b = createCueTiming({ text: '열기 비가', start: 6, duration: 3 }, audio);
    expect(a.reliable && b.reliable).toBe(true);
    expect(b.locate(0, 2, true) - a.locate(0, 2, true)).toBeCloseTo(6, 8);
    expect(b.locate(3, 2, false)).toBeCloseTo(7.8, 2);
  });

  it('falls back to the old index ratio for silence, flat signals, and insufficient frames', () => {
    const cue = { text: '문을 열었다 rain', start: 0, duration: 3 };
    for (const audio of [makeAudio(3, []).buffer, makeAudio(3, [[0, 3, 0.3]]).buffer]) {
      const timing = createCueTiming(cue, audio);
      expect(timing.reliable).toBe(false);
      const i = cue.text.indexOf('rain');
      expect(timing.locate(i, 4, true)).toBeCloseTo(3 * i / cue.text.length, 8);
      expect(timing.locate(i, 4, false)).toBeCloseTo(3 * i / cue.text.length, 8);
    }
    expect(createCueTiming({ text: '비', start: 0, duration: 0.1 }, makeAudio(1, [[0, 1, 0.3]]).buffer).reliable).toBe(false);
    expect(createCueTiming({ text: '😀 ...', start: 0, duration: 3 }, makeAudio(3, [[0.3, 2.5, 0.3]]).buffer).reliable).toBe(false);
  });

  it('falls back when declared buffer bounds are not actually backed by samples', () => {
    const base = makeAudio(3, [[0.3, 1.2, 0.3], [1.8, 2.7, 0.3]]);
    const shortData = { ...base.buffer, getChannelData: () => base.channels[0].subarray(0, 1000) } as AudioBuffer;
    const cue = { text: 'rain forest', start: 0, duration: 3 };
    const broken = createCueTiming(cue, shortData);
    expect(broken.reliable).toBe(false);
    expect(broken.locate(5, 6, false)).toBeCloseTo(3 * 5 / cue.text.length, 8);
    const wrongDuration = { ...base.buffer, duration: 4 } as AudioBuffer;
    expect(createCueTiming(cue, wrongDuration).reliable).toBe(false);
    const uncovered = createCueTiming({ text: cue.text, start: 2, duration: 3 }, base.buffer);
    expect(uncovered.reliable).toBe(false);
    expect(uncovered.locate(cue.text.length, 0, false)).toBe(3);
    const throws = { ...base.buffer, getChannelData: () => { throw Error('bad channel'); } } as AudioBuffer;
    expect(createCueTiming(cue, throws).reliable).toBe(false);
  });

  it('clamps malformed cues and locate inputs to finite safe bounds and uses the old ratio', () => {
    const audio = makeAudio(3, [[0.3, 1.2, 0.3], [1.8, 2.7, 0.3]]).buffer;
    for (const cue of [
      { text: 'rain', start: -2, duration: 3 },
      { text: 'rain', start: 10, duration: 3 },
      { text: 'rain', start: NaN, duration: 3 },
      { text: 'rain', start: 1, duration: -3 },
      { text: '', start: 1, duration: 2 },
    ]) {
      const timing = createCueTiming(cue, audio);
      expect(timing.reliable).toBe(false);
      for (const index of [-100, -1, 0, 2, 100, NaN, Infinity, -Infinity]) {
        const result = timing.locate(index, 999, true);
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(3);
      }
    }
    const cue = { text: 'rain forest', start: 0, duration: 3 };
    const timing = createCueTiming(cue, audio);
    expect(timing.reliable).toBe(true);
    expect(timing.locate(5, -1, true)).toBeCloseTo(3 * 5 / cue.text.length, 8);
    expect(timing.locate(5.5, 1, false)).toBeCloseTo(3 * 5 / cue.text.length, 8);
    expect(timing.locate(999, 1, false)).toBe(3);
  });

  it('bounds work for a ten-minute cue and reuses its frame analysis', () => {
    const audio = makeAudio(600, [[30, 250, 0.3], [400, 570, 0.3]], { sampleRate: 8000 });
    const timing = createCueTiming({ text: 'rain forest ocean', start: 0, duration: 600 }, audio.buffer);
    expect(timing.reliable).toBe(true);
    for (let i = 0; i < 100; i++) expect(Number.isFinite(timing.locate(5, 6, false))).toBe(true);
    expect(audio.getChannelData).toHaveBeenCalledTimes(1);
  });
});
