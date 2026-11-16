#!/usr/bin/env python3
import sys
sys.dont_write_bytecode = True
import argparse
import json
import re
import shlex
import subprocess
import time
import xml.etree.ElementTree as ET
from common import Report, output_dir, safe_url, write_private


def command(args, timeout=35, binary=False):
    p = subprocess.run(args, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(p.stderr.decode('utf-8', 'replace').strip()[:400] or '명령 실행 실패')
    return p.stdout if binary else p.stdout.decode('utf-8', 'replace')


def adb(serial, *args, binary=False):
    return command(['adb', '-s', serial, *args], binary=binary)


def hierarchy(serial):
    raw = adb(serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty')
    start = raw.find('<hierarchy')
    end = raw.find('</hierarchy>', start)
    if start < 0 or end < 0:
        raise RuntimeError('기기에서 XML 계층을 받지 못했습니다. 잠금 해제, Chrome 전경 및 uiautomator 지원을 확인하세요.')
    xml = raw[start:end + len('</hierarchy>')]
    return xml, ET.fromstring(xml)


def is_address_ready(root):
    return any(n.get('package') == 'com.android.chrome' and n.get('focused') == 'true'
               and ('url_bar' in n.get('resource-id', '') or 'location_bar' in n.get('resource-id', ''))
               and ('EditText' in n.get('class', '') or n.get('editable') == 'true')
               for n in root.iter('node'))


def inspect_webview(root):
    views = [n for n in root.iter('node') if n.get('package') == 'com.android.chrome' and 'WebView' in n.get('class', '')]
    if not views:
        return [], 'Chrome WebView가 계층에 나타나지 않습니다. 일부 기기에서는 노드가 생략됩니다.'
    nodes = [n for view in views for n in view.iter('node')]
    def subtree_text(n):
        return ' '.join((x.get('text', '') + ' ' + x.get('content-desc', '')).strip() for x in n.iter('node')).strip()
    # 역할(class)과 이름(text/content-desc 또는 자식 텍스트)이 같은 제어 트리에 있어야 한다.
    controls = []
    for n in nodes:
        cls = n.get('class', '')
        name = subtree_text(n)
        if name and any(kind in cls for kind in ('Button', 'EditText', 'CheckBox', 'Switch', 'Spinner', 'SeekBar')):
            controls.append({'class': cls, 'name': re.sub(r'\s+', ' ', name)[:180], 'focused': n.get('focused', '')})
    return controls, ''


def main():
    p = argparse.ArgumentParser(description='연결된 Android Chrome과 TalkBack 보조 점검')
    p.add_argument('--serial', required=True, help='adb devices에 나온 기기 일련번호')
    p.add_argument('--url', required=True, help='테스트 URL; 영문·숫자와 : / . _ ~ - 만 허용')
    p.add_argument('--out-dir', help='프로젝트 밖의 기존 결과 상위 폴더')
    p.add_argument('--incognito-address-ready', action='store_true', help='전용 Chrome 시크릿 탭 주소창이 포커스/선택된 상태임을 확인')
    p.add_argument('--screenshot', action='store_true', help='민감한 전체 화면 PNG도 저장')
    p.add_argument('--wait', type=float, default=7, help='페이지 로딩 대기 초, 1~60')
    a = p.parse_args()
    try:
        safe_url(a.url, android=True)
        if not re.fullmatch(r'[A-Za-z0-9_.:-]+', a.serial): raise ValueError('유효하지 않은 adb 일련번호입니다.')
        if not 1 <= a.wait <= 60: raise ValueError('--wait는 1~60초여야 합니다.')
        if not a.incognito_address_ready: raise ValueError('전용 시크릿 탭 주소창을 준비하고 --incognito-address-ready를 지정하세요.')
        directory = output_dir(a.out_dir)
    except ValueError as e:
        print(f'입력 오류: {e}', file=sys.stderr); return 2
    report = Report(directory, 'Android Chrome + TalkBack')
    code = 2
    try:
        if adb(a.serial, 'get-state').strip() != 'device': raise RuntimeError('기기가 device 상태가 아닙니다. USB 디버깅을 승인하세요.')
        enabled = adb(a.serial, 'shell', 'settings', 'get', 'secure', 'accessibility_enabled').strip()
        services = adb(a.serial, 'shell', 'settings', 'get', 'secure', 'enabled_accessibility_services').strip()
        if enabled != '1' or 'talkback' not in services.lower():
            raise RuntimeError('활성 접근성 서비스 목록에서 TalkBack을 찾지 못했습니다. 기기에서 켜고 확인하세요. 다른 서비스 이름은 자동 판별하지 못합니다.')
        report.add('TalkBack 사전 상태', 'PASS', '활성 서비스 이름에서 talkback 확인. 실제 발화 여부는 수동 확인 필요.')
        _, before = hierarchy(a.serial)
        if not is_address_ready(before):
            raise RuntimeError('포커스된 Chrome 주소창을 찾지 못했습니다. 기기를 잠금 해제하고 전용 시크릿 탭의 주소를 선택하세요.')
        report.add('전용 주소창 준비', 'PASS', 'Chrome 주소창 포커스 확인. 시크릿 여부는 사용자 확인에 의존합니다.')
        # URL is shell-quoted and conservatively restricted for Android input's key mapping.
        adb(a.serial, 'shell', 'input text ' + shlex.quote(a.url))
        adb(a.serial, 'shell', 'input', 'keyevent', 'KEYCODE_ENTER')
        time.sleep(a.wait)
        all_controls = []
        focus_trace = []
        for i in range(4):
            if i:
                adb(a.serial, 'shell', 'input', 'keyevent', 'KEYCODE_TAB')
                time.sleep(0.5)
            xml, root = hierarchy(a.serial)
            write_private(directory / f'hierarchy-{i}.xml', xml + '\n')
            controls, error = inspect_webview(root)
            if error:
                report.add(f'화면 {i} 웹 계층', 'FAIL' if i == 0 else 'MANUAL', error)
            else:
                report.add(f'화면 {i} 웹 계층', 'PASS', f'Chrome WebView의 명명된 제어 {len(controls)}개. 노출 범위는 기기마다 다릅니다.')
            all_controls.extend(controls)
            focus_trace.append({'step': i, 'focused': [c for c in controls if c['focused'] == 'true']})
            if a.screenshot:
                png = adb(a.serial, 'exec-out', 'screencap', '-p', binary=True)
                if not png.startswith(b'\x89PNG\r\n\x1a\n'): raise RuntimeError('스크린샷 PNG 캡처 실패')
                write_private(directory / f'screen-{i}.png', png)
        write_private(directory / 'web-controls.json', json.dumps(all_controls, ensure_ascii=False, indent=2) + '\n')
        write_private(directory / 'keyboard-focus.json', json.dumps(focus_trace, ensure_ascii=False, indent=2) + '\n')
        expected = [('예시 원고 버튼', 'Button', '예시 원고'), ('파일 불러오기 버튼', 'Button', '파일 불러오기'),
                    ('오디오 만들기 버튼', 'Button', '오디오 만들기'), ('원고 입력', 'EditText', '원고'),
                    ('파일 선택', 'Button', '오디오 파일'), ('형식 선택', 'Spinner', '결과 형식')]
        found = 0
        for title, role, name in expected:
            hits = [c for c in all_controls if role in c['class'] and name in c['name']]
            found += bool(hits)
            report.add('웹 계층: ' + title, 'PASS' if hits else 'MANUAL',
                       f'역할 {role}, 이름 {name} 확인' if hits else '현재 계층에서 역할과 이름을 함께 확인하지 못함: 화면 밖이거나 노출 방식이 다를 수 있음.')
        report.add('앱 제어 역할과 이름', 'PASS' if found else 'FAIL', f'확인된 기대 제어 종류 {found}개. 모두 없으면 XML 제한·미로딩 여부를 확인하세요.')
        focused = {(c['class'], c['name']) for step in focus_trace for c in step['focused']}
        report.add('Tab 키 수집', 'PASS' if len(focused) >= 2 else 'MANUAL', 'Tab 전후 계층에서 구분되는 focused 제어 ' + str(len(focused)) + '개. TalkBack 포커스와 동일하지 않습니다.')
        report.add('TalkBack 스와이프·발화·상태', 'MANUAL', '한 손가락 스와이프, 두 번 탭과 동적 상태를 실기기에서 확인하세요.')
        report.add('동적 생성·파일 업로드', 'SKIPPED', '안전을 위해 자동 실행하지 않았습니다.')
        code = report.code()
    except (RuntimeError, OSError, subprocess.SubprocessError, ET.ParseError) as e:
        report.add('실행 전제 또는 처리 오류', 'FAIL', str(e))
        report.add('미실행 스크린리더 확인', 'SKIPPED', '전제를 충족하고 다시 실행하세요.')
    except KeyboardInterrupt:
        report.add('사용자 중단', 'SKIPPED', '완료되지 않은 항목은 수동 확인 전입니다.')
        code = 130
    finally:
        report.add('시크릿 탭 정리', 'MANUAL', '기존 다른 탭을 건드리지 않도록 자동 종료하지 않습니다. 테스트 탭을 직접 닫으세요.')
        report.save()
    return code


if __name__ == '__main__':
    sys.exit(main())
