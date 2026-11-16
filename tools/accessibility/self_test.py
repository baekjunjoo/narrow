#!/usr/bin/env python3
"""실기기 없이 안전 경계와 결과 분류만 점검. macOS/Android 실증을 대체하지 않는다."""
import sys
sys.dont_write_bytecode = True
import contextlib
import html
import io
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import common
import talkback_chrome as android
import voiceover_safari as mac

ADDRESS = '<hierarchy><node package="com.android.chrome" class="android.widget.EditText" resource-id="com.android.chrome:id/url_bar" focused="true"/></hierarchy>'
PAGE = '<hierarchy><node package="com.android.chrome" class="android.webkit.WebView"><node package="com.android.chrome" class="android.widget.Button" text="예시 원고 넣기" focused="true"/></node></hierarchy>'


class Tests(unittest.TestCase):
    def test_url_and_output_boundaries(self):
        self.assertEqual(common.safe_url('http://192.168.1.2:5173/', True), 'http://192.168.1.2:5173/')
        for url in ['file:///etc/passwd', 'https://user:pass@example.com', 'https://host/x?a=1', 'https://host/a%20b', 'https://host/$(id)']:
            with self.assertRaises(ValueError): common.safe_url(url, True)
        with self.assertRaises(ValueError): common.output_dir(str(common.PROJECT / 'tools'))
        with tempfile.TemporaryDirectory() as td:
            d = common.output_dir(td)
            self.assertEqual(d.stat().st_mode & 0o777, 0o700)
            r = common.Report(d, 'mock')
            r.add('자동', 'PASS', 'ok'); r.add('발화', 'MANUAL', 'pending'); r.add('업로드', 'SKIPPED', 'none')
            r.save()
            self.assertEqual(r.code(), 0)
            self.assertEqual(json.loads((d / 'report.json').read_text())['checks'][1]['status'], 'MANUAL')
            self.assertEqual((d / 'report.json').stat().st_mode & 0o777, 0o600)

    def test_android_hierarchy_semantics(self):
        import xml.etree.ElementTree as ET
        c, error = android.inspect_webview(ET.fromstring(PAGE))
        self.assertFalse(error); self.assertEqual(c[0]['class'], 'android.widget.Button')
        self.assertIn('예시 원고', c[0]['name'])
        self.assertTrue(android.is_address_ready(ET.fromstring(ADDRESS)))
        self.assertFalse(android.is_address_ready(ET.fromstring(PAGE)))
        self.assertTrue(android.inspect_webview(ET.fromstring(ADDRESS))[1])

    def test_android_file_import_control_name_and_role(self):
        for control, expected in [
            ('<node class="android.widget.Button" text="파일 불러오기"/>', 'PASS'),
            ('<node class="android.widget.Button" text="TXT 불러오기"/>', 'MANUAL'),
            ('<node class="android.widget.TextView" text="파일 불러오기"/>', 'MANUAL'),
        ]:
            page = '<hierarchy><node package="com.android.chrome" class="android.webkit.WebView">' + control + '</node></hierarchy>'
            with tempfile.TemporaryDirectory() as td:
                _, _, report = self.run_android(td, page=page)
                checks = {check['check']: check['status'] for check in report['checks']}
                self.assertEqual(checks['웹 계층: 파일 불러오기 버튼'], expected)

    @unittest.skipUnless(shutil.which('chromium'), 'Chromium 없음: DOM 실브라우저 테스트 생략')
    def test_safari_inspect_logic_in_real_dom(self):
        script = (Path(__file__).parent / 'safari_inspect.js').read_text(encoding='utf-8')
        template = '''<!doctype html><html><body>
          <label for="book-title">제목</label><input id="book-title">
          LABEL_MANUSCRIPT<textarea id="manuscript"></textarea>
          <button>예시 원고 넣기</button>
          <a href="#batch-converter">여러 파일 형식 한꺼번에 변환하기</a>
          <section id="quality-panel"><label for="quality">기존 오디오 파일 선택</label><input type="file" id="quality"></section>
          <section id="batch-converter"><label for="batch-files">오디오 파일 선택</label><input type="file" id="batch-files">
          <label for="batch-format">결과 형식</label><select id="batch-format"><option>WAV</option></select></section>
          <pre id="result"></pre><script>document.getElementById('result').textContent=SCRIPT;</script></body></html>'''
        for present in (True, False):
            with tempfile.TemporaryDirectory() as td:
                source = template.replace('LABEL_MANUSCRIPT', '<label for="manuscript">원고</label>' if present else '').replace('SCRIPT', script)
                path = Path(td) / 'fixture.html'; path.write_text(source, encoding='utf-8')
                run = subprocess.run([shutil.which('chromium'), '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--user-data-dir=' + td + '/profile', '--dump-dom', path.as_uri()], capture_output=True, text=True, timeout=30)
                self.assertEqual(run.returncode, 0, run.stderr[-500:])
                match = re.search(r'<pre id="result">(.*?)</pre>', run.stdout, re.S)
                self.assertIsNotNone(match)
                result = json.loads(html.unescape(match.group(1)))
                statuses = {c['id']: c['status'] for c in result['checks']}
                self.assertEqual(statuses['원고'], 'PASS' if present else 'FAIL')
                self.assertEqual(statuses['변환 형식'], 'PASS')

    def run_android(self, td, address=ADDRESS, enabled='1', page=PAGE):
        calls = []
        def fake_adb(serial, *args, binary=False):
            calls.append(args)
            if args == ('get-state',): return 'device\n'
            if 'accessibility_enabled' in args: return enabled + '\n'
            if 'enabled_accessibility_services' in args: return 'com.google.android.marvin.talkback/.TalkBackService\n'
            if args[:2] == ('exec-out', 'uiautomator'):
                return address if sum(x[:2] == ('exec-out', 'uiautomator') for x in calls) == 1 else page
            return ''
        argv = ['talkback_chrome.py', '--serial', 'USB1', '--url', 'http://192.168.1.2:5173/', '--out-dir', td, '--incognito-address-ready', '--wait', '1']
        with patch.object(sys, 'argv', argv), patch.object(android, 'adb', fake_adb), patch.object(android.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
            code = android.main()
        d = next(Path(td).iterdir())
        return code, calls, json.loads((d / 'report.json').read_text())

    def test_android_end_to_end_and_preflight(self):
        with tempfile.TemporaryDirectory() as td:
            code, calls, report = self.run_android(td)
            self.assertEqual(code, 0)
            self.assertEqual(sum(x == ('shell', 'input', 'keyevent', 'KEYCODE_TAB') for x in calls), 3)
            self.assertTrue(any(x['check'] == '앱 제어 역할과 이름' and x['status'] == 'PASS' for x in report['checks']))
            self.assertTrue(any(x['status'] == 'MANUAL' for x in report['checks']))
        for address, enabled in [(PAGE, '1'), (ADDRESS, '0')]:
            with tempfile.TemporaryDirectory() as td:
                code, calls, report = self.run_android(td, address, enabled)
                self.assertEqual(code, 2)
                self.assertFalse(any(len(x) > 1 and x[0] == 'shell' and x[1].startswith('input') for x in calls))
                self.assertTrue(any(x['status'] == 'FAIL' for x in report['checks']))
        with tempfile.TemporaryDirectory() as td:
            code, _, report = self.run_android(td, page=PAGE.replace('android.widget.Button', 'android.widget.TextView'))
            self.assertEqual(code, 1)
            self.assertTrue(any(x['check'] == '앱 제어 역할과 이름' and x['status'] == 'FAIL' for x in report['checks']))

    def test_mac_mock_run_and_cleanup(self):
        with tempfile.TemporaryDirectory() as td:
            calls = []
            def fake_osa(script, *args, **kwargs):
                calls.append((script, args))
                if kwargs.get('language') == 'JavaScript': return 'true'
                if 'first application process' in script: return 'Terminal'
                if 'return id of w as text' in script: return '123'
                return ''
            states = [{'checks': [{'id': '원고', 'status': 'PASS', 'role': 'textbox', 'name': '원고', 'visible': True}], 'hash': '', 'focused': {}}]
            states.append({'checks': [], 'hash': '#batch-converter', 'focused': {}})
            for i in range(3): states.append({'checks': [], 'hash': '#batch-converter', 'focused': {'tag': 'BUTTON', 'role': 'button', 'name': str(i)}})
            argv = ['voiceover_safari.py', '--url', 'http://localhost:5173/', '--out-dir', td, '--private-window-ready', '--wait', '1']
            with patch.object(sys, 'argv', argv), patch.object(mac.platform, 'system', return_value='Darwin'), patch.object(mac, 'osa', fake_osa), patch.object(mac, 'safari', return_value='focused'), patch.object(mac, 'inspect', side_effect=states), patch.object(mac.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
                code = mac.main()
            self.assertEqual(code, 0)
            self.assertTrue(any('close w' in x[0] for x in calls))
            report = json.loads((next(Path(td).iterdir()) / 'report.json').read_text())
            self.assertTrue(any(x['check'] == 'Tab 키 수집' and x['status'] == 'PASS' for x in report['checks']))
            self.assertTrue(any(x['status'] == 'MANUAL' for x in report['checks']))

    def test_mac_error_closes_dedicated_window(self):
        with tempfile.TemporaryDirectory() as td:
            calls = []
            def fake_osa(script, *args, **kwargs):
                calls.append(script)
                if kwargs.get('language') == 'JavaScript': return 'true'
                if 'first application process' in script: return 'Terminal'
                if 'return id of w as text' in script: return '123'
                return ''
            argv = ['voiceover_safari.py', '--url', 'https://example.org/', '--out-dir', td, '--private-window-ready', '--wait', '1']
            with patch.object(sys, 'argv', argv), patch.object(mac.platform, 'system', return_value='Darwin'), patch.object(mac, 'osa', fake_osa), patch.object(mac, 'inspect', side_effect=RuntimeError('mock permission denied')), patch.object(mac.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(mac.main(), 2)
            self.assertTrue(any('close w' in script for script in calls))

    def test_mac_voiceover_off_does_not_navigate(self):
        with tempfile.TemporaryDirectory() as td:
            argv = ['voiceover_safari.py', '--url', 'https://example.org/', '--out-dir', td, '--private-window-ready', '--wait', '1']
            with patch.object(sys, 'argv', argv), patch.object(mac.platform, 'system', return_value='Darwin'), patch.object(mac, 'osa', return_value='false') as osa, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(mac.main(), 2)
                self.assertEqual(osa.call_count, 1)


if __name__ == '__main__': unittest.main(verbosity=2)
