import { Mp3Encoder } from '@breezystack/lamejs';
import { createCueTiming } from './sound-timing';
import { connectBinaural, EFFECT_SPATIAL_PROFILES, makeMonoSafeAmbience, makeNarrationDucking, type SpatialProfile } from './sound-quality';

/** Times and durations are in seconds on the decoded narration timeline. */
export type Cue = { text: string; start: number; duration: number };
export type MixOptions = { music: boolean; effects: boolean; musicVolume: number; effectsVolume: number; spatial?: boolean };
export type MixResult = { blob: Blob; events: { label: string; time: number }[]; warnings: string[] };

type EffectName = 'rain' | 'forest' | 'ocean' | 'footsteps' | 'door' | 'page';
type EffectRule = { name: EffectName; label: string; pattern: RegExp; maxSeconds: number };
type PlannedEffect = { name: EffectName; label: string; time: number; maxSeconds: number };

// These are relative to the current origin, never a third-party service. No text
// from the manuscript is sent with these requests.
const ASSET_ROOT = `${import.meta.env.BASE_URL}soundscape`;
const EFFECT_ASSETS: EffectName[] = ['rain', 'forest', 'ocean', 'footsteps', 'door', 'page'];
const SAMPLE_RATE = 44_100;
const MAX_SECONDS = 600;
// Assets are expected to be approximately -20 LUFS, narration around -26 LUFS.
// Even volume=1 is attenuated so the narration remains in the foreground.
const MUSIC_GAIN = 0.065;
const EFFECT_GAIN = 0.075;
const VOICE_GAIN = 0.9;
// Sample-peak headroom for MP3 encoding, not a true-peak or headphone SPL guarantee.
const MIX_PEAK_LIMIT = 0.84;
// Guard against unexpectedly loud test assets as well as the fixed attenuation.
// This caps the loudest half-second asset window near -46 dBFS before MP3
// encoding; it never boosts a quiet sound and is not narration-side ducking.
const MAX_ASSET_WINDOW_RMS = 0.005;
// At most one ambient and one discrete effect may overlap: keep six seconds
// between starts in each group and two seconds between any two starts.
const GROUP_EFFECT_GAP = 6;
const GLOBAL_EFFECT_GAP = 2;
const SAME_EFFECT_GAP = 30;
const MIN_EFFECT_TAIL_SECONDS = 0.8;

// A local keyword heuristic, not semantic analysis. Korean suffixes are explicit
// and English words are bounded to avoid e.g. 비밀, 바다표범 and rainbow.
// Door/page require an action; walking and environmental nouns are approximations
// and can still be figurative or refer to an inaudible scene.
const RULES: EffectRule[] = [
  {
    name: 'rain', label: '빗소리', maxSeconds: 6,
    pattern: /(^|[^가-힣A-Za-z])((?:빗소리|빗방울|빗줄기|소나기|폭우|장대비|가랑비|비)(?:에서|에는|으로|이|가|은|는|을|를|와|에|의|도|만)?)(?![가-힣A-Za-z])|\b(rain(?:s|ing|ed|fall)?|rainfall|downpours?)\b/giu,
  },
  {
    name: 'forest', label: '숲', maxSeconds: 6,
    pattern: /(^|[^가-힣A-Za-z])((?:숲속|숲길|숲|삼림|산림)(?:에서|에는|으로|이|가|은|는|을|를|의|에|도)?)(?![가-힣A-Za-z])|\b(forests?|woods|woodlands?)\b/giu,
  },
  {
    name: 'ocean', label: '바다', maxSeconds: 6,
    pattern: /(^|[^가-힣A-Za-z])((?:바닷소리|바닷가|바닷물|바다|파도|해변|해안)(?:에서|에는|으로|가|이|는|은|를|을|에|로|의|도)?)(?![가-힣A-Za-z])|\b(oceans?|seas?|waves?\s+(?:crash(?:ed|es|ing)?|break(?:s|ing)?|broke|roll(?:ed|s|ing)?|lap(?:ped|s|ping)?))\b/giu,
  },
  {
    name: 'footsteps', label: '발소리', maxSeconds: 4,
    pattern: /(^|[^가-힣A-Za-z])((?:(?:발소리|발자국\s*소리|걸음\s*소리|발걸음)(?:이|가|은|는|을|를|에|의|도)?|걸어(?:갔|가|왔|오|다니)[가-힣]*|걸었[가-힣]*|걷(?:는|고|다|지|기)[가-힣]*))(?![가-힣A-Za-z])|\b(footsteps?|footfalls?|walk(?:ed|ing|s)?)\b/giu,
  },
  {
    name: 'door', label: '문 여닫는 소리', maxSeconds: 3,
    pattern: /(^|[^가-힣A-Za-z])((?:현관문|대문|방문|문)(?:을|이|은|는)?\s*(?:(?:살며시|조심스럽게|천천히|활짝|조용히|쾅|힘껏|세게|밀어|당겨|안|못)\s*){0,2}(?:열|닫)[가-힣]*)|\b((?<!\bthe\s)(?<!\ba\s)(?<!\ban\s)(?:open(?:ed|ing|s)?|clos(?:e|ed|ing|es)|shut(?:ting|s)?|slam(?:med|ming|s)?)\s+(?:(?:a|an|the|wooden|front|back|heavy|old|his|her|their|my|your)\s+){0,3}doors?|doors?\s+(?:(?:was|were|is|are|being)\s+)?(?:(?:creak(?:ed|s|ing)?|swing(?:s|ing)?|swung)\s+)?(?:open(?:ed|ing|s)?|clos(?:e|ed|ing|es)|shut(?:ting|s)?|slam(?:med|ming|s)?))\b/giu,
  },
  {
    name: 'page', label: '책장 넘기는 소리', maxSeconds: 3,
    pattern: /(^|[^가-힣A-Za-z])((?:책장|페이지|책)(?:을|를|이|가|은|는)?\s*(?:(?:살며시|천천히|조용히|한\s*장(?:씩)?|안|못)\s*){0,2}(?:넘기|넘겼|넘겨|넘어가|넘어갔|펼치|펼쳤|펼쳐|펴|바스락)[가-힣]*)|\b((?:turn(?:ed|ing|s)?|flip(?:ped|ping|s)?|rustl(?:e|es|ed|ing))\s+(?:(?:a|an|the|of|through|old|book|paper)\s+){0,3}pages?|pages?\s+(?:turn(?:ed|ing|s)?|flip(?:ped|ping|s)?|rustl(?:e|es|ed|ing))|open(?:ed|ing|s)?\s+(?:a|an|the|his|her|their|my|your)\s+(?:(?:old|new|heavy|large|small)\s+){0,2}books?)\b/giu,
  },
];

