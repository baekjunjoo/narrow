import React, { useId, useLayoutEffect, useRef, useState } from "react";
import type {
  CustomSoundRule,
  EffectName,
  SoundRuleSettings,
} from "../lib/soundscape";
import "./SoundRules.css";

const STORAGE_KEY = "narravo.sound-rules.v1";
const MAX_RULES = 50;
// Protect startup from an unexpectedly large or corrupt localStorage value.
const MAX_STORAGE_LENGTH = 100_000;
const EFFECTS: { name: EffectName; label: string }[] = [
  { name: "rain", label: "비" },
  { name: "forest", label: "숲" },
  { name: "ocean", label: "바다" },
  { name: "footsteps", label: "발소리" },
  { name: "door", label: "문 여닫는 소리" },
  { name: "page", label: "책장 넘기는 소리" },
];
const EFFECT_NAMES = new Set<string>(EFFECTS.map(effect => effect.name));
const SAVE_ERROR =
  "이번 브라우저에서만 사용, 저장 실패: 설정을 기기에 저장하지 못했습니다. 현재 화면에서는 유지되지만 새로고침하면 사라질 수 있습니다.";
const READ_WARNING =
  "저장된 음향 규칙 중 확인할 수 없는 항목을 제외하거나 정리해 표시했습니다. 기존 저장 데이터는 그대로이며 변경 시 교체 여부를 묻습니다.";
const CONFLICT_WARNING =
  "저장 실패: 다른 탭 등에서 저장된 음향 규칙이 바뀌어 덮어쓰지 않았습니다. 현재 화면의 변경은 이 탭에만 남아 있습니다. 사용자 규칙 문구와 기본 단서 체크 상태를 따로 복사하거나 기록한 뒤 새로고침하여 최신 설정을 확인하고 필요한 변경을 다시 적용해 주세요.";
const CONFIRM_REPLACE =
  "기존에 저장된 음향 규칙에 불러오지 못했거나 정리된 내용이 있습니다. 계속하면 확인할 수 없는 원본 내용이 사라지고 현재 화면의 설정으로 교체됩니다. 필요한 내용은 먼저 따로 보관해 주세요. 교체하시겠습니까?";

export type SoundRuleSnapshot = {
  raw: string | null;
  requiresConfirmation: boolean;
} | null;

export type SoundRuleStorageState = {
  settings: SoundRuleSettings;
  warning: string;
  snapshot: SoundRuleSnapshot;
};

