#!/usr/bin/env python3
import sys
sys.dont_write_bytecode = True
import argparse
import json
import platform
import signal
import subprocess
import time
from pathlib import Path
from common import Report, output_dir, safe_url, write_private

HERE = Path(__file__).resolve().parent


def osa(script, *args, language=None):
    cmd = ['osascript'] + (['-l', language] if language else []) + ['-', *args]
    p = subprocess.run(cmd, input=script, text=True, capture_output=True, timeout=30)
    if p.returncode:
        raise RuntimeError((p.stderr.strip() or 'osascript 실행 실패')[:500])
    return p.stdout.strip()


def safari(window, js):
    return osa('''on run argv
    tell application "Safari" to return do JavaScript (item 2 of argv) in current tab of window id (item 1 of argv as integer)
end run''', str(window), js)


def inspect(window):
    return json.loads(safari(window, (HERE / 'safari_inspect.js').read_text(encoding='utf-8')))


def key(window, code):
    osa('''on run argv
    tell application "Safari" to set index of window id (item 1 of argv as integer) to 1
    tell application "System Events"
        tell process "Safari" to set frontmost to true
        key code (item 2 of argv as integer)
    end tell
end run''', str(window), str(code))


def main():
    p = argparse.ArgumentParser(description='전용 Safari 비공개 창에서 VoiceOver 보조 점검')
    p.add_argument('--url', required=True, help='검사할 안전한 테스트 URL')
    p.add_argument('--out-dir', help='프로젝트 밖의 기존 결과 상위 폴더')
    p.add_argument('--private-window-ready', action='store_true', help='비어 있는 전용 비공개 Safari 창을 준비했고 종료 시 닫는 데 동의')
    p.add_argument('--wait', type=float, default=6, help='페이지 로딩 대기 초, 1~60')
    a = p.parse_args()
    try:
        safe_url(a.url)
        if not 1 <= a.wait <= 60: raise ValueError('--wait는 1~60초여야 합니다.')
        if not a.private_window_ready: raise ValueError('전용 비공개 창을 준비하고 --private-window-ready를 지정하세요.')
        directory = output_dir(a.out_dir)
    except ValueError as e:
        print(f'입력 오류: {e}', file=sys.stderr); return 2
    report = Report(directory, 'macOS Safari + VoiceOver')
    window, previous, exit_code = None, None, 2
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    old_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        if platform.system() != 'Darwin': raise RuntimeError('macOS에서만 실행할 수 있습니다.')
        vo = osa("ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.voiceOverEnabled ? 'true' : 'false'", language='JavaScript')
        if vo != 'true': raise RuntimeError('VoiceOver가 꺼져 있거나 상태를 확인할 수 없습니다. 먼저 사용자가 켜 주세요.')
        report.add('VoiceOver 사전 상태', 'PASS', 'NSWorkspace에서 실행 중으로 확인. 실제 발화는 별도 확인 필요.')
        previous = osa('tell application "System Events" to get name of first application process whose frontmost is true')
        # Only a single, empty, user-designated private window may be taken over.
        info = osa('''tell application "Safari"
    if (count of windows) is 0 then error "Safari 창이 없습니다"
    set w to front window
    if (count of tabs of w) is not 1 then error "전용 창에는 탭이 하나만 있어야 합니다"
    set u to URL of current tab of w
    if u is not "" and u is not "about:blank" then error "전용 탭이 비어 있지 않습니다"
    return id of w as text
end tell''')
        window = int(info)
        report.add('전용 빈 창', 'PASS', '탭이 하나이고 주소가 비어 있음. 비공개 여부는 사용자 확인에 의존합니다.')
        osa('''on run argv
    tell application "Safari"
        set URL of current tab of window id (item 1 of argv as integer) to item 2 of argv
        activate
    end tell
end run''', str(window), a.url)
        time.sleep(a.wait)
        initial = inspect(window)
        write_private(directory / 'dom-initial.json', json.dumps(initial, ensure_ascii=False, indent=2) + '\n')
        for c in initial['checks']:
            report.add('DOM: ' + c['id'], c['status'], '역할=' + c['role'] + ', 이름=' + c['name'] + ', 표시=' + str(c['visible']))
        # Focus the known, non-destructive in-page navigation link; Return is then a real keyboard event.
        focused = safari(window, "(() => {const e=document.querySelector('a[href=\"#batch-converter\"]'); if(!e) return 'missing'; e.focus(); return document.activeElement===e ? 'focused' : 'not-focused';})()")
        if focused == 'focused':
            key(window, 36)
            time.sleep(0.5)
            nav = inspect(window)
            write_private(directory / 'dom-after-enter.json', json.dumps(nav, ensure_ascii=False, indent=2) + '\n')
            report.add('변환 영역 키보드 이동', 'PASS' if nav['hash'] == '#batch-converter' else 'FAIL', '링크에 포커스를 둔 뒤 Return; hash=' + nav['hash'])
        else:
            report.add('변환 영역 키보드 이동', 'SKIPPED', '이동 링크에 포커스할 수 없음')
        trace = []
        for i in range(3):
            key(window, 48)
            time.sleep(0.4)
            state = inspect(window)
            trace.append({'step': i + 1, 'focused': state['focused']})
        write_private(directory / 'keyboard-focus.json', json.dumps(trace, ensure_ascii=False, indent=2) + '\n')
        useful = [x['focused'] for x in trace if x['focused']['tag'] not in ('', 'BODY', 'HTML')]
        distinct = {(x['tag'], x['role'], x['name']) for x in useful}
        report.add('Tab 키 수집', 'PASS' if len(distinct) >= 2 else 'FAIL', 'Tab 3회 후 구분되는 DOM 포커스 ' + str(len(distinct)) + '개; VoiceOver 커서나 발화 검증은 아님.')
        report.add('VoiceOver 실제 발화·커서·상태', 'MANUAL', '링크, 입력, 버튼, 상태 및 VO 탐색과 결과 음원을 직접 확인하세요.')
        report.add('동적 생성·파일 업로드', 'SKIPPED', '안전을 위해 자동 실행하지 않았습니다.')
        exit_code = report.code()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as e:
        report.add('실행 전제 또는 처리 오류', 'FAIL', str(e))
        report.add('미실행 스크린리더 확인', 'SKIPPED', '전제를 충족하고 다시 실행하세요.')
    except KeyboardInterrupt:
        report.add('사용자 중단', 'SKIPPED', '완료되지 않은 항목은 수동 확인 전입니다.')
        exit_code = 130
    finally:
        if window is not None:
            try:
                osa('''on run argv
    tell application "Safari"
        set w to window id (item 1 of argv as integer)
        if (count of tabs of w) is 1 then
            close w
        else
            error "창의 탭이 추가되어 자동으로 닫지 않았습니다"
        end if
    end tell
end run''', str(window))
                report.add('전용 창 정리', 'PASS', '테스트 전용 창을 닫았습니다.')
            except Exception as e:
                report.add('전용 창 정리', 'MANUAL', '직접 비공개 창을 닫으세요: ' + str(e)[:250])
            if previous and previous != 'Safari':
                try:
                    osa('''on run argv
    tell application "System Events" to set frontmost of process (item 1 of argv) to true
end run''', previous)
                except Exception:
                    report.add('이전 앱 복귀', 'MANUAL', '필요하면 이전 앱으로 돌아가세요.')
        report.save()
        signal.signal(signal.SIGTERM, old_term)
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
