#!/usr/bin/env bash
# Run synthetic, local-only audio through the real Vite module worker in Chromium.
# Dependencies: pnpm, node >= 22, chromium, ffmpeg and ffprobe. No user files are used.
set -euo pipefail
cd "$(dirname "$0")"
fixture_dir=client/public/quality-test-fixtures
if [[ -e "$fixture_dir" ]]; then echo "Refusing to overwrite $fixture_dir" >&2; exit 1; fi
python3 - <<'PY'
import socket
for port in (3091, 9225):
    s = socket.socket()
    try:
        s.settimeout(0.5)
        if s.connect_ex(('127.0.0.1', port)) == 0: raise SystemExit(f'Port {port} is already in use; free it before running.')
    finally: s.close()
PY
tmp=$(mktemp -d)
server_pid='' chrome_pid=''
cleanup() {
  [[ -z "$chrome_pid" ]] || kill "$chrome_pid" 2>/dev/null || true
  [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true
  [[ -z "$chrome_pid" ]] || wait "$chrome_pid" 2>/dev/null || true
  [[ -z "$server_pid" ]] || wait "$server_pid" 2>/dev/null || true
  rm -rf "$fixture_dir"
  for _ in $(seq 1 10); do
    rm -rf "$tmp" 2>/dev/null && break
    sleep 0.2
  done
}
trap cleanup EXIT
mkdir "$fixture_dir"
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=12' -c:a libmp3lame -q:a 3 -y "$fixture_dir/normal.mp3"
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=12' -c:a flac -y "$fixture_dir/normal.flac"
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=3' -c:a libmp3lame -q:a 3 -write_xing 0 -y "$fixture_dir/no-xing.mp3"
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=3' -c:a pcm_s24le -y "$fixture_dir/normal24.wav"
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=3' -c:a flac -sample_fmt s32 -y "$fixture_dir/normal24.flac"
python3 - <<'PY'
import json, pathlib, subprocess
p = pathlib.Path('client/public/quality-test-fixtures')
for typ in ('mp3', 'flac'):
    path = p / f'normal.{typ}'
    data = path.read_bytes()
    (p / f'truncated.{typ}').write_bytes(data[:len(data)//2])
    packets = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pos,size', '-show_packets', '-of', 'json', str(path)]))['packets']
    (p / f'truncated-boundary.{typ}').write_bytes(data[:int(packets[len(packets)//2]['pos'])])
PY
./node_modules/.bin/vite --host 127.0.0.1 --port 3091 --strictPort >"$tmp/vite.log" 2>&1 & server_pid=$!
chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=9225 --user-data-dir="$tmp/chrome" about:blank >"$tmp/chrome.log" 2>&1 & chrome_pid=$!
for _ in $(seq 1 100); do
  if curl -fsS http://127.0.0.1:3091/ >/dev/null 2>&1 && curl -fsS http://127.0.0.1:9225/json >/dev/null 2>&1; then break; fi
  sleep 0.2
done
node client/src/lib/audio-quality.browser-test.mjs > "$tmp/result.log" || { cat "$tmp/result.log"; exit 1; }
node -e "const r=require('/tmp/audio-quality-browser-evidence.json'); console.log('Chromium worker:',r.summary); for (const c of r.cases) console.log(c.pass?'PASS':'FAIL',c.name)"
echo 'Evidence saved to /tmp/audio-quality-browser-evidence.json'
