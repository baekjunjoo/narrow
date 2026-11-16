#!/usr/bin/env python3
"""공통 결과 처리. 외부 패키지 없이 Python 표준 라이브러리만 사용."""
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit

PROJECT = Path(__file__).resolve().parents[2]


def safe_url(url, android=False):
    import re
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        raise ValueError('URL은 사용자 정보가 없는 http:// 또는 https:// 주소여야 합니다.')
    if any(ord(c) < 33 or ord(c) > 126 for c in url):
        raise ValueError('URL은 공백 없는 ASCII 주소여야 합니다.')
    # Android input text는 키 매핑/쉘 특수문자에 따라 손실될 수 있어 보수적으로 제한한다.
    if android and not re.fullmatch(r'[A-Za-z0-9:/._~-]+', url):
        raise ValueError('Android 자동 입력 URL에는 영문/숫자와 : / . _ ~ - 만 사용하세요. 쿼리·조각·% 인코딩은 미지원입니다.')
    return url


def output_dir(parent=None):
    root = Path(parent or tempfile.gettempdir()).expanduser().resolve()
    if root == PROJECT or PROJECT in root.parents:
        raise ValueError('결과 폴더는 프로젝트 밖이어야 합니다.')
    if not root.is_dir():
        raise ValueError('결과 상위 폴더가 존재해야 합니다.')
    # 매 실행 전용 디렉터리를 만들고 사용자 이외의 접근을 제한한다.
    return Path(tempfile.mkdtemp(prefix='narravo-a11y-', dir=str(root)))


def write_private(path, data):
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('utf-8'))


class Report:
    def __init__(self, directory, platform):
        self.directory = directory
        self.data = {'platform': platform, 'checks': [], 'note': '자동 결과는 실기기 스크린리더 사용자 검증이 아닙니다.'}

    def add(self, name, status, detail):
        assert status in ('PASS', 'FAIL', 'MANUAL', 'SKIPPED')
        self.data['checks'].append({'check': name, 'status': status, 'detail': detail})
        print(f'[{status}] {name}: {detail}', flush=True)

    def save(self):
        write_private(self.directory / 'report.json', json.dumps(self.data, ensure_ascii=False, indent=2) + '\n')
        text = '\n'.join(f"[{x['status']}] {x['check']}: {x['detail']}" for x in self.data['checks']) + '\n'
        write_private(self.directory / 'report.txt', text)
        print(f'결과 폴더: {self.directory}', flush=True)

    def code(self):
        return 1 if any(x['status'] == 'FAIL' for x in self.data['checks']) else 0
