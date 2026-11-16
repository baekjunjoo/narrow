#!/usr/bin/env bash
set -euo pipefail

# Deploy only a committed, up-to-date main; the normal working tree and index
# are never replaced by the generated website files.
root=$(git rev-parse --show-toplevel)
cd "$root"
if [[ "$(git branch --show-current)" != "main" ]] || [[ -n "$(git status --porcelain)" ]]; then
  echo 'main 브랜치에서 변경사항을 저장하고 작업 트리가 깨끗한 상태로 실행해 주세요.' >&2
  exit 1
fi
git fetch origin main
source_commit=$(git rev-parse HEAD)
if [[ "$source_commit" != "$(git rev-parse refs/remotes/origin/main)" ]]; then
  echo '원격 main과 로컬 main이 다릅니다. 동기화한 다음 다시 실행해 주세요.' >&2
  exit 1
fi

# Build a snapshot of tracked files only. Ignored local files must never be
# copied into a public site, and existing local build artifacts stay untouched.
if [[ ! -d "$root/node_modules" ]]; then
  echo '의존성이 없습니다. 먼저 pnpm install --frozen-lockfile을 실행해 주세요.' >&2
  exit 1
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/source"
git archive "$source_commit" | tar -x -C "$scratch/source"
ln -s "$root/node_modules" "$scratch/source/node_modules"

# GitHub Pages has no server; avoid embedding even browser-safe project config
# from the Manus development environment in this public build.
(
  cd "$scratch/source"
  MANUS_PROJECT_ID='' MANUS_OAUTH_PORTAL_URL='' MANUS_API_URL='' MANUS_API_BROWSER_KEY='' \
    pnpm exec vite build --base=/narrow/
)
site="$scratch/source/dist/public"
test -s "$site/index.html"
printf '%s\n' "$source_commit" > "$site/build-revision.txt"
touch "$site/.nojekyll"

# Reuse the current deployment parent, if any. Normal pushes reject concurrent
# changes; no force-push or branch deletion is performed.
remote_ref=$(git ls-remote --heads origin refs/heads/gh-pages)
parent=()
if [[ -n "$remote_ref" ]]; then
  git fetch origin refs/heads/gh-pages
  parent=(-p "$(git rev-parse FETCH_HEAD)")
fi
git_dir=$(git rev-parse --absolute-git-dir)
export GIT_DIR="$git_dir" GIT_WORK_TREE="$site" GIT_INDEX_FILE="$scratch/index"
git -C "$site" add -f -A .
tree=$(git -C "$site" write-tree)
commit=$(printf 'Deploy GitHub Pages from %s\n' "$source_commit" | git -C "$site" commit-tree "$tree" "${parent[@]}")
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
git push origin "$commit:refs/heads/gh-pages"
echo "GitHub Pages 산출물을 gh-pages에 올렸습니다. 소스: $source_commit"
