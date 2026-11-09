/**
 * Approximate cue-relative text timing from the decoded, unmixed narration.
 * This is an energy heuristic, NOT word-level forced alignment or ASR: speech
 * rate, language, pronunciation, breaths and background noise may all shift it.
 */
type Cue = { text: string; start: number; duration: number };
type Interval = { start: number; end: number; cumulative: number };

const FRAME_SECONDS = 0.03;
const MAX_CUE_SECONDS = 600;
const MAX_SAMPLE_READS = 1_200_000;
const MIN_SPEECH_SECONDS = 0.24;
const MAX_SHORT_GAP_SECONDS = 0.12;
const MIN_SPEECH_RUN_SECONDS = 0.09;
const MIN_PAUSE_SECONDS = 0.21;
const PAUSE_MARGIN_SECONDS = 0.06;
const MAX_SNAP_SECONDS = 0.4;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Analyze a single worker-supplied PCM chunk once; locate() reuses the result. */
export function createCueTiming(cue: Cue, voice: AudioBuffer): {
  locate(index: number, matchLength: number, discrete: boolean): number;
  reliable: boolean;
} {
  // Invalid metadata must never manufacture NaN/Infinity or an out-of-bounds time.
  const text = typeof cue?.text === 'string' ? cue.text : '';
  const rawStart = Number.isFinite(cue?.start) ? cue.start : 0;
  const rawDuration = Number.isFinite(cue?.duration) && cue.duration > 0 ? cue.duration : 0;
  const rawEnd = Number.isFinite(rawStart + rawDuration) ? rawStart + rawDuration : rawStart;
  const sampleRate = voice?.sampleRate;
  const length = voice?.length;
  const haveBounds = Number.isFinite(sampleRate) && sampleRate > 0
    && Number.isSafeInteger(length) && length >= 0;
  const bufferEnd = haveBounds ? length / sampleRate : Infinity;
  const start = clamp(rawStart, 0, bufferEnd);
  const end = clamp(Math.max(rawStart, rawEnd), start, bufferEnd);

  const fallback = (index: number) => {
    const safeIndex = Number.isFinite(index) ? clamp(Math.trunc(index), 0, text.length)
      : index === Infinity ? text.length : 0;
    return clamp(start + (end - start) * (text.length ? safeIndex / text.length : 0), start, end);
  };
  const unusable = () => ({ reliable: false, locate: (index: number) => fallback(index) });

  if (!cue || typeof cue.text !== 'string' || !text.length || text.length > 100_000
    || !Number.isFinite(cue.start) || !Number.isFinite(cue.duration) || cue.duration <= 0
    || !Number.isFinite(rawStart + rawDuration) || !haveBounds
    || sampleRate < 1_000 || sampleRate > 384_000 || end - start < MIN_SPEECH_SECONDS
    || end - start > MAX_CUE_SECONDS || !Number.isInteger(voice.numberOfChannels)
    || voice.numberOfChannels < 1 || voice.numberOfChannels > 32
    || typeof voice.getChannelData !== 'function') return unusable();

  // Clamping protects output, but missing PCM (including a malformed AudioBuffer
  // whose claimed duration exceeds its samples) cannot support reliable analysis.
  const tolerance = 2 / sampleRate;
  if (rawStart < -tolerance || rawEnd > bufferEnd + tolerance
    || !Number.isFinite(voice.duration) || Math.abs(voice.duration - bufferEnd) > tolerance) return unusable();
  const firstSample = clamp(Math.ceil(start * sampleRate), 0, length);
  const lastSample = clamp(Math.floor(end * sampleRate), firstSample, length);
  const frameSamples = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));
  const frameCount = Math.ceil((lastSample - firstSample) / frameSamples);
  if (frameCount < 8 || frameCount > Math.ceil(MAX_CUE_SECONDS / FRAME_SECONDS) + 1) return unusable();

  let channels: Float32Array[];
  try {
    channels = Array.from({ length: voice.numberOfChannels }, (_, i) => voice.getChannelData(i));
    if (channels.some((channel) => !(channel instanceof Float32Array) || channel.length < lastSample)) return unusable();
  } catch {
    return unusable();
  }

  // Deterministic bounded-stride sampling; never copy full PCM or cancel stereo
  // channels by summing them before squaring. Vary the phase between frames.
  const stride = Math.max(1, Math.ceil((lastSample - firstSample) * channels.length / MAX_SAMPLE_READS));
  const rms = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const a = firstSample + frame * frameSamples;
    const b = Math.min(lastSample, a + frameSamples);
    let energy = 0;
    let count = 0;
    const offset = Math.min(frame % stride, b - a - 1);
    for (let sampleIndex = a + offset; sampleIndex < b; sampleIndex += stride) {
      for (const channel of channels) {
        const sample = channel[sampleIndex];
        if (!Number.isFinite(sample) || Math.abs(sample) > 32) return unusable();
        energy += sample * sample;
        count++;
      }
    }
    rms[frame] = Math.sqrt(energy / count);
  }
  // Fixed log histogram gives ~2% RMS resolution and O(frames) quantiles,
  // avoiding an O(frames log frames) sort on very long cues.
  const histogram = new Uint32Array(1186); // zero, then 32 bins/octave: 2^-32 through 2^5
  for (const value of rms) {
    const bin = value <= 2 ** -32 ? 0 : clamp(1 + Math.floor((Math.log2(value) + 32) * 32), 1, histogram.length - 1);
    histogram[bin]++;
  }
  const quantile = (fraction: number) => {
    const rank = Math.floor((frameCount - 1) * fraction);
    let seen = 0;
    for (let bin = 0; bin < histogram.length; bin++) {
      seen += histogram[bin];
      if (seen > rank) return bin === 0 ? 0 : 2 ** ((bin - 0.5) / 32 - 32);
    }
    return 0;
  };
  const p10 = quantile(0.1);
  const p90 = quantile(0.9);
  // Flat tones/steady noise and almost-silent audio carry no trustworthy speech
  // progress. Quantiles also reject a lone loud click in an otherwise silent cue.
  if (p90 < 0.0015 || (p90 - p10) / p90 < 0.08) return unusable();
  const activeThreshold = Math.max(0.001, p90 * 0.16);
  const quietThreshold = p90 * 0.08;
  const active = Uint8Array.from(rms, (value) => value >= activeThreshold ? 1 : 0);
  const frameStart = (frame: number) => (firstSample + frame * frameSamples) / sampleRate;
  const frameEnd = (frame: number) => Math.min(lastSample, firstSample + (frame + 1) * frameSamples) / sampleRate;

  // Keep short intra-word gaps (including weak consonants) on the speech clock.
  // Long gaps are removed rather than spreading text uniformly over silence.
  for (let i = 0; i < frameCount;) {
    if (active[i]) { i++; continue; }
    const first = i;
    while (i < frameCount && !active[i]) i++;
    if (first > 0 && i < frameCount && frameEnd(i - 1) - frameStart(first) <= MAX_SHORT_GAP_SECONDS + 1e-8) {
      active.fill(1, first, i);
    }
  }
  // Isolated clicks/breaths are not enough to define a speech segment.
  for (let i = 0; i < frameCount;) {
    if (!active[i]) { i++; continue; }
    const first = i;
    while (i < frameCount && active[i]) i++;
    if (frameEnd(i - 1) - frameStart(first) + 1e-8 < MIN_SPEECH_RUN_SECONDS) active.fill(0, first, i);
  }
  const speech: Interval[] = [];
  let speechSeconds = 0;
  for (let i = 0; i < frameCount;) {
    if (!active[i]) { i++; continue; }
    const first = i;
    while (i < frameCount && active[i]) i++;
    const a = Math.max(start, frameStart(first));
    const b = Math.min(end, frameEnd(i - 1));
    speechSeconds += b - a;
    speech.push({ start: a, end: b, cumulative: speechSeconds });
  }
  if (speechSeconds + 1e-8 < MIN_SPEECH_SECONDS || speechSeconds < (end - start) * 0.05) return unusable();

  // Pause eligibility uses RAW low RMS, not the smoothed speech mask. A breath
  // or consonant above the stricter relative threshold breaks a pause; the
  // minimum run and inner margin avoid snapping to its fragile edges.
  const pauses: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < frameCount;) {
    if (rms[i] > quietThreshold) { i++; continue; }
    const first = i;
    while (i < frameCount && rms[i] <= quietThreshold) i++;
    const a = Math.max(start, frameStart(first));
    const b = Math.min(end, frameEnd(i - 1));
    if (b - a + 1e-8 >= MIN_PAUSE_SECONDS) {
      pauses.push({ start: a + PAUSE_MARGIN_SECONDS, end: b - PAUSE_MARGIN_SECONDS });
    }
  }

  // JS regexp indices are UTF-16 offsets, but Unicode code points are counted
  // only once. Whitespace/punctuation/emoji are not assumed to be spoken;
  // letters and numbers share the speech clock (not language-specific phonemes).
  const progress = new Float64Array(text.length + 1);
  let total = 0;
  for (let offset = 0; offset < text.length;) {
    const cp = text.codePointAt(offset)!;
    const character = String.fromCodePoint(cp);
    const width = character.length;
    if (width === 2) progress[offset + 1] = total;
    if (/[\p{L}\p{N}]/u.test(character)) total++;
    progress[offset + width] = total;
    offset += width;
  }
  if (!total) return unusable();

  return {
    reliable: true,
    locate(index, matchLength, discrete) {
      if (!Number.isInteger(index) || index < 0 || index > text.length
        || !Number.isInteger(matchLength) || matchLength < 0 || index + matchLength > text.length
        || typeof discrete !== 'boolean') return fallback(index);
      let boundary = discrete ? index + matchLength : index;
      // If an exclusive match end falls inside a surrogate pair, advance to the
      // end; a start inside the pair uses its beginning via progress[].
      if (discrete && boundary > 0 && boundary < text.length
        && text.charCodeAt(boundary - 1) >= 0xd800 && text.charCodeAt(boundary - 1) <= 0xdbff
        && text.charCodeAt(boundary) >= 0xdc00 && text.charCodeAt(boundary) <= 0xdfff) boundary++;
      const target = progress[boundary] / total * speechSeconds;
      // Exact segment boundaries select the next voiced start for ambience and
      // the preceding voiced end for a discrete expression ending there.
      let lo = 0;
      let hi = speech.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        // Treat numerically equal boundaries as equal even after summing frames.
        if (discrete ? speech[mid].cumulative + 1e-8 >= target : speech[mid].cumulative > target + 1e-8) hi = mid;
        else lo = mid + 1;
      }
      const segment = speech[lo];
      const before = lo ? speech[lo - 1].cumulative : 0;
      let time = clamp(segment.start + target - before, segment.start, segment.end);
      if (discrete) {
        let bestDistance = Infinity;
        let best = time;
        let pauseLo = 0;
        let pauseHi = pauses.length;
        while (pauseLo < pauseHi) {
          const mid = (pauseLo + pauseHi) >>> 1;
          if (pauses[mid].end < time - MAX_SNAP_SECONDS) pauseLo = mid + 1;
          else pauseHi = mid;
        }
        for (let i = pauseLo; i < pauses.length; i++) {
          const pause = pauses[i];
          if (pause.start > time + MAX_SNAP_SECONDS) break;
          const candidate = clamp(time, pause.start, pause.end);
          const distance = Math.abs(candidate - time);
          if (distance <= MAX_SNAP_SECONDS + 1e-8
            && (distance < bestDistance - 1e-8 || (Math.abs(distance - bestDistance) <= 1e-8 && candidate > best))) {
            bestDistance = distance;
            best = candidate;
          }
        }
        time = best;
      }
      return clamp(time, start, end);
    },
  };
}
