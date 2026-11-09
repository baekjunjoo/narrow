/**
 * Local, non-personalized two-channel sound design. Placements are creative
 * defaults, not directions inferred from a manuscript. No reverb is synthesized.
 */
export type SpatialProfile = { pan: number; wide: boolean; depth: number };
export type SpatialEffectName = 'rain' | 'forest' | 'ocean' | 'footsteps' | 'door' | 'page';

// pan follows the previous left/right defaults; depth 0 is near, 1 is farther.
export const EFFECT_SPATIAL_PROFILES: Record<SpatialEffectName, SpatialProfile> = {
  rain: { pan: -0.12, wide: true, depth: 0.45 },
  forest: { pan: 0.12, wide: true, depth: 0.5 },
  ocean: { pan: 0, wide: true, depth: 0.55 },
  footsteps: { pan: -0.25, wide: false, depth: 0.8 },
  door: { pan: 0.25, wide: false, depth: 0.45 },
  page: { pan: 0, wide: false, depth: 0.1 },
};

const finiteClamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/**
 * Optional preflight for stereo ambience, BEFORE loop creation and safe-gain
 * measurement. A width matrix cannot restore information already cancelled by
 * L+R. If any audible half-second window loses at least 90% of its energy on
 * mono downmix, use the stronger original channel in that window and normal
 * downmix elsewhere. Smooth transitions preserve later single-channel content.
 * This may sacrifice width, but avoids polarity inversion or boosting. Normal
 * stereo and mono buffers are returned unchanged.
 */
export function makeMonoSafeAmbience(context: BaseAudioContext, source: AudioBuffer): AudioBuffer {
  if (source.numberOfChannels !== 2 || !Number.isFinite(source.sampleRate) || source.sampleRate <= 0
      || !Number.isFinite(source.length) || source.length <= 0) return source;
  let left: Float32Array;
  let right: Float32Array;
  try {
    left = source.getChannelData(0);
    right = source.getChannelData(1);
  } catch { return source; }
  const length = Math.min(source.length, left.length, right.length);
  if (!length) return source;
  const windowSize = Math.max(1, Math.round(source.sampleRate * 0.5));
  let unsafe = false;
  const windows: Array<{ start: number; end: number; leftWeight: number }> = [];
  for (let start = 0; start < length; start += windowSize) {
    const end = Math.min(length, start + windowSize);
    let mono = 0;
    let stereo = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let i = start; i < end; i++) {
      const l = Number.isFinite(left[i]) ? left[i] : 0;
      const r = Number.isFinite(right[i]) ? right[i] : 0;
      const l2 = l * l;
      const r2 = r * r;
      leftEnergy += l2;
      rightEnergy += r2;
      stereo += (l2 + r2) / 2;
      mono += ((l + r) / 2) ** 2;
    }
    // Ignore digital silence and very short trailing windows, but still check
    // a whole clip shorter than half a window.
    const windowUnsafe = end - start >= Math.min(windowSize / 2, length)
      && stereo / (end - start) >= 1e-8 && mono < stereo * 0.1;
    if (windowUnsafe) unsafe = true;
    windows.push({ start, end, leftWeight: windowUnsafe ? (leftEnergy >= rightEnergy ? 1 : 0) : 0.5 });
  }
  if (!unsafe) return source;
  const result = context.createBuffer(1, length, source.sampleRate);
  const target = result.getChannelData(0);
  const smoothing = Math.max(1, Math.round(source.sampleRate * 0.01));
  let leftWeight = windows[0].leftWeight;
  for (const window of windows) {
    for (let i = window.start; i < window.end; i++) {
      leftWeight += (window.leftWeight - leftWeight) / smoothing;
      const l = Number.isFinite(left[i]) ? left[i] : 0;
      const r = Number.isFinite(right[i]) ? right[i] : 0;
      target[i] = leftWeight * l + (1 - leftWeight) * r;
    }
  }
  return result;
}

/**
 * Return a sound-only bus, already connected to the output. Connect music and
 * effects here; never connect narration here. RMS analysis stays in this browser
 * and uses one small value per 60 ms frame, rather than a copy of the audio.
 * Silence remains at unity. Quiet but real narration is still detected using a
 * low absolute floor and thresholds relative to this recording's peak frame.
 */
