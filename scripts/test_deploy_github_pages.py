#!/usr/bin/env python3
"""Exercise deployment against disposable local Git repositories only.

Requires Python 3, Git, Bash and Node.js. The fake pnpm builds no application;
no real remote or user's files are touched.
"""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import zipfile

SCRIPT = Path(__file__).with_name('deploy-github-pages.sh').resolve()
ZIP = 'client/public/licenses/narravo-source.zip'


def run(args, cwd, env, check=True):
    return subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, check=check)


def git(repo, env, *args):
    return run(['git', *args], repo, env).stdout.strip()


def snapshot_matches(site_zip, repo, env, commit):
    records = subprocess.check_output(['git', 'ls-tree', '-rz', '--full-tree', commit],
                                      cwd=repo, env=env).split(b'\0')
    tracked = {}
    for record in filter(None, records):
        meta, name = record.split(b'\t', 1)
        mode, kind, oid = meta.split(b' ')
        path = name.decode('utf-8')
        if path == ZIP:
            continue
        assert kind == b'blob', (path, kind)
        contents = subprocess.check_output(['git', 'cat-file', 'blob', oid.decode()], cwd=repo, env=env)
        tracked[path] = (mode.decode(), contents)
    with zipfile.ZipFile(site_zip) as z:
        entries = [i for i in z.infolist() if not i.is_dir()]
        names = [i.filename for i in entries]
        assert len(names) == len(set(names)), 'duplicate ZIP names'
        assert set(names) == set(tracked), f'ZIP path mismatch: missing={set(tracked)-set(names)}, extra={set(names)-set(tracked)}'
        for entry in entries:
            mode, content = tracked[entry.filename]
            assert z.read(entry) == content, f'ZIP content differs: {entry.filename}'
            file_mode = entry.external_attr >> 16
            if mode == '120000':
                assert stat.S_ISLNK(file_mode), f'ZIP symlink mode differs: {entry.filename}'
            elif mode == '100644':
                # Git's ZIP writer normally uses DOS creator 0 with no Unix
                # mode for non-executable regular files.
                assert file_mode == 0 or (stat.S_ISREG(file_mode) and not file_mode & 0o111), f'ZIP regular file mode differs: {entry.filename}'
            else:
                assert stat.S_ISREG(file_mode) and file_mode & 0o111, f'ZIP executable mode differs: {entry.filename}'


