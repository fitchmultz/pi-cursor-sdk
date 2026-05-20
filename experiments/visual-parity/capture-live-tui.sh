#!/usr/bin/env bash
# Capture live pi TUI pane text (ANSI) for visual review when a desktop is unavailable.
set -euo pipefail

MODEL="${1:?model, e.g. cursor/composer-2.5}"
PROMPT="${2:?prompt}"
LABEL="${3:-capture}"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)/tui-captures"
mkdir -p "$OUT_DIR"

export PI_CURSOR_NATIVE_TOOL_DISPLAY=1
export TERM="${TERM:-screen-256color}"

SESSION="pi-tui-${LABEL}"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 120 -y 40
tmux send-keys -t "$SESSION" "cd /workspace && npx pi -e . --model '${MODEL}' --no-context-files --session-dir '${OUT_DIR}/sessions-${LABEL}' '${PROMPT}'" Enter

for _ in $(seq 1 90); do
	if tmux capture-pane -t "$SESSION" -p | rg -q "pi-cursor-sdk|visual-parity-bash-ok|bundled-context-windows"; then
		sleep 2
		break
	fi
	sleep 1
done

tmux capture-pane -t "$SESSION" -p -S -3000 > "${OUT_DIR}/${LABEL}.txt"
tmux kill-session -t "$SESSION"
echo "Wrote ${OUT_DIR}/${LABEL}.txt"
