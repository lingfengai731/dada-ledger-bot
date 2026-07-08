#!/usr/bin/env bash
set -euo pipefail

# Render the latest WhatsApp Web QR (written by the bot to data/last-qr.txt)
# as a browser-scannable PNG and serve it over HTTP. Use when pairing code
# fails and the noVNC terminal QR is unreadable.
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
  <title>DADA Bot WhatsApp QR</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f5f5f5; color: #111; }
    main { text-align: center; padding: 24px; }
    img { width: min(86vw, 560px); height: auto; image-rendering: pixelated; background: white; padding: 16px; box-shadow: 0 1px 10px #0002; }
    p { margin: 12px 0 0; color: #555; }
  </style>
</head>
<body>
  <main>
    <img id="qr" src="wa.png" alt="WhatsApp link QR">
    <p>Refreshes every 5 seconds. Scan from WhatsApp → Linked devices.</p>
  </main>
  <script>
    setInterval(() => {
      document.getElementById('qr').src = 'wa.png?t=' + Date.now();
    }, 5000);
  </script>
</body>
</html>
HTML

(
  while true; do
    if [[ -s "${QR_TXT}" ]]; then
      qrencode -s 10 -m 2 -r "${QR_TXT}" -o "${WEB_DIR}/wa.png" 2>/dev/null || true
    fi
    sleep 2
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

Keep this terminal open while scanning.
Press Ctrl+C after the phone links successfully.

EOF

cd "${WEB_DIR}"
python3 -m http.server "${PORT}" --bind 0.0.0.0
