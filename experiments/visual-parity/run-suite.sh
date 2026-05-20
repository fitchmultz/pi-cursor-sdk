#!/usr/bin/env bash
# Full native-replay tool matrix: read, ls, bash, grep, find, write, edit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TMP_FILE="/tmp/pi-visual-parity-${RANDOM}.txt"

PROMPTS=(
  'Read package.json and reply with only the value of the "name" field.'
  'Use the ls tool to list the top-level entries in the src directory. Reply with only the file names, one per line.'
  'Use the bash tool to run: echo visual-parity-bash-ok. Reply with only the command stdout.'
  'Use grep to search for the string "pi-cursor-sdk" under the src directory. Reply with at most 3 matching lines.'
  'Use find (glob) to list TypeScript files matching "*.ts" directly under src (not subfolders). Reply with file names only, one per line.'
  "Use write to create ${TMP_FILE} with exactly one line: visual-parity-write-ok. Reply with only that line."
  "Use edit to change the only line in ${TMP_FILE} to: visual-parity-edit-ok. Reply with only that line."
)

run_model() {
  local model="$1"
  local slug="$2"
  local i=1
  for prompt in "${PROMPTS[@]}"; do
    echo "=== ${slug} prompt ${i} (${prompt%% *}...) ==="
    bash "${ROOT}/run-prompt.sh" "$model" "$prompt" "${slug}-p${i}"
    i=$((i + 1))
  done
}

export PI_CURSOR_NATIVE_TOOL_DISPLAY=1
run_model "zai/glm-5.1" "glm-5.1"
run_model "cursor/composer-2.5" "composer-2.5"

echo "Suite complete. Captures in ${ROOT}/captures"
