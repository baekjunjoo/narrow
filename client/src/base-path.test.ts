import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router as WouterRouter, useLocation } from 'wouter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const captured = vi.hoisted(() => ({ goHome: undefined as (() => void) | undefined }));

vi.mock('./pages/Home', () => ({ default: () => React.createElement('div', null, 'home route') }));
vi.mock('@/pages/NotFound', () => ({
  default: () => {
    const [, navigate] = useLocation();
    captured.goHome = () => navigate('/');
    return React.createElement('div', null, 'not found route');
  },
}));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); captured.goHome = undefined; });

describe('application router base', () => {
  it.each([
    ['/', '/', '/missing', '/404', '/'],
    ['/narrow/', '/narrow/', '/narrow/missing', '/narrow/404', '/narrow/'],
  ])('routes and navigates inside %s', (base, home, missing, explicit404, expectedHome) => {
    vi.stubEnv('BASE_URL', base);
    vi.stubGlobal('React', React);
    const navigate = vi.fn();
    let path = home;
    const hook = () => [path, navigate] as [string, typeof navigate];
    const render = () => renderToStaticMarkup(React.createElement(WouterRouter, { hook, children: React.createElement(App) }));

    expect(render()).toContain('home route');
    path = missing;
    expect(render()).toContain('not found route');
    captured.goHome?.();
    expect(navigate).toHaveBeenCalledWith(expectedHome, undefined);
    path = explicit404;
    expect(render()).toContain('not found route');
  });
});