def main():
    with tempfile.TemporaryDirectory(prefix='narravo-deploy-test-') as tmp:
        tmp = Path(tmp)
        remote, repo, fakebin = tmp/'remote.git', tmp/'repo', tmp/'bin'
        repo.mkdir(); fakebin.mkdir()
        env = os.environ.copy()
        env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                    'GIT_AUTHOR_NAME': 'Local Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
                    'GIT_COMMITTER_NAME': 'Local Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid',
                    'MANUS_PROJECT_ID': 'test-value', 'MANUS_OAUTH_PORTAL_URL': 'test-value',
                    'MANUS_API_URL': 'test-value', 'MANUS_API_BROWSER_KEY': 'test-value',
                    'PATH': str(fakebin) + os.pathsep + env['PATH']})
        # Ensure no inherited Git redirection can target a non-test repository.
        for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'):
            env.pop(key, None)
        run(['git', 'init', '--bare', '--initial-branch=main', str(remote)], tmp, env)
        run(['git', 'init', '--initial-branch=main', str(repo)], tmp, env)
        git(repo, env, 'remote', 'add', 'origin', str(remote))
        (repo/'scripts').mkdir(); shutil.copyfile(SCRIPT, repo/'scripts/deploy-github-pages.sh')
        (repo/'client/public/licenses').mkdir(parents=True)
        with zipfile.ZipFile(repo/ZIP, 'w') as z:
            z.writestr('stale-only.txt', 'old, unrelated snapshot')
        (repo/'node_modules').mkdir()
        (repo/'.gitignore').write_text('node_modules/\nprivate-secret.txt\n', encoding='utf-8')
        (repo/'private-secret.txt').write_text('never publish this ignored file', encoding='utf-8')
        (repo/'read me 한글.txt').write_text('first commit content\n', encoding='utf-8')
        (repo/'executable.sh').write_text('#!/bin/sh\necho ok\n', encoding='utf-8')
        (repo/'executable.sh').chmod(0o755)
        (repo/'link to file').symlink_to('read me 한글.txt')
        fake = fakebin/'pnpm'
        fake.write_text('''#!/usr/bin/env bash
set -eu
[[ "$*" == 'exec vite build --base=/narrow/' ]]
[[ -z "${MANUS_PROJECT_ID-missing}" && -z "${MANUS_OAUTH_PORTAL_URL-missing}" && -z "${MANUS_API_URL-missing}" && -z "${MANUS_API_BROWSER_KEY-missing}" ]]
mkdir -p dist/public/licenses
cp -a client/public/licenses/. dist/public/licenses/
if [[ "${CORRUPT_BUILD_ZIP:-}" == 1 ]]; then printf corrupted > dist/public/licenses/narravo-source.zip; fi
printf 'stub site\\n' > dist/public/index.html
''', encoding='utf-8')
        fake.chmod(0o755)
        git(repo, env, 'add', '.')
        git(repo, env, 'commit', '-m', 'first snapshot')
        git(repo, env, 'push', 'origin', 'main')
        original_zip = (repo/ZIP).read_bytes()

        def deploy():
            result = run(['bash', 'scripts/deploy-github-pages.sh'], repo, env, check=False)
            assert result.returncode == 0, result.stdout
            return git(repo, env, 'rev-parse', 'HEAD')

        def inspect(commit):
            site = tmp/'site.zip'
            site.write_bytes(subprocess.check_output(['git', '--git-dir', str(remote), 'show', 'gh-pages:licenses/narravo-source.zip'], env=env))
            snapshot_matches(site, repo, env, commit)
            revision = run(['git', '--git-dir', str(remote), 'show', 'gh-pages:build-revision.txt'], tmp, env).stdout.strip()
            assert revision == commit
            paths = run(['git', '--git-dir', str(remote), 'ls-tree', '-r', '--name-only', 'gh-pages'], tmp, env).stdout.splitlines()
            assert '.nojekyll' in paths and 'private-secret.txt' not in paths
            assert (repo/ZIP).read_bytes() == original_zip, 'working-tree ZIP was modified'
            assert not git(repo, env, 'status', '--porcelain'), 'working tree/index was modified'

        first = deploy()
        inspect(first)
        first_pages = git(repo, env, 'ls-remote', 'origin', 'refs/heads/gh-pages').split()[0]
        (repo/'read me 한글.txt').write_text('second commit content\n', encoding='utf-8')
        (repo/'new-file.txt').write_text('new tracked file\n', encoding='utf-8')
        (repo/'executable.sh').unlink()
        git(repo, env, 'add', '.')
        git(repo, env, 'commit', '-m', 'second snapshot')
        git(repo, env, 'push', 'origin', 'main')
        second = deploy()
        inspect(second)
        parent = run(['git', '--git-dir', str(remote), 'rev-parse', 'gh-pages^'], tmp, env).stdout.strip()
        assert parent == first_pages, 'second deployment must preserve gh-pages history'
        print('PASS: stale ZIP regenerated from both commits; contents, modes, symlink, ignored file and history checked')

        before = git(repo, env, 'ls-remote', 'origin', 'refs/heads/gh-pages').split()[0]
        env['CORRUPT_BUILD_ZIP'] = '1'
        rejected = run(['bash', 'scripts/deploy-github-pages.sh'], repo, env, check=False)
        env.pop('CORRUPT_BUILD_ZIP')
        after = git(repo, env, 'ls-remote', 'origin', 'refs/heads/gh-pages').split()[0]
        assert rejected.returncode != 0 and '소스 ZIP이' in rejected.stdout and before == after, rejected.stdout
        print('PASS: altered build ZIP fails closed before gh-pages push')

        # Git export attributes can make git archive silently omit/change tracked data.
        (repo/'.gitattributes').write_text('new-file.txt export-ignore\n', encoding='utf-8')
        git(repo, env, 'add', '.')
        git(repo, env, 'commit', '-m', 'export-ignore must fail closed')
        git(repo, env, 'push', 'origin', 'main')
        before = git(repo, env, 'ls-remote', 'origin', 'refs/heads/gh-pages').split()[0]
        rejected = run(['bash', 'scripts/deploy-github-pages.sh'], repo, env, check=False)
        after = git(repo, env, 'ls-remote', 'origin', 'refs/heads/gh-pages').split()[0]
        assert rejected.returncode != 0 and before == after, 'export-ignore mismatch must stop before push'
        print('PASS: export-ignore mismatch fails closed before gh-pages push')

        (repo/'.gitattributes').write_text('new-file.txt export-subst\n', encoding='utf-8')
        (repo/'new-file.txt').write_text('$Format:%H$\n', encoding='utf-8')
        git(repo, env, 'add', '.')
        git(repo, env, 'commit', '-m', 'export-subst must fail closed')
        git(repo, env, 'push', 'origin', 'main')
        rejected = run(['bash', 'scripts/deploy-github-pages.sh'], repo, env, check=False)
        after = git(repo, env, 'ls-remote', 'origin', 'refs/heads/gh-pages').split()[0]
        assert rejected.returncode != 0 and before == after, 'export-subst mismatch must stop before push'
        print('PASS: export-subst mismatch fails closed before gh-pages push')

        # A gitlink is not an ordinary blob and must not become an empty source
        # directory. Keep the entire submodule fixture in the temporary folder.
        (repo/'.gitattributes').unlink()
        nested = tmp/'nested-repo'
        run(['git', 'init', '--initial-branch=main', str(nested)], tmp, env)
        (nested/'nested.txt').write_text('nested source\n', encoding='utf-8')
        git(nested, env, 'add', '.')
        git(nested, env, 'commit', '-m', 'nested snapshot')
        git(repo, env, '-c', 'protocol.file.allow=always', 'submodule', 'add', str(nested), 'nested-module')
        git(repo, env, 'add', '.')
        git(repo, env, 'commit', '-m', 'unsupported gitlink')
        git(repo, env, 'push', 'origin', 'main')
        rejected = run(['bash', 'scripts/deploy-github-pages.sh'], repo, env, check=False)
        after = git(repo, env, 'ls-remote', 'origin', 'refs/heads/gh-pages').split()[0]
        assert rejected.returncode != 0 and '지원하지 않는 추적 파일 형식' in rejected.stdout and before == after, rejected.stdout
        print('PASS: unsupported submodule fails closed before gh-pages push')

        (repo/'dirty.txt').write_text('untracked', encoding='utf-8')
        rejected = run(['bash', 'scripts/deploy-github-pages.sh'], repo, env, check=False)
        assert rejected.returncode != 0, 'dirty tree must be rejected'
        print('PASS: dirty tree rejected')
        (repo/'dirty.txt').unlink()
        git(repo, env, 'checkout', '-b', 'feature')
        rejected = run(['bash', 'scripts/deploy-github-pages.sh'], repo, env, check=False)
        assert rejected.returncode != 0, 'non-main branch must be rejected'
        git(repo, env, 'checkout', 'main')
        (repo/'ahead.txt').write_text('not yet pushed\n', encoding='utf-8')
        git(repo, env, 'add', '.')
        git(repo, env, 'commit', '-m', 'local main ahead of remote')
        rejected = run(['bash', 'scripts/deploy-github-pages.sh'], repo, env, check=False)
        assert rejected.returncode != 0 and '원격 main과 로컬 main이 다릅니다' in rejected.stdout, 'remote mismatch must be rejected'
        after = git(repo, env, 'ls-remote', 'origin', 'refs/heads/gh-pages').split()[0]
        assert before == after, 'rejected deployments must not push'
        print('PASS: non-main branch and local/remote mismatch rejected without pushing')


if __name__ == '__main__':
    main()
