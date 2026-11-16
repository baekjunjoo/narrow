import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../components/ui/button';
import NotFound from './NotFound';

const state = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, navigate: vi.fn() }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { state.effects.push(effect); },
}));
vi.mock('wouter', () => ({ useLocation: () => ['/missing', state.navigate] }));

type Element = { type?: unknown; props?: { children?: unknown; [key: string]: unknown } };
function findElement(node: unknown, type: unknown): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
  } else if (node && typeof node === 'object') {
    const element = node as Element;
    if (element.type === type) return element;
    return findElement(element.props?.children, type);
  }
  return undefined;
}

beforeEach(() => { state.effects = []; state.navigate.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe('not found page', () => {
  it.each(['/missing', '/404', '/narrow/missing', '/narrow/404'])('does not redirect from %s and keeps home navigation', (pathname) => {
    vi.stubGlobal('React', React);
    const replace = vi.fn();
    const remove = vi.fn();
    const meta = { name: '', content: '', remove };
    const appendChild = vi.fn();
    vi.stubGlobal('window', { location: { pathname, replace } });
    vi.stubGlobal('document', { createElement: vi.fn(() => meta), head: { appendChild } });
    const tree = NotFound();
    const cleanup = state.effects[0]();
    expect(replace).not.toHaveBeenCalled();
    expect(meta).toMatchObject({ name: 'robots', content: 'noindex' });
    expect(appendChild).toHaveBeenCalledWith(meta);
    (findElement(tree, Button)!.props!.onClick as () => void)();
    expect(state.navigate).toHaveBeenCalledWith('/');
    if (cleanup) cleanup();
    expect(remove).toHaveBeenCalledOnce();
  });
});
