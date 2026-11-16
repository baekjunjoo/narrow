#!/usr/bin/env python3
"""Browser-only privacy regression using synthetic text and intercepted network.

Requires Python Playwright and Chromium. No request is sent to external hosts:
Google Fonts endpoints are intercepted with a deterministic unicode-range fixture.
The CSS under test is the real source CSS, with only Tailwind's build-time import
removed because this test does not invoke Vite.
"""
from pathlib import Path
import os
import shutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT/'client/src/index.css').read_text(encoding='utf-8').replace('@import "tailwindcss";', '')
FONT = (ROOT/'client/public/fonts/NarravoReportKR-Regular.ttf').read_bytes()
HTML = '''<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/source.css"></head>
<body><main class="workspace"><section class="manuscript-panel panel"><label for="editor">Editor</label>
<div class="editor-wrap"><textarea id="editor"></textarea></div><span id="visible"></span></section></main></body></html>'''
MOCK_FONT_CSS = '''@font-face { font-family: "Noto Sans KR"; font-style: normal; font-weight: 100 900;
  src: url("https://fonts.gstatic.com/fixture-ac00.ttf") format("truetype"); unicode-range: U+AC00; }
@font-face { font-family: "Noto Sans KR"; font-style: normal; font-weight: 100 900;
  src: url("https://fonts.gstatic.com/fixture-d7a3.ttf") format("truetype"); unicode-range: U+D7A3; }'''


def main():
    events = []
    with sync_playwright() as p:
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
        launch_options = {'headless': True, 'args': ['--no-sandbox']}
        if executable:
            launch_options['executable_path'] = executable
        browser = p.chromium.launch(**launch_options)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        def route_handler(route):
            url = route.request.url
            if url == 'http://narravo.test/':
                route.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML)
            elif url == 'http://narravo.test/source.css':
                route.fulfill(status=200, content_type='text/css; charset=utf-8', body=CSS)
            elif url.startswith('https://fonts.googleapis.com/'):
                events.append(url)
                route.fulfill(status=200, content_type='text/css; charset=utf-8', body=MOCK_FONT_CSS)
            elif url.startswith('https://fonts.gstatic.com/'):
                events.append(url)
                route.fulfill(status=200, content_type='font/ttf', body=FONT)
            else:
                events.append('BLOCKED ' + url)
                route.abort()
        page.route('**/*', route_handler)
        page.goto('http://narravo.test/', wait_until='load')
        stages = {'initial': events.copy()}
        for character in ('가', '힣'):
            page.locator('#editor').fill(character)
            page.locator('#visible').evaluate('(el, text) => el.textContent = text', character)
            page.evaluate('document.fonts.ready')
            page.wait_for_timeout(200)
            stages[character] = events.copy()
        root_font = page.evaluate('getComputedStyle(document.documentElement).fontFamily')
        bounds = page.locator('#editor').bounding_box()
        assert bounds and bounds['width'] > 0 and bounds['height'] > 0
        print('Captured requests by stage (all intercepted, synthetic text):', stages)
        print('Computed root font:', root_font)
        print('Chromium editor dimensions:', bounds['width'], 'x', bounds['height'])
        browser.close()
    assert not events, f'external font request(s): {events}'
    assert 'system-ui' in root_font and 'Noto Sans KR' in root_font, 'expected local system/Noto fallback'
    print('PASS: no external request from source CSS for ASCII, 가 or 힣')


if __name__ == '__main__':
    main()