// A small set of clause boundaries prevents unrelated negations from propagating.
// Korean verb endings are approximate; this does not resolve scope or meaning.
// Temporal "not/never/n't yet" stays in its clause; conjunctive "yet" breaks it.
const CLAUSE_BREAK = /[,.!?。！？;\n]|\b(?:and|but|however|although|though|while)\b|(?<!\b(?:not|never)\s+)(?<!n['’]t\s+)\byet\b|[가-힣]+(?:고|지만|면서|으며|는데|으나)\s+/giu;

function clauseBefore(text: string): string {
  let start = 0;
  for (const match of text.matchAll(CLAUSE_BREAK)) start = (match.index ?? 0) + match[0].length;
  return text.slice(start);
}

function clauseAfter(text: string): string {
  const boundary = text.matchAll(CLAUSE_BREAK).next().value;
  if (!boundary || boundary.index === undefined) return text;
  // Keep the Korean connective itself: e.g. "오지 않고" contains the negator.
  return text.slice(0, boundary.index + (/^[가-힣]/.test(boundary[0]) ? boundary[0].trimEnd().length : 0));
}

/** Reject only explicit local negations and obvious static door/page states. */
function isNegated(text: string, index: number, length: number, name: EffectName): boolean {
  const matched = text.slice(index, index + length);
  const before = clauseBefore(text.slice(Math.max(0, index - 60), index));
  const rawAfter = text.slice(index + length, index + length + 60);
  // A denied statement is not evidence that its quoted event occurred. This
  // deliberately handles only nearby -다고/-라고 말하지 않았다 constructions;
  // it does not infer that the quoted event itself was false.
  if (/(?:다고|라고)(?:는|도)?$/.test(matched)
    && /^\s*(?:말|이야기|전|설명)하지\s*(?:않|못)/.test(rawAfter)) return true;
  if (/^\s+[가-힣]+(?:다고|라고)(?:는|도)?\s+(?:말|이야기|전|설명)하지\s*(?:않|못)/.test(rawAfter)) return true;
  // "열고 싶지 않았다" denies the desire, not a separate following clause.
  if (/(?:열|닫|넘|펼|펴|걸|걷)[가-힣]*고$/.test(matched)
    && /^\s*싶지(?:는|도|가)?\s*(?:않|못)/.test(rawAfter)) return true;
  // A Korean action whose matched verb ends in a connective starts a new clause.
  const after = /(?:고|지만|면서|으며|는데|으나)$/.test(matched)
    ? '' : clauseAfter(rawAfter);
  if (name === 'door' || name === 'page') {
    if (/(?:열려|닫혀|펼쳐져|펴져)\s*있/.test(matched + after)) return true;
    if (/^doors?\s+(?:was|were|is|are)\s+(?:open|closed|shut)$/i.test(matched)) return true;
  }
  if (/\b(?:no|not|never|without|(?:did|does|do|is|are|was|were|has|have|had|could|would|should|ca)n['’]t)\s+(?:[a-z]+\s+){0,3}$/i.test(before)) return true;
  // Negated stopping or letting up describes continuing rain, not its absence.
  if (!/^\s*(?:(?:(?:did|does|do|had|has|have|was|were|is|are)\s+)?(?:not|never)\b|(?:did|does|do|had|has|have|was|were|is|are)n['’]t\b)\s+(?:yet\s+)?(?:stop|cease|let\s+up)/i.test(after)
    && /^\s*(?:(?:(?:was|were|is|are|had|has|have|did|does|do)\s+)?(?:not\b|never\b)|(?:was|were|is|are|had|has|have|did|does|do)n['’]t\b|stopped\b|ceased\b)/i.test(after)) return true;

  if (/^(?:걸|걷)/.test(matched) && /(?:^|\s)(?:안|못)\s*$/.test(before)) return true;
  if (/(?:^|\s)(?:안|못)\s+(?:열|닫|넘|펼|펴|걸|걷)/.test(matched)) return true;
  if (/지(?:는|도)?$/.test(matched) && /^\s*(?:않|못)/.test(after)) return true;
  if (/\s*(?:수|수가)\s*없/.test(after) && /(?:열|닫|넘|펼|펴|걸|걷)[가-힣]*$/.test(matched)) return true;
  if (name === 'door' || name === 'page' || /(?:걸어|걸었|걷)/.test(matched)) return false;

  // Only common absence/silence predicates, not every unrelated "지 않았다".
  // An explicitly negated stopping predicate ("안 그쳤다") means continuation.
  const koreanAfter = after.slice(0, 35);
  return /^(?:\s+\S+){0,3}\s*(?:없|(?<!안\s+)(?<!못\s+)(?:그쳤|그치고|멈췄|멈추었|멈추고|멎었))/.test(koreanAfter)
    || ((name === 'forest' || name === 'ocean') && /(?:가|들어가)지(?:는|도)?\s*(?:않|못)/.test(koreanAfter))
    || /(?:올|내릴|쏟아질|떨어질|들릴|날|보일|찾을|나타날|들을)\s+(?:것|거)\s*같지(?:는|도|가)?\s*(?:않|못)/.test(koreanAfter)
    || /(?:오|내리|쏟아지|떨어지|들리|나|보이|찾|나타나|듣)지(?:는|도)?\s*(?:않|못)/.test(koreanAfter)
    || /(?:안|못)\s+(?:오|왔|내리|내렸|쏟아지|들리|보이|나타나)/.test(koreanAfter);
}

function hasPositiveAmbient(text: string, index: number, length: number): boolean {
  // Do not suppress inferred walking in another clause or sentence of a cue.
  const clause = clauseBefore(text.slice(Math.max(0, index - 160), index))
    + text.slice(index, index + length) + clauseAfter(text.slice(index + length, index + length + 160));
  for (const rule of RULES) {
    if (rule.name !== 'rain' && rule.name !== 'forest' && rule.name !== 'ocean') continue;
    for (const match of clause.matchAll(rule.pattern)) {
      const matchIndex = (match.index ?? 0) + (match[1]?.length ?? 0);
      const matched = match[2] ?? match[3] ?? '';
      if (matched && !isNegated(clause, matchIndex, matched.length, rule.name)) return true;
    }
  }
  return false;
}

function planEffects(cues: Cue[], duration: number, voice: AudioBuffer): { plans: PlannedEffect[]; invalidCount: number; tooShortCount: number } {
  const candidates: PlannedEffect[] = [];
  let invalidCount = 0;
  let tooShortCount = 0;
  for (const cue of cues) {
    if (!cue || typeof cue.text !== 'string' || !Number.isFinite(cue.start) || !Number.isFinite(cue.duration)
      || cue.start < 0 || cue.start >= duration || cue.duration <= 0) {
      invalidCount++;
      continue;
    }
    const span = Math.min(cue.duration, duration - cue.start);
    if (span <= 0 || !cue.text.length) continue;
    // PDF and DOCX text may contain decomposed Hangul. Analyze and time the
    // normalized text together so match offsets and the speech clock agree;
    // do not mutate the manuscript or the original cue.
    const normalized = cue.text.normalize('NFC');
    const analysisCue = normalized === cue.text ? cue : { ...cue, text: normalized };
    let timing: ReturnType<typeof createCueTiming> | undefined;
    for (const rule of RULES) {
      // matchAll clones the regular expression, so state never leaks between cues.
      for (const match of analysisCue.text.matchAll(rule.pattern)) {
        const prefixLength = match[1]?.length ?? 0;
        const index = (match.index ?? 0) + prefixLength;
        const matched = match[2] ?? match[3] ?? '';
        if (!matched || isNegated(analysisCue.text, index, matched.length, rule.name)) continue;
        // Walking alone only implies footsteps. Preserve an explicit setting in
        // the same clause instead; actual footstep-sound words remain independent.
        if (rule.name === 'footsteps' && /^(?:walk|걸어|걸었|걷)/i.test(matched)) {
          if (hasPositiveAmbient(analysisCue.text, index, matched.length)) continue;
        }
        // Still an estimate, not word-level alignment. Analyze this cue's
        // decoded narration only once, and fall back if its waveform is unclear.
        timing ??= createCueTiming(analysisCue, voice);
        const discrete = rule.name === 'door' || rule.name === 'footsteps' || rule.name === 'page';
        let time = timing.locate(index, matched.length, discrete);
        // Never report a nominal event that is truncated to silence by the end
        // of the narration. Shift locally inside the same cue when possible.
        const latestStart = duration - MIN_EFFECT_TAIL_SECONDS;
        if (time > latestStart) {
          if (cue.start > latestStart) { tooShortCount++; continue; }
          time = latestStart;
        }
        candidates.push({ name: rule.name, label: rule.label, time, maxSeconds: rule.maxSeconds });
      }
    }
  }
  candidates.sort((a, b) => a.time - b.time);
  const plans: PlannedEffect[] = [];
  const lastByType = new Map<EffectName, number>();
  const lastByGroup = new Map<'ambient' | 'discrete', number>();
  let last = -Infinity;
  for (const candidate of candidates) {
    const group = candidate.name === 'rain' || candidate.name === 'forest' || candidate.name === 'ocean' ? 'ambient' : 'discrete';
    if (candidate.time - last < GLOBAL_EFFECT_GAP
      || candidate.time - (lastByGroup.get(group) ?? -Infinity) < GROUP_EFFECT_GAP
      || candidate.time - (lastByType.get(candidate.name) ?? -Infinity) < SAME_EFFECT_GAP) continue;
    plans.push(candidate);
    last = candidate.time;
    lastByGroup.set(group, candidate.time);
    lastByType.set(candidate.name, candidate.time);
  }
  return { plans, invalidCount, tooShortCount };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('오디오 믹싱이 취소되었습니다.', 'AbortError');
}

// Count both a mix's lifetime and its non-cancellable physical operations.
// Keeping the lifetime counted closes gaps between a fulfilled promise and the
// next decode/render, and ensures cancellation has finished scheduling cleanup.
let soundscapeWork = 0;
const idleWaiters = new Set<() => void>();

function beginSoundscapeWork(): () => void {
  soundscapeWork++;
  return () => {
    soundscapeWork--;
    if (soundscapeWork === 0) {
      const waiters = [...idleWaiters];
      idleWaiters.clear();
      waiters.forEach((resolve) => resolve());
    }
  };
}

function trackPhysical<T>(operation: Promise<T>): Promise<T> {
  const finish = beginSoundscapeWork();
  // Handle both outcomes without creating an unhandled rejecting promise.
  void operation.then(finish, finish);
  return operation;
}

/** Synchronous snapshot for UI locking; callers must still wait for idle. */
export function hasPendingSoundscapeWork(): boolean {
  return soundscapeWork > 0;
}

/** Wait for active mixes and their underlying browser operations to settle.
 * New work must be prevented by the caller while it is waiting. */
export async function waitForSoundscapeIdle(): Promise<void> {
  while (soundscapeWork > 0) {
    await new Promise<void>((resolve) => idleWaiters.add(resolve));
  }
}

/** Stop waiting immediately; Web Audio's in-flight decode/render may continue internally. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(new DOMException('오디오 믹싱이 취소되었습니다.', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new DOMException('오디오 믹싱이 취소되었습니다.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

// Each reservation includes all earlier reservations. A cancelled waiter releases
// its own reservation without allowing later work to pass an active render.
let offlineTail: Promise<void> | undefined;
async function acquireOfflineSlot(report: (message: string) => void, signal?: AbortSignal): Promise<() => void> {
  throwIfAborted(signal);
  const previous = offlineTail;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const slot = previous ? previous.then(() => held) : held;
  offlineTail = slot;
  void slot.then(() => { if (offlineTail === slot) offlineTail = undefined; });
  try {
    if (previous) {
      report('이전 오디오 작업이 끝나기를 기다리고 있어요');
      await abortable(previous, signal);
    }
    throwIfAborted(signal);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

async function loadAsset(context: AudioContext, filename: string, signal?: AbortSignal): Promise<AudioBuffer> {
  const url = filename === 'music-calm'
    ? `${ASSET_ROOT}/${filename}.mp3`
    : `${ASSET_ROOT}/tinyaudio-v1/${filename}.mp3`;
  let bytes: ArrayBuffer;
  try {
    throwIfAborted(signal);
    const response = await abortable(fetch(url, { credentials: 'same-origin', signal }), signal);
    throwIfAborted(signal);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    throwIfAborted(signal);
    bytes = await abortable(trackPhysical(response.arrayBuffer()), signal);
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`음향 파일 ${url}을 불러오지 못했습니다: ${errorMessage(error)}`);
  }
  try {
    throwIfAborted(signal);
    const result = await abortable(trackPhysical(context.decodeAudioData(bytes)), signal);
    if (!result.length || !result.duration) throw new Error('빈 오디오 파일입니다.');
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`음향 파일 ${url}을 디코딩하지 못했습니다: ${errorMessage(error)}`);
  }
}

/** Make an overlap-crossfaded loop. Keep the original mono path unchanged. */
function makeMusicLoop(context: AudioContext, source: AudioBuffer, stereo = false): AudioBuffer {
  const overlap = Math.min(Math.round(source.sampleRate * 0.2), Math.floor(source.length / 4));
  if (overlap < 1) throw new Error('배경음 파일이 너무 짧아 반복할 수 없습니다.');
  const length = source.length - overlap;
  if (stereo) {
    const result = context.createBuffer(2, length, source.sampleRate);
    for (let side = 0; side < 2; side++) {
      const target = result.getChannelData(side);
      const channel = source.getChannelData(Math.min(side, source.numberOfChannels - 1));
      const directLength = source.length - 2 * overlap;
      for (let i = 0; i < directLength; i++) target[i] = channel[i + overlap];
      for (let i = 0; i < overlap; i++) {
        const fade = (i + 1) / overlap;
        target[directLength + i] = channel[source.length - overlap + i] * (1 - fade) + channel[i] * fade;
      }
    }
    return result;
  }
  const result = context.createBuffer(1, length, source.sampleRate);
  const target = result.getChannelData(0);
  const channels = Array.from({ length: source.numberOfChannels }, (_, i) => source.getChannelData(i));
  const directLength = source.length - 2 * overlap;
  for (const channel of channels) {
    const weight = 1 / channels.length;
    for (let i = 0; i < directLength; i++) target[i] += channel[i + overlap] * weight;
    for (let i = 0; i < overlap; i++) {
      const fade = (i + 1) / overlap;
      target[directLength + i] += (channel[source.length - overlap + i] * (1 - fade) + channel[i] * fade) * weight;
    }
  }
  return result;
}

/** Reduce (never boost) unusually loud assets before applying the user's volume. */
function safeAssetGain(buffer: AudioBuffer, maxSeconds: number, baseGain: number, userVolume: number, stereo = false): number {
  const count = Math.min(buffer.length, Math.ceil(maxSeconds * buffer.sampleRate));
  if (!count) return 0;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const windowLength = Math.max(1, Math.min(count, Math.round(buffer.sampleRate * 0.5)));
  let maxRms = 0;
  let energy = 0;
  const channelEnergy = new Float64Array(channels.length);
  let windowSamples = 0;
  for (let i = 0; i < count; i++) {
    let mono = 0;
    for (let j = 0; j < channels.length; j++) {
      const sample = channels[j][i];
      mono += sample / channels.length;
      // Stereo sources can contain opposing phases whose mono RMS is misleading.
      if (stereo) channelEnergy[j] += sample * sample;
    }
    energy += mono * mono;
    windowSamples++;
    if (windowSamples === windowLength || i === count - 1) {
      maxRms = Math.max(maxRms, Math.sqrt(energy / windowSamples));
      if (stereo) {
        for (let j = 0; j < channelEnergy.length; j++) {
          maxRms = Math.max(maxRms, Math.sqrt(channelEnergy[j] / windowSamples));
          channelEnergy[j] = 0;
        }
      }
      energy = 0;
      windowSamples = 0;
    }
  }
  return Math.min(baseGain, maxRms > 0 ? MAX_ASSET_WINDOW_RMS / maxRms : baseGain) * userVolume;
}

function scheduleFadedSource(context: OfflineAudioContext, buffer: AudioBuffer, start: number, duration: number, gainValue: number, loop: boolean, destination: AudioNode, placement?: SpatialProfile, warnFallback?: (centered?: boolean) => void): void {
  if (duration <= 0) return;
  const node = context.createBufferSource();
  const gain = context.createGain();
  node.buffer = buffer;
  node.loop = loop;
  node.connect(gain);
  if (!placement) {
    gain.connect(destination);
  } else {
    connectBinaural(context, gain, placement, destination, warnFallback ?? (() => {}));
  }
  const fade = Math.min(loop ? 0.5 : 0.04, duration / 2);
  const fadeOut = Math.min(loop ? 0.8 : 0.15, duration / 2);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(gainValue, start + fade);
  gain.gain.setValueAtTime(gainValue, start + duration - fadeOut);
  gain.gain.linearRampToValueAtTime(0, start + duration);
  node.start(start);
  node.stop(start + duration);
}

async function encodeMp3(buffer: AudioBuffer, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<Blob> {
  // Give the status update a chance to paint before starting CPU-bound work.
  await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
  throwIfAborted(signal);
  const samples = buffer.getChannelData(0);
  const rightSamples = buffer.numberOfChannels === 2 ? buffer.getChannelData(1) : undefined;
  let peak = 0;
  // Use one scale for both sides so peak control does not move stereo positions.
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]), rightSamples ? Math.abs(rightSamples[i]) : 0);
  }
  const scale = peak > MIX_PEAK_LIMIT ? MIX_PEAK_LIMIT / peak : 1;
  const encoder = new Mp3Encoder(rightSamples ? 2 : 1, buffer.sampleRate, rightSamples ? 192 : 128);
  const parts: ArrayBuffer[] = [];
  const blockSize = 1152;
  const pcm = new Int16Array(blockSize);
  const rightPcm = rightSamples ? new Int16Array(blockSize) : undefined;
  for (let offset = 0, block = 0; offset < samples.length; offset += blockSize, block++) {
    throwIfAborted(signal);
    const count = Math.min(blockSize, samples.length - offset);
    for (let i = 0; i < count; i++) {
      const value = Math.max(-1, Math.min(1, samples[offset + i] * scale));
      pcm[i] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
      if (rightPcm && rightSamples) {
        const rightValue = Math.max(-1, Math.min(1, rightSamples[offset + i] * scale));
        rightPcm[i] = rightValue < 0 ? Math.round(rightValue * 32768) : Math.round(rightValue * 32767);
      }
    }
    const leftBlock = count === blockSize ? pcm : pcm.subarray(0, count);
    const rightBlock = rightPcm ? (count === blockSize ? rightPcm : rightPcm.subarray(0, count)) : undefined;
    const encoded = rightBlock ? encoder.encodeBuffer(leftBlock, rightBlock) : encoder.encodeBuffer(leftBlock);
    if (encoded.length) parts.push(Uint8Array.from(encoded).buffer);
    // Yield to the browser so status messages paint during long encodes.
    if (block > 0 && block % 256 === 0) {
      onProgress?.(`MP3 인코딩 중… ${Math.min(99, Math.round((offset + count) / samples.length * 100))}%`);
      await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
    }
  }
  throwIfAborted(signal);
  const tail = encoder.flush();
  if (tail.length) parts.push(Uint8Array.from(tail).buffer);
  if (!parts.length) throw new Error('MP3 인코딩 결과가 비어 있습니다.');
  return new Blob(parts, { type: 'audio/mpeg' });
}

/**
 * Mix a local narration MP3 and same-origin sound assets entirely in the browser.
 * Returns a mono MP3 by default, or two-channel headphone audio with generic
 * HRTF on discrete effects when available. This is not Dolby Atmos or 5.1.
 * Event times use decoded voice energy as an approximation, not speech recognition.
 */
export async function mixSoundscape(
  voiceBlob: Blob,
  cues: Cue[],
  options: MixOptions,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<MixResult> {
  const finish = beginSoundscapeWork();
  try {
    return await mixSoundscapeInternal(voiceBlob, cues, options, onProgress, signal);
  } finally {
    finish();
  }
}

async function mixSoundscapeInternal(
  voiceBlob: Blob,
  cues: Cue[],
  options: MixOptions,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<MixResult> {
  throwIfAborted(signal);
  if (!(voiceBlob instanceof Blob) || voiceBlob.size === 0) throw new Error('낭독 오디오가 비어 있습니다.');
  if (!Array.isArray(cues)) throw new Error('음성 구간 정보가 올바르지 않습니다.');
  if (!options || typeof options.music !== 'boolean' || typeof options.effects !== 'boolean'
    || (options.spatial !== undefined && typeof options.spatial !== 'boolean')
    || !Number.isFinite(options.musicVolume) || options.musicVolume < 0 || options.musicVolume > 1
    || !Number.isFinite(options.effectsVolume) || options.effectsVolume < 0 || options.effectsVolume > 1) {
    throw new Error('음향 설정이 올바르지 않습니다. 음량은 0에서 1 사이여야 합니다.');
  }
  if (typeof window === 'undefined') throw new Error('이 믹싱 기능은 Web Audio를 지원하는 브라우저에서만 사용할 수 있습니다.');
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const OfflineContextClass = window.OfflineAudioContext
    ?? (window as typeof window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineContextClass) throw new Error('이 브라우저는 Web Audio 오프라인 믹싱을 지원하지 않습니다.');

  const report = (message: string) => { if (!signal?.aborted) onProgress?.(message); };
  report('낭독 오디오를 브라우저에서 불러옵니다…');
  throwIfAborted(signal);
  let decoder: AudioContext;
  try {
    decoder = new AudioContextClass({ sampleRate: SAMPLE_RATE });
  } catch (error) {
    throw new Error(`오디오 디코더를 시작하지 못했습니다: ${errorMessage(error)}`);
  }
  try {
    let voice: AudioBuffer;
    try {
      const voiceBytes = await abortable(trackPhysical(voiceBlob.arrayBuffer()), signal);
      throwIfAborted(signal);
      voice = await abortable(trackPhysical(decoder.decodeAudioData(voiceBytes)), signal);
      if (!voice.length || !Number.isFinite(voice.duration) || voice.duration <= 0) throw new Error('빈 오디오입니다.');
    } catch (error) {
      throwIfAborted(signal);
      throw new Error(`낭독 MP3를 디코딩하지 못했습니다: ${errorMessage(error)}`);
    }
    throwIfAborted(signal);
    // Check before allocating an OfflineAudioContext timeline; never truncate.
    if (voice.duration > MAX_SECONDS) {
      throw new Error('메모리 사용을 제한하기 위해 믹싱은 최대 10분까지만 지원합니다. 낭독을 10분 이하로 나누어 다시 시도해 주세요.');
    }
    const warnings: string[] = [];
    if (options.spatial) warnings.push('효과음 위치는 원고의 실제 위치가 아닌 창작적 자동 배치입니다. 개인화되지 않은 HRTF의 입체감은 이어폰과 청취자에 따라 다르며 영화관 다채널 음향이 아닙니다.');
    let fallbackWarning = false;
    let centeredWarning = false;
    const warnFallback = (centered = false) => {
      if (centered && !centeredWarning) {
        centeredWarning = true;
        warnings.push('이 브라우저에서 스테레오 패닝을 사용할 수 없어 해당 음향을 중앙에 배치했습니다.');
      } else if (!centered && !fallbackWarning) {
        fallbackWarning = true;
        warnings.push('이 브라우저에서 HRTF를 사용할 수 없어 일부 효과음에 일반 스테레오 패닝을 사용했습니다.');
      }
    };
    const musicEnabled = options.music && options.musicVolume > 0;
    const effectsEnabled = options.effects && options.effectsVolume > 0;
    if (options.music && !musicEnabled) warnings.push('배경음 음량이 0이어서 배경음을 추가하지 않았습니다.');
    if (options.effects && !effectsEnabled) warnings.push('효과음 음량이 0이어서 효과음을 추가하지 않았습니다.');
    const { plans, invalidCount, tooShortCount } = effectsEnabled ? planEffects(cues, voice.duration, voice) : { plans: [], invalidCount: 0, tooShortCount: 0 };
    if (invalidCount) warnings.push(`시간 정보가 올바르지 않은 음성 구간 ${invalidCount}개는 효과음 분석에서 제외했습니다.`);
    if (tooShortCount) warnings.push(`끝부분에 재생 시간이 부족한 효과음 ${tooShortCount}개는 생략했습니다.`);
    if (effectsEnabled && !plans.length && !tooShortCount) warnings.push('원고에서 효과음을 넣을 만한 단서를 찾지 못해 효과음을 추가하지 않았습니다.');

    const assets = new Map<string, AudioBuffer>();
    // Request the same effect assets in the same order, including when no cues
    // match, so server access logs cannot reveal which manuscript cues matched.
    const names = [...(musicEnabled ? ['music-calm'] : []), ...(effectsEnabled ? EFFECT_ASSETS : [])];
    for (let i = 0; i < names.length; i++) {
      throwIfAborted(signal);
      report(`음향 파일을 불러옵니다… (${i + 1}/${names.length})`);
      throwIfAborted(signal);
      const asset = await loadAsset(decoder, names[i], signal);
      assets.set(names[i], makeMonoSafeAmbience(decoder, asset));
    }
    throwIfAborted(signal);
    const scheduled: PlannedEffect[] = [];
    const releaseOffline = await acquireOfflineSlot(report, signal);
    let renderingStarted = false;
    let rendered: AudioBuffer;
    try {
      throwIfAborted(signal);
      report('낭독과 음향을 브라우저에서 믹싱합니다…');
      throwIfAborted(signal);
      // Mono saves roughly half the timeline memory and matches the mono TTS.
      // Spatial rendering requires two channels and therefore more memory.
      // decodeAudioData uses the context rate, so the output duration is unchanged.
      const frameCount = Math.ceil(voice.duration * SAMPLE_RATE);
      const spatial = options.spatial === true;
      let offline: OfflineAudioContext;
      try {
        offline = new OfflineContextClass(spatial ? 2 : 1, frameCount, SAMPLE_RATE);
        const voiceSource = offline.createBufferSource();
        const voiceGain = offline.createGain();
        voiceSource.buffer = voice;
        voiceGain.gain.value = VOICE_GAIN;
        if (spatial) {
          // Explicit mono speaker downmix followed by the destination's stereo
          // upmix keeps narration identical and in phase in both ears.
          voiceGain.channelCount = 1;
          voiceGain.channelCountMode = 'explicit';
          voiceGain.channelInterpretation = 'speakers';
        }
        voiceSource.connect(voiceGain);
        voiceGain.connect(offline.destination);
        voiceSource.start(0);
        // Narration remains dry and centered; only the shared sound bed is ducked.
        const soundBus = makeNarrationDucking(offline, voice);
        const music = assets.get('music-calm');
        if (music) {
          const loop = makeMusicLoop(decoder, music, spatial);
          assets.delete('music-calm');
          const musicGain = safeAssetGain(loop, loop.duration, MUSIC_GAIN, options.musicVolume, spatial);
          scheduleFadedSource(offline, loop, 0, voice.duration, musicGain, true, soundBus, spatial ? { pan: 0, wide: true, depth: 0 } : undefined, warnFallback);
        }
        const effectGains = new Map<EffectName, number>();
        for (const plan of plans) {
          const effect = assets.get(plan.name)!;
          const length = Math.min(effect.duration, plan.maxSeconds, voice.duration - plan.time);
          if (length <= 0.001) {
            warnings.push(`재생할 수 없는 ${plan.label} 효과음은 생략했습니다.`);
            continue;
          }
          let effectGain = effectGains.get(plan.name);
          if (effectGain === undefined) {
            effectGain = safeAssetGain(effect, plan.maxSeconds, EFFECT_GAIN, options.effectsVolume, spatial);
            effectGains.set(plan.name, effectGain);
          }
          scheduleFadedSource(offline, effect, plan.time, length, effectGain, false, soundBus, spatial ? EFFECT_SPATIAL_PROFILES[plan.name] : undefined, warnFallback);
          scheduled.push(plan);
        }
      } catch (error) {
        throw new Error(`오디오 믹싱을 준비하지 못했습니다. 브라우저 메모리를 확인해 주세요: ${errorMessage(error)}`);
      }
      try {
        const rendering = trackPhysical(offline.startRendering());
        // Abort only stops our wait: the browser may still be rendering. Release
        // the slot on the physical promise's settlement, even after cancellation.
        void rendering.then(releaseOffline, releaseOffline);
        renderingStarted = true;
        rendered = await abortable(rendering, signal);
      } catch (error) {
        throwIfAborted(signal);
        throw new Error(`오디오 믹싱에 실패했습니다. 브라우저 메모리를 확인해 주세요: ${errorMessage(error)}`);
      }
    } finally {
      // Construction, graph setup or startRendering itself may throw.
      if (!renderingStarted) releaseOffline();
    }
    throwIfAborted(signal);
    report('혼합한 오디오를 MP3로 인코딩합니다…');
    let blob: Blob;
    try {
      blob = await encodeMp3(rendered, report, signal);
    } catch (error) {
      throwIfAborted(signal);
      throw new Error(`MP3 인코딩에 실패했습니다: ${errorMessage(error)}`);
    }
    throwIfAborted(signal);
    report('오디오 믹싱이 완료되었습니다.');
    return { blob, events: scheduled.map(({ label, time }) => ({ label, time })), warnings };
  } finally {
    try {
      const closing = trackPhysical(decoder.close());
      if (signal?.aborted) void closing.catch(() => undefined);
      else await closing;
    } catch { /* best-effort release */ }
  }
}
