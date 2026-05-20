#!/usr/bin/env bash
# Record a short live pi TUI demo (requires graphical session + RecordScreen).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PI_CURSOR_NATIVE_TOOL_DISPLAY=1
export TERM=xterm-256color
SESSION=pi-parity-demo
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 120 -y 36
tmux send-keys -t "$SESSION" "cd /workspace && npx pi -e . --model cursor/composer-2.5 --no-context-files 'Read package.json and reply with only the name field.'" Enter
echo "Recording pi TUI demo in tmux session ${SESSION} — attach with: tmux attach -t ${SESSION}"
