# GitHub Pages 배포

제작실 주소는 `https://baekjunjoo.github.io/narrow/`입니다. `main`에는 소스 코드가 있고, `gh-pages`에는 공개 웹사이트용 정적 빌드 결과가 있습니다. 사이트에 입력한 원고와 개인 오디오 파일은 각 사용자의 브라우저에서 처리되며 저장소에 자동으로 올라가지 않습니다.

## 변경사항을 웹사이트에 반영하기

프로젝트의 `main` 변경을 커밋하고 원격 `main`에 올린 후 다음 명령을 실행합니다. Node.js와 pnpm, GitHub 저장소에 푸시할 권한이 필요합니다.

```sh
pnpm install --frozen-lockfile
bash scripts/deploy-github-pages.sh
```

스크립트는 커밋된 파일만 임시 공간에 복사해 `/narrow/` 경로용 정적 앱을 빌드하고 `gh-pages`에 정상 푸시합니다. Git에서 무시한 개인 파일은 포함하지 않고 기존 빌드 폴더도 건드리지 않습니다. 변경사항이 남아 있거나 원격 `main`과 일치하지 않으면 중단하며, `main`을 덮어쓰거나 강제 푸시하지 않습니다. GitHub Pages의 소스는 `gh-pages` 브랜치의 루트로 설정되어 있어야 합니다.

공개되는 `licenses/narravo-source.zip`은 매 배포 때 빌드 대상 커밋의 추적 파일로 임시 공간에서 새로 만듭니다. ZIP이 자기 자신을 무한히 포함하지 않도록 `client/public/licenses/narravo-source.zip` 한 파일만 제외합니다. 로컬 작업 트리의 ZIP이나 Git 인덱스는 수정하지 않습니다. `build-revision.txt`는 이 스냅샷에 사용한 커밋을 기록합니다. Git의 `export-ignore`/`export-subst` 등으로 추적 파일이 빠지거나 내용이 변하면 배포를 중단합니다. 빌드 결과에 이 ZIP이 그대로 들어 있는지도 확인합니다. Git 서브모듈 등 지원하지 않는 추적 파일 형식도 중단하므로 원인을 해결한 후 다시 실행해야 합니다. 이 재생성은 이 배포 스크립트에 적용되며, 별도의 일반 빌드가 자동으로 ZIP을 갱신한다는 뜻은 아닙니다.

**`main`에 소스만 올려서는 공개 사이트가 자동 갱신되지 않습니다.** 위 스크립트를 다시 실행한 다음 GitHub Pages 배포가 완료되어야 반영됩니다. 오디오 음성 모델은 최초 사용 시 외부에서 다운로드되며 브라우저 성능과 네트워크 상태에 영향을 받습니다.

## 담당 영역 회귀 검사

`python3 scripts/test_deploy_github_pages.py`는 임시 로컬 Git 원격과 가짜 빌드를 사용해 ZIP 및 배포 중단 조건을 검사합니다. 실제 원격에 푸시하지 않습니다. `python3 scripts/test_font_privacy.py`는 Python Playwright와 Chromium으로 합성 텍스트에 대한 글꼴 요청을 가로채 검사합니다. `python3 scripts/test_license_notices.py`는 설치된 React/ReactDOM 패키지와 Linux의 `/usr/share/common-licenses/GPL-3`이 있는 환경에서 고지의 링크와 원문 바이트를 비교합니다.
