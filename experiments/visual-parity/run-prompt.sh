#!/usr/bin/env bash
# Run one pi prompt with TTY capture for visual comparison experiments.
set -euo pipefail

MODEL="${1:?model required, e.g. zai/glm-5.1 or cursor/composer-2.5}"
PROMPT="${2:?prompt required}"
LABEL="${3:-run}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
SESSION_DIR="${ROOT}/sessions/${LABEL}"
CAPTURE_DIR="${ROOT}/captures"
mkdir -p "$SESSION_DIR" "$CAPTURE_DIR"

export PI_CURSOR_NATIVE_TOOL_DISPLAY="${PI_CURSOR_NATIVE_TOOL_DISPLAY:-1}"
export PI_CURSOR_SETTING_SOURCES="${PI_CURSOR_SETTING_SOURCES:-}"
export TERM="${TERM:-xterm-256color}"
export COLUMNS="${COLUMNS:-120}"
export LINES="${LINES:-40}"

cd /workspace
CAPTURE_FILE="${CAPTURE_DIR}/${LABEL}.txt"
SESSION_FILE=""

# script(1) allocates a pseudo-TTY so native Cursor tool replay is enabled.
script -q -c "printf '%s\n' $(printf '%q' "$PROMPT") | timeout 180 npx pi -e . --model '$MODEL' --session-dir '$SESSION_DIR' --no-context-files" "$CAPTURE_FILE" || true

LATEST="$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1 || true)"
if [[ -n "$LATEST" ]]; then
  SESSION_FILE="$LATEST"
  HTML_OUT="${CAPTURE_DIR}/${LABEL}.html"
  npx pi --export "$SESSION_FILE" "$HTML_OUT" 2>/dev/null || true
  echo "session=$SESSION_FILE"
  echo "capture=$CAPTURE_FILE"
  echo "html=$HTML_OUT"
else
  echo "session=missing"
  echo "capture=$CAPTURE_FILE"
fi
