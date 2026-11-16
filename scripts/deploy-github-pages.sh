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

# git archive honors export-ignore and export-subst attributes. Verify the
# extracted snapshot against every tracked blob before using either the build
# tree or the public source archive. Unexpected modes (e.g. submodules) fail
# closed rather than silently publishing an incomplete source snapshot.
node - "$source_commit" "$scratch/source" <<'NODE'
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [commit, source] = process.argv.slice(2);
const algorithm = execFileSync('git', ['rev-parse', '--show-object-format'], { encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['ls-tree', '-rz', '--full-tree', commit], { maxBuffer: 64 * 1024 * 1024 });
try {
  for (const record of tree.toString('binary').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const nameBytes = Buffer.from(record.slice(tab + 1), 'binary');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) {
      throw new Error(`지원하지 않는 추적 파일 형식: ${name} (${mode} ${type})`);
    }
    const file = path.join(source, name);
    const stat = fs.lstatSync(file);
    if ((mode === '120000' && !stat.isSymbolicLink()) ||
        (mode !== '120000' && !stat.isFile())) {
      throw new Error(`파일 형식 불일치: ${name}`);
    }
    const data = mode === '120000' ? fs.readlinkSync(file, { encoding: 'buffer' }) : fs.readFileSync(file);
    const actual = createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest('hex');
    if (actual !== oid) throw new Error(`파일 내용 불일치: ${name}`);
  }
} catch (error) {
  console.error('커밋과 배포 스냅샷이 다르므로 중단합니다. Git export 속성 등을 확인해 주세요.');
  console.error(error.message);
  process.exit(1);
}
NODE

# The ZIP itself cannot recursively include itself. It is regenerated only in
# the disposable build tree, never in the user's checkout or Git index.
test -f "$scratch/source/client/public/licenses/narravo-source.zip"
git archive --format=zip "$source_commit" -- . \
  ':(exclude)client/public/licenses/narravo-source.zip' > "$scratch/source-snapshot.zip"
mv "$scratch/source-snapshot.zip" "$scratch/source/client/public/licenses/narravo-source.zip"
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
if ! cmp -s "$scratch/source/client/public/licenses/narravo-source.zip" "$site/licenses/narravo-source.zip"; then
  echo '빌드 결과의 소스 ZIP이 커밋 스냅샷과 달라 배포를 중단합니다.' >&2
  exit 1
fi
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