export function makeNarrationDucking(context: OfflineAudioContext, voice: AudioBuffer): GainNode {
  const bus = context.createGain();
  bus.gain.value = 1;
  bus.connect(context.destination);

  const sampleRate = voice?.sampleRate;
  const length = voice?.length;
  const channelCount = voice?.numberOfChannels;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(length) || length <= 0
      || !Number.isInteger(channelCount) || channelCount <= 0) return bus;

  // A decoded AudioBuffer's declared length is normally identical for every
  // channel. Use the actual available length as well, to tolerate bad fakes/data.
  let channels: Float32Array[];
  try {
    channels = Array.from({ length: channelCount }, (_, i) => voice.getChannelData(i));
  } catch {
    return bus;
  }
  if (!channels.length || channels.some((channel) => !channel || !channel.length)) return bus;
  const samples = Math.min(Math.floor(length), ...channels.map((channel) => channel.length));
  if (samples <= 0) return bus;
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.06));
  const frames = new Float32Array(Math.ceil(samples / frameSamples));
  let peak = 0;
  for (let frame = 0; frame < frames.length; frame++) {
    const start = frame * frameSamples;
    const end = Math.min(samples, start + frameSamples);
    let energy = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) {
        const sample = Number.isFinite(channel[i]) ? Math.max(-1, Math.min(1, channel[i])) : 0;
        energy += sample * sample;
      }
    }
    const rms = Math.sqrt(energy / ((end - start) * channels.length));
    frames[frame] = rms;
    peak = Math.max(peak, rms);
  }
  // Below this floor the audio is essentially silence; do not duck on NaNs or
  // digital noise. Hysteresis and a 180 ms hold bridge short spoken gaps.
  if (peak < 0.0001) return bus;
  const onThreshold = Math.max(0.0001, peak * 0.055);
  const offThreshold = Math.max(0.00007, peak * 0.033);
  const holdFrames = 3;
  const minEventInterval = 0.12;
  let active = false;
  let gap = 0;
  let heldTarget = 1;
  let scheduledTarget = 1;
  let lastEventTime = -Infinity;
  for (let frame = 0; frame < frames.length; frame++) {
    const rms = frames[frame];
    if (!active && rms >= onThreshold) {
      active = true;
      gap = 0;
    } else if (active && rms < offThreshold) {
      gap++;
      if (gap > holdFrames) active = false;
    } else if (active) {
      gap = 0;
    }
    if (active && gap === 0) {
      // 0.75 for very soft speech down to 0.68 at the recording's peak.
      heldTarget = Math.max(0.68, 0.75 - 0.07 * Math.min(1, rms / peak));
    }
    const target = active ? heldTarget : 1;
    const time = frame * frameSamples / sampleRate;
    if (Math.abs(target - scheduledTarget) >= 0.025 && time - lastEventTime >= minEventInterval - 1e-9) {
      // No future ramp endpoints, so a new event cannot leave an old endpoint
      // behind. First-order transitions avoid clicks (70 ms attack, 300 ms release).
      bus.gain.setTargetAtTime(target, time, target < scheduledTarget ? 0.07 : 0.3);
      scheduledTarget = target;
      lastEventTime = time;
    }
  }
  return bus;
}

type Warn = (centered?: boolean) => void;
const warningsByContext = new WeakMap<OfflineAudioContext, { hrtf: boolean; centered: boolean }>();
function warnOnce(context: OfflineAudioContext, warn: Warn, centered: boolean): void {
  let flags = warningsByContext.get(context);
  if (!flags) {
    flags = { hrtf: false, centered: false };
    warningsByContext.set(context, flags);
  }
  const key = centered ? 'centered' : 'hrtf';
  if (!flags[key]) {
    flags[key] = true;
    warn(centered);
  }
}

function disconnect(node: AudioNode | undefined): void {
  try { node?.disconnect(); } catch { /* best effort on a broken implementation */ }
}

/**
 * Connect a freshly created sound gain to destination, not the narration gain.
 * Caller applies its usual safe asset gain and source fades before this node.
 * Every explicit multiplier here is <= 1. A failed connection is disconnected
 * before a fallback is installed, including implementations that throw after
 * connecting. The caller must not pre-connect gainNode to another destination.
 */