const emptySettings = (): SoundRuleSettings => ({
  disabledBuiltins: [],
  customRules: [],
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isEffect = (value: unknown): value is EffectName =>
  typeof value === "string" && EFFECT_NAMES.has(value);
const normalizePhrase = (value: string) => value.normalize("NFC").trim();
const characterCount = (value: string) => Array.from(value).length;
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  characterCount(value) > 0 &&
  characterCount(value) <= 128 &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Parse without modifying input. A caller saving settings must reject any filtered data. */
function validateSettings(input: unknown): {
  settings: SoundRuleSettings;
  changed: boolean;
  invalid: boolean;
} {
  const settings = emptySettings();
  if (
    !isRecord(input) ||
    !Array.isArray(input.disabledBuiltins) ||
    !Array.isArray(input.customRules)
  ) {
    return { settings, changed: true, invalid: true };
  }
  let changed = false;
  let invalid = false;
  const builtins = new Set<EffectName>();
  for (const entry of input.disabledBuiltins) {
    if (!isEffect(entry) || builtins.has(entry)) {
      invalid = changed = true;
      continue;
    }
    builtins.add(entry);
    settings.disabledBuiltins.push(entry);
  }
  const ids = new Set<string>();
  for (const entry of input.customRules) {
    if (
      !isRecord(entry) ||
      !validId(entry.id) ||
      typeof entry.phrase !== "string" ||
      !isEffect(entry.effect) ||
      typeof entry.enabled !== "boolean"
    ) {
      invalid = changed = true;
      continue;
    }
    const phrase = normalizePhrase(entry.phrase);
    if (
      characterCount(phrase) < 1 ||
      characterCount(phrase) > 80 ||
      ids.has(entry.id) ||
      settings.customRules.length >= MAX_RULES
    ) {
      invalid = changed = true;
      continue;
    }
    if (phrase !== entry.phrase) changed = true;
    ids.add(entry.id);
    settings.customRules.push({
      id: entry.id,
      phrase,
      effect: entry.effect,
      enabled: entry.enabled,
    });
  }
  return { settings, changed, invalid };
}

/** Does not write or remove anything, including malformed or inaccessible data. */
export function readSoundRules(): SoundRuleStorageState {
  if (typeof window === "undefined")
    return { settings: emptySettings(), warning: "", snapshot: null };
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return {
      settings: emptySettings(),
      warning:
        "저장된 음향 규칙을 불러오지 못했습니다. 기존 저장 데이터는 변경하지 않았습니다. 브라우저 저장소 설정을 확인한 뒤 새로고침해 주세요.",
      snapshot: null,
    };
  }
  if (stored === null)
    return { settings: emptySettings(), warning: "", snapshot: { raw: null, requiresConfirmation: false } };
  if (stored.length > MAX_STORAGE_LENGTH) {
    return {
      settings: emptySettings(),
      warning:
        "저장된 음향 규칙이 너무 커서 불러오지 못했습니다. 기존 저장 데이터는 그대로이며 변경 시 교체 여부를 묻습니다.",
      snapshot: { raw: stored, requiresConfirmation: true },
    };
  }
  try {
    const result = validateSettings(JSON.parse(stored) as unknown);
    return {
      settings: result.settings,
      warning: result.changed ? READ_WARNING : "",
      snapshot: { raw: stored, requiresConfirmation: result.changed },
    };
  } catch {
    return {
      settings: emptySettings(),
      warning:
        "저장된 음향 규칙을 불러오지 못했습니다. 기존 저장 데이터는 그대로이며 변경 시 교체 여부를 묻습니다.",
      snapshot: { raw: stored, requiresConfirmation: true },
    };
  }
}

/** Compare the last-read value before saving; simultaneous tab writes can still race. */
export async function saveSoundRules(
  settings: SoundRuleSettings,
  snapshot: SoundRuleSnapshot
): Promise<{ warning: string; snapshot: SoundRuleSnapshot }> {
  const failed = (warning: string) => ({ warning, snapshot });
  try {
    const result = validateSettings(settings);
    if (result.invalid)
      return failed("이번 브라우저에서만 사용, 저장 실패: 올바르지 않은 항목이 있어 저장하지 않았습니다. 기존 저장 데이터는 그대로이며 새로고침하면 현재 설정이 사라질 수 있습니다.");
    if (typeof window === "undefined" || !snapshot) return failed(SAVE_ERROR);
    const serialized = JSON.stringify(result.settings);
    if (serialized.length > MAX_STORAGE_LENGTH)
      return failed("이번 브라우저에서만 사용, 저장 실패: 설정이 너무 커서 저장하지 않았습니다. 기존 저장 데이터는 그대로이며 새로고침하면 현재 설정이 사라질 수 있습니다.");
    const storage = window.localStorage;
    if (storage.getItem(STORAGE_KEY) !== snapshot.raw) return failed(CONFLICT_WARNING);
    if (snapshot.requiresConfirmation && !window.confirm(CONFIRM_REPLACE))
      return failed("저장을 취소했습니다. 기존 저장 데이터는 그대로이고 현재 변경은 이 화면에만 남아 있습니다. 다시 변경하면 교체 여부를 다시 선택할 수 있습니다.");
    if (storage.getItem(STORAGE_KEY) !== snapshot.raw) return failed(CONFLICT_WARNING);
    storage.setItem(STORAGE_KEY, serialized);
    return { warning: "", snapshot: { raw: serialized, requiresConfirmation: false } };
  } catch {
    return failed(SAVE_ERROR);
  }
}

let nextFallbackId = 0;
function newRuleId(rules: CustomSoundRule[]): string {
  const used = new Set(rules.map(rule => rule.id));
  // randomUUID can be unavailable or throw in restricted browser contexts.
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      const id = crypto.randomUUID();
      if (!used.has(id)) return id;
    }
  } catch {
    /* Use the collision-checked local fallback. */
  }
  let id: string;
  do {
    id = `rule-${Date.now().toString(36)}-${(++nextFallbackId).toString(36)}`;
  } while (used.has(id));
  return id;
}

