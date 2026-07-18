#!/usr/bin/env bash
set -euo pipefail

# Render the latest WhatsApp Web QR (written by the bot to data/last-qr.txt)
# as a browser-scannable PNG and serve it over HTTP. Also shows the latest
# pairing code when the bot can request one.
#
# Usage on the VPS:
#   cd /opt/dada-ledger-bot
#   ./ops/relink-qr.sh
#
# Optional:
#   PORT=8081 ./ops/relink-qr.sh
#   PUBLIC_HOST=207.148.68.180 ./ops/relink-qr.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QR_TXT="${ROOT_DIR}/data/last-qr.txt"
PAIRING_TXT="${ROOT_DIR}/data/last-pairing-code.txt"
PAIRING_STATUS_TXT="${ROOT_DIR}/data/last-pairing-status.txt"
WEB_DIR="${TMPDIR:-/tmp}/dada-wa-qr"
PORT="${PORT:-8080}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
QR_LOOP_PID=""

cleanup() {
  if [[ -n "${QR_LOOP_PID}" ]] && kill -0 "${QR_LOOP_PID}" 2>/dev/null; then
    kill "${QR_LOOP_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing command: $1" >&2
    echo "Install on Ubuntu/Debian: apt install -y $2" >&2
    exit 1
  fi
}

need qrencode qrencode
need python3 python3

if [[ ! -s "${QR_TXT}" ]]; then
  echo "No QR found at ${QR_TXT}" >&2
  echo "Start/restart the bot first, then wait until it logs a QR:" >&2
  echo "  pm2 restart dada-bot && pm2 logs dada-bot --lines 40" >&2
  exit 1
fi

mkdir -p "${WEB_DIR}"
cat >"${WEB_DIR}/index.html" <<'HTML'
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="cache-control" content="no-store, no-cache, must-revalidate">
  <meta http-equiv="pragma" content="no-cache">
  <meta http-equiv="expires" content="0">
  <title>DADA Bot WhatsApp Link</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f5f5f5; color: #111; }
    main { text-align: center; padding: 24px; }
    img { width: min(86vw, 560px); height: auto; image-rendering: pixelated; background: white; padding: 16px; box-shadow: 0 1px 10px #0002; }
    .code { margin: 18px auto 0; max-width: 560px; background: white; padding: 16px; box-shadow: 0 1px 10px #0002; }
    .label { margin: 0 0 8px; color: #555; font-size: 14px; }
    #pairing { margin: 0; font-size: clamp(32px, 9vw, 54px); font-weight: 800; letter-spacing: .08em; }
    #status { margin-top: 8px; color: #666; font-size: 13px; overflow-wrap: anywhere; }
    #updated { margin-top: 8px; color: #777; font-size: 13px; }
    p { margin: 12px 0 0; color: #555; }
  </style>
</head>
<body>
  <main>
    <img id="qr" src="wa.png" alt="WhatsApp link QR">
    <div class="code">
      <p class="label">Pairing code (if available)</p>
      <pre id="pairing">loading...</pre>
      <div id="status">status loading...</div>
      <div id="updated">checking...</div>
    </div>
    <p>Refreshes every second. Use the newest pairing code or scan the QR.</p>
  </main>
  <script>
    async function refresh() {
      document.getElementById('qr').src = 'wa.png?t=' + Date.now();
      try {
        const res = await fetch('pairing-code.txt?t=' + Date.now(), { cache: 'no-store' });
        const text = (await res.text()).trim();
        document.getElementById('pairing').textContent = text || 'No code';
        const statusRes = await fetch('pairing-status.txt?t=' + Date.now(), { cache: 'no-store' });
        const statusText = (await statusRes.text()).trim();
        document.getElementById('status').textContent = statusText || 'No status yet';
        document.getElementById('updated').textContent = 'Checked ' + new Date().toLocaleTimeString();
      } catch {
        document.getElementById('pairing').textContent = 'No code';
        document.getElementById('status').textContent = 'Status unavailable';
        document.getElementById('updated').textContent = 'Check failed ' + new Date().toLocaleTimeString();
      }
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>
HTML

(
  while true; do
    if [[ -s "${QR_TXT}" ]]; then
      qrencode -s 10 -m 2 -r "${QR_TXT}" -o "${WEB_DIR}/wa.png.tmp" 2>/dev/null && mv "${WEB_DIR}/wa.png.tmp" "${WEB_DIR}/wa.png" || true
    fi
    if [[ -s "${PAIRING_TXT}" ]]; then
      tr -d '\r' <"${PAIRING_TXT}" >"${WEB_DIR}/pairing-code.txt.tmp"
      mv "${WEB_DIR}/pairing-code.txt.tmp" "${WEB_DIR}/pairing-code.txt"
    else
      printf 'No pairing code right now\n' >"${WEB_DIR}/pairing-code.txt.tmp"
      mv "${WEB_DIR}/pairing-code.txt.tmp" "${WEB_DIR}/pairing-code.txt"
    fi
    if [[ -s "${PAIRING_STATUS_TXT}" ]]; then
      tr -d '\r' <"${PAIRING_STATUS_TXT}" >"${WEB_DIR}/pairing-status.txt.tmp"
      mv "${WEB_DIR}/pairing-status.txt.tmp" "${WEB_DIR}/pairing-status.txt"
    else
      printf 'No pairing-code request status yet\n' >"${WEB_DIR}/pairing-status.txt.tmp"
      mv "${WEB_DIR}/pairing-status.txt.tmp" "${WEB_DIR}/pairing-status.txt"
    fi
    sleep 1
  done
) &
QR_LOOP_PID="$!"

# Create the first image before printing the URL.
for _ in {1..10}; do
  [[ -s "${WEB_DIR}/wa.png" ]] && break
  sleep 0.5
done

if [[ -z "${PUBLIC_HOST}" ]]; then
  PUBLIC_HOST="$(curl -fsS --max-time 3 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
PUBLIC_HOST="${PUBLIC_HOST:-<server-ip>}"

cat <<EOF

WhatsApp QR web page is ready:
  http://${PUBLIC_HOST}:${PORT}/

Scan from the bot phone:
  WhatsApp -> Linked devices -> Link a device
  or choose "Link with phone number instead" and enter the page's pairing code.

Keep this terminal open while scanning.
Press Ctrl+C after the phone links successfully.

EOF

cd "${WEB_DIR}"
python3 -m http.server "${PORT}" --bind 0.0.0.0
