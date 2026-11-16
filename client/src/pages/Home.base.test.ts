import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home from './Home';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (value: unknown) => [typeof value === 'function' ? value() : value, vi.fn()],
    useRef: (value: unknown) => ({ current: value }),
    useMemo: (factory: () => unknown) => factory(),
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
});

type Element = { type?: unknown; props?: { children?: unknown; [key: string]: unknown } };
function findElement(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  } else if (node && typeof node === 'object') {
    const element = node as Element;
    if (predicate(element)) return element;
    return findElement(element.props?.children, predicate);
  }
  return undefined;
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('home asset paths', () => {
  it.each(['/', '/narrow/'])('uses %s for links and voice previews', (base) => {
    vi.stubEnv('BASE_URL', base);
    vi.stubGlobal('React', React);
    const play = vi.fn(async () => {});
    const audio = vi.fn(function (this: unknown) { return { play, paused: false }; });
    vi.stubGlobal('Audio', audio);
    const tree = Home();
    const brand = findElement(tree, e => e.type === 'a' && e.props?.className === 'brand');
    const license = findElement(tree, e => e.type === 'a' && e.props?.children === '오픈소스 및 이용 조건');
    const preview = findElement(tree, e => e.type === 'button' && e.props?.title === '목소리 미리듣기');
    expect(brand?.props?.href).toBe(base);
    expect(license?.props?.href).toBe(`${base}licenses/index.html`);
    expect(preview).toBeDefined();
    (preview!.props!.onClick as () => void)();
    expect(audio).toHaveBeenCalledWith(`${base}voice-previews/ko/F1.mp3`);
    expect(play).toHaveBeenCalledOnce();
  });
});