function sameRule(a: CustomSoundRule, b: CustomSoundRule): boolean {
  return (
    a.id === b.id &&
    a.phrase === b.phrase &&
    a.effect === b.effect &&
    a.enabled === b.enabled
  );
}

export default function SoundRules({
  value,
  onChange,
  disabled = false,
  storageError = "",
}: {
  value: SoundRuleSettings;
  onChange: (next: SoundRuleSettings) => void;
  disabled?: boolean;
  storageError?: string;
}) {
  const id = useId();
  const [phrase, setPhrase] = useState("");
  const [effect, setEffect] = useState<EffectName>("rain");
  const [editing, setEditing] = useState<CustomSoundRule | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const phraseRef = useRef<HTMLInputElement>(null);
  const editButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const focusRef = useRef<{ input: true } | { ruleId: string } | null>(null);
  const dirty = editing
    ? phrase !== editing.phrase || effect !== editing.effect
    : phrase !== "" || effect !== "rain";

  useLayoutEffect(() => {
    const target = focusRef.current;
    if (!target) return;
    focusRef.current = null;
    if (disabled) return;
    if ("input" in target) phraseRef.current?.focus();
    else
      (editButtonsRef.current.get(target.ruleId) ?? phraseRef.current)?.focus();
  });

  const confirmDiscard = () =>
    !dirty || window.confirm("작성 중인 내용을 버리시겠습니까?");
  const resetDraft = () => {
    setPhrase("");
    setEffect("rain");
    setEditing(null);
    setError("");
  };
  const publish = (next: SoundRuleSettings, message: string): boolean => {
    try {
      onChange(next);
      setNotice(message);
      return true;
    } catch {
      setNotice("설정을 적용하지 못했습니다. 입력한 내용은 유지됩니다.");
      return false;
    }
  };

  const startEdit = (rule: CustomSoundRule, index: number) => {
    if (editing?.id === rule.id) {
      phraseRef.current?.focus();
      return;
    }
    if (!confirmDiscard()) return;
    setEditing({ ...rule });
    setPhrase(rule.phrase);
    setEffect(rule.effect);
    setError("");
    setNotice(`${index + 1}번 규칙을 수정합니다.`);
    focusRef.current = { input: true };
  };

  const applyDraft = () => {
    const normalized = normalizePhrase(phrase);
    const length = characterCount(normalized);
    if (length < 1 || length > 80) {
      const message = "문구는 앞뒤 공백을 제외하고 1~80자로 입력해 주세요.";
      setError(message);
      setNotice(message);
      phraseRef.current?.focus();
      return;
    }
    if (!isEffect(effect)) {
      setError("효과음을 선택해 주세요.");
      setNotice("효과음을 선택해 주세요.");
      return;
    }
    if (editing) {
      const current = value.customRules.find(rule => rule.id === editing.id);
      if (!current || !sameRule(current, editing)) {
        const message =
          "수정 중인 규칙이 다른 곳에서 변경되었거나 삭제되었습니다. 입력은 유지됩니다. 취소 후 다시 확인해 주세요.";
        setError(message);
        setNotice(message);
        return;
      }
      const updated = { ...current, phrase: normalized, effect };
      if (
        publish(
          {
            ...value,
            customRules: value.customRules.map(rule =>
              rule.id === editing.id ? updated : rule
            ),
          },
          "사용자 규칙을 수정했습니다."
        )
      ) {
        focusRef.current = { ruleId: editing.id };
        resetDraft();
      }
    } else {
      if (value.customRules.length >= MAX_RULES) {
        const message = "사용자 규칙은 최대 50개까지 추가할 수 있습니다.";
        setError(message);
        setNotice(message);
        return;
      }
      const rule: CustomSoundRule = {
        id: newRuleId(value.customRules),
        phrase: normalized,
        effect,
        enabled: true,
      };
      if (
        publish(
          { ...value, customRules: [...value.customRules, rule] },
          "사용자 규칙을 추가했습니다. 새 규칙은 켜져 있습니다."
        )
      ) {
        focusRef.current = { input: true };
        resetDraft();
      }
    }
  };

  const removeRule = (rule: CustomSoundRule, index: number) => {
    const draftWarning =
      editing?.id === rule.id && dirty ? " 수정 중인 입력도 사라집니다." : "";
    if (
      !window.confirm(
        `${index + 1}번 규칙 ‘${rule.phrase}’을 삭제하시겠습니까?${draftWarning}`
      )
    )
      return;
    const remaining = value.customRules.filter(item => item.id !== rule.id);
    if (
      publish(
        { ...value, customRules: remaining },
        `${index + 1}번 사용자 규칙을 삭제했습니다.`
      )
    ) {
      if (editing?.id === rule.id) resetDraft();
      const next = remaining[index] ?? remaining[index - 1];
      focusRef.current = next ? { ruleId: next.id } : { input: true };
    }
  };

  return (
    <section className="sound-rules" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>효과음 단서와 사용자 규칙</h3>
      <p>
        장면 효과음이 켜진 상태에서 적용됩니다. 기본 단서를 꺼도 같은 효과음을
        사용하는 사용자 규칙은 따로 적용됩니다.
      </p>
      <p>
        설정을 바꿔도 이미 만든 음향 포함 파일은 바뀌지 않습니다. 기존 파일에
        반영하려면 음향 설정을 다시 적용해 주세요.
      </p>
      <details className="sound-rules-info">
        <summary>매칭과 저장 방식 자세히 보기</summary>
        <p>
          기본 규칙은 정해진 표현을 찾고 사용자 규칙은 입력한 문구가 포함된 곳을
          찾습니다. 영문 대소문자는 구분하지 않으며 단어 일부에도 일치할 수
          있습니다. 같은 효과음의 겹치거나 가까운 단서는 합쳐지거나 생략될 수
          있습니다.
        </p>
        <p>
          문맥이나 의미를 완전히 이해하지 못하며 부정 표현도 모두 판별하지
          못합니다. 재생 시점은 추정이므로 결과를 직접 들어 확인해 주세요.
        </p>
        <p>
          설정은 이 브라우저에만 보관되며 기기나 브라우저 간 자동 동기화되지
          않습니다. 다른 탭에서 변경해도 현재 화면에 자동 반영되지 않고,
          새로고침하면 마지막으로 저장된 설정을 불러옵니다. 브라우저 데이터를
          지우면 설정도 사라질 수 있습니다. 다른 탭에서 먼저 저장했다면 이 탭의
          변경은 자동 저장되지 않으므로 내용을 기록한 뒤 새로고침해 주세요. 거의
          동시에 저장하면 충돌을 놓칠 수 있으니 한 탭에서만 수정해 주세요.
        </p>
      </details>
      <p className="sound-rules-storage" role="status" aria-atomic="true">
        {storageError}
      </p>
      <p className="sound-rules-status" role="status" aria-atomic="true">
        {notice}
      </p>
      {disabled && (
        <p className="sound-rules-hint">
          작업이 끝나면 규칙을 변경할 수 있습니다.
        </p>
      )}
      <fieldset className="sound-rules-controls" disabled={disabled}>
        <legend>효과음 규칙 설정</legend>
        <fieldset
          className="sound-rules-builtins"
          aria-describedby={`${id}-builtin-help`}
        >
          <legend>기본 단서</legend>
          <p id={`${id}-builtin-help`}>
            체크한 기본 단서만 사용합니다. 사용자 규칙의 켜짐 여부는 바뀌지
            않습니다.
          </p>
          <div className="sound-rules-grid">
            {EFFECTS.map(item => {
              const checked = !value.disabledBuiltins.includes(item.name);
              return (
                <label className="sound-rules-check" key={item.name}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={event => {
                      const next = event.currentTarget.checked
                        ? value.disabledBuiltins.filter(
                            name => name !== item.name
                          )
                        : [...value.disabledBuiltins, item.name];
                      publish(
                        { ...value, disabledBuiltins: next },
                        `${item.label} 기본 단서를 ${event.currentTarget.checked ? "켰습니다" : "껐습니다"}. 사용자 규칙은 변경되지 않았습니다.`
                      );
                    }}
                  />
                  <span>{item.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="sound-rules-custom-heading">
          <h4>사용자 규칙</h4>
          <span>
            {value.customRules.length}/{MAX_RULES}개
          </span>
        </div>
        <p className="sound-rules-hint">
          문구는 앞뒤 공백을 제외해 1~80자이며 최대 50개까지 추가할 수 있습니다.
          활성화된 사용자 규칙은 기본 단서와 별도로 적용됩니다.
        </p>
        {value.customRules.length === 0 ? (
          <p className="sound-rules-empty">
            아직 추가한 사용자 규칙이 없습니다.
          </p>
        ) : (
          <ol className="sound-rules-list">
            {value.customRules.map((rule, index) => (
              <li key={rule.id} className="sound-rules-item">
                <div className="sound-rules-item-text">
                  <strong>
                    {index + 1}. {rule.phrase}
                  </strong>
                  <span>
                    효과음:{" "}
                    {EFFECTS.find(item => item.name === rule.effect)?.label ??
                      rule.effect}
                  </span>
                </div>
                <label className="sound-rules-check sound-rules-enabled">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    aria-label={`${index + 1}번 규칙 ${rule.phrase} 활성화`}
                    onChange={event => {
                      const enabled = event.currentTarget.checked;
                      publish(
                        {
                          ...value,
                          customRules: value.customRules.map(item =>
                            item.id === rule.id ? { ...item, enabled } : item
                          ),
                        },
                        `${index + 1}번 사용자 규칙을 ${enabled ? "켰습니다" : "껐습니다"}.`
                      );
                    }}
                  />{" "}
                  <span>{rule.enabled ? "켜짐" : "꺼짐"}</span>
                </label>
                <div className="sound-rules-actions">
                  <button
                    type="button"
                    ref={node => {
                      if (node) editButtonsRef.current.set(rule.id, node);
                      else editButtonsRef.current.delete(rule.id);
                    }}
                    aria-label={`${index + 1}번 규칙 ${rule.phrase} 수정`}
                    onClick={() => startEdit(rule, index)}
                  >
                    수정
                  </button>
                  <button
                    type="button"
                    className="sound-rules-delete"
                    aria-label={`${index + 1}번 규칙 ${rule.phrase} 삭제`}
                    onClick={() => removeRule(rule, index)}
                  >
                    삭제
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <div
          className="sound-rules-editor"
          role="group"
          aria-labelledby={`${id}-editor-heading`}
        >
          <h4 id={`${id}-editor-heading`}>
            {editing ? "사용자 규칙 수정" : "사용자 규칙 추가"}
          </h4>
          <label htmlFor={`${id}-phrase`}>찾을 문구</label>
          <input
            ref={phraseRef}
            id={`${id}-phrase`}
            type="text"
            value={phrase}
            autoComplete="off"
            aria-invalid={
              (!!error &&
                (characterCount(normalizePhrase(phrase)) < 1 ||
                  characterCount(normalizePhrase(phrase)) > 80)) ||
              undefined
            }
            aria-describedby={`${id}-phrase-help${error ? ` ${id}-error` : ""}`}
            onChange={event => {
              setPhrase(event.currentTarget.value);
              if (error) setError("");
            }}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                applyDraft();
              }
            }}
          />
          <p id={`${id}-phrase-help`} className="sound-rules-hint">
            앞뒤 공백을 제외한 {characterCount(normalizePhrase(phrase))}/80자 ·
            입력 후 추가 또는 수정해 주세요.
          </p>
          <label htmlFor={`${id}-effect`}>효과음</label>
          <select
            id={`${id}-effect`}
            value={effect}
            aria-invalid={(!!error && !isEffect(effect)) || undefined}
            onChange={event => {
              setEffect(event.currentTarget.value as EffectName);
              if (error) setError("");
            }}
          >
            {EFFECTS.map(item => (
              <option key={item.name} value={item.name}>
                {item.label}
              </option>
            ))}
          </select>
          {error && (
            <p id={`${id}-error`} className="sound-rules-error">
              {error}
            </p>
          )}
          <div className="sound-rules-actions">
            <button
              type="button"
              className="sound-rules-primary"
              onClick={applyDraft}
            >
              {editing ? "수정 적용" : "규칙 추가"}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  if (!confirmDiscard()) return;
                  focusRef.current = { ruleId: editing.id };
                  resetDraft();
                  setNotice("규칙 수정을 취소했습니다.");
                }}
              >
                수정 취소
              </button>
            )}
          </div>
        </div>
      </fieldset>
    </section>
  );
}