export function connectBinaural(
  context: OfflineAudioContext,
  gainNode: GainNode,
  profile: SpatialProfile,
  destination: AudioNode,
  warn: Warn,
): void {
  const pan = finiteClamp(profile?.pan, -0.33, 0.33, 0);
  const depth = finiteClamp(profile?.depth, 0, 1, 0);
  const distanceGain = 1 - 0.22 * depth;
  let distance: GainNode;
  try {
    distance = context.createGain();
    distance.gain.value = distanceGain;
  } catch {
    // No secondary gain is available; a centered dry path still never boosts.
    disconnect(gainNode);
    gainNode.connect(destination);
    warnOnce(context, warn, true);
    return;
  }

  if (profile?.wide) {
    const nodes: AudioNode[] = [distance];
    try {
      // Explicit speaker upmix makes even a mono source feed both matrix inputs.
      gainNode.channelCount = 2;
      gainNode.channelCountMode = 'explicit';
      gainNode.channelInterpretation = 'speakers';
      const split = context.createChannelSplitter(2);
      const merge = context.createChannelMerger(2);
      nodes.push(split, merge);
      // 45% side: L'=.725L+.275R, R'=.275L+.725R. The 0.85
      // headroom was present in the original graph. Mild pan is implemented as
      // non-negative crossfeed, not StereoPanner's unequal mono downmix. Each
      // column sums to 0.85, including pan; each row stays below 1.
      const p = finiteClamp(pan, -0.15, 0.15, 0);
      const coefficients = p >= 0
        ? [[0.725 * (1 - p), 0.275 + 0.725 * p], [0.275 * (1 - p), 0.725 + 0.275 * p]]
        : [[0.725 - 0.275 * p, 0.275 * (1 + p)], [0.275 - 0.725 * p, 0.725 * (1 + p)]];
      for (let input = 0; input < 2; input++) {
        for (let output = 0; output < 2; output++) {
          const matrix = context.createGain();
          nodes.push(matrix);
          matrix.gain.value = 0.85 * coefficients[input][output];
          split.connect(matrix, input);
          matrix.connect(merge, 0, output);
        }
      }
      merge.connect(destination);
      distance.connect(split);
      gainNode.connect(distance);
      return;
    } catch {
      disconnect(gainNode);
      nodes.forEach(disconnect);
      // Stereo matrix unavailable: keep attenuation and place it in the center.
      try {
        distance.channelCount = 1;
        distance.channelCountMode = 'explicit';
        distance.channelInterpretation = 'speakers';
        distance.connect(destination);
        gainNode.connect(distance);
      } catch {
        disconnect(gainNode);
        disconnect(distance);
        gainNode.connect(destination);
      }
      warnOnce(context, warn, true);
      return;
    }
  }

  try {
    // A stereo recording is speaker-downmixed before position processing.
    gainNode.channelCount = 1;
    gainNode.channelCountMode = 'explicit';
    gainNode.channelInterpretation = 'speakers';
  } catch {
    disconnect(gainNode);
    try { distance.connect(destination); gainNode.connect(distance); }
    catch { disconnect(gainNode); disconnect(distance); gainNode.connect(destination); }
    warnOnce(context, warn, true);
    return;
  }

  let hrtf: PannerNode | undefined;
  try {
    hrtf = context.createPanner();
    hrtf.panningModel = 'HRTF';
    if (hrtf.panningModel !== 'HRTF') throw new Error('HRTF unavailable');
    hrtf.distanceModel = 'inverse';
    hrtf.rolloffFactor = 0; // distance is controlled explicitly above
    const x = pan * 3;
    if (hrtf.positionX && hrtf.positionY && hrtf.positionZ) {
      hrtf.positionX.value = x;
      hrtf.positionY.value = 0;
      hrtf.positionZ.value = -1; // default listener faces forward (-Z)
    } else {
      hrtf.setPosition(x, 0, -1);
    }
    hrtf.connect(destination);
    distance.connect(hrtf);
    gainNode.connect(distance);
    return;
  } catch {
    disconnect(gainNode);
    disconnect(distance);
    disconnect(hrtf);
  }

  let stereo: StereoPannerNode | undefined;
  try {
    stereo = context.createStereoPanner();
    stereo.pan.value = pan;
    stereo.connect(destination);
    distance.connect(stereo);
    gainNode.connect(distance);
    warnOnce(context, warn, false);
  } catch {
    disconnect(gainNode);
    disconnect(distance);
    disconnect(stereo);
    try { distance.connect(destination); gainNode.connect(distance); }
    catch { disconnect(gainNode); disconnect(distance); gainNode.connect(destination); }
    warnOnce(context, warn, true);
  }
}
