#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROMPTS=(
  'Read package.json and reply with only the value of the "name" field.'
  'Use the ls tool to list the top-level entries in the src directory. Reply with only the file names, one per line.'
  'Use the bash tool to run: echo visual-parity-bash-ok. Reply with only the command stdout.'
)

run_model() {
  local model="$1"
  local slug="$2"
  local i=1
  for prompt in "${PROMPTS[@]}"; do
    echo "=== ${slug} prompt ${i} ==="
    bash "${ROOT}/run-prompt.sh" "$model" "$prompt" "${slug}-p${i}"
    i=$((i + 1))
  done
}

export PI_CURSOR_NATIVE_TOOL_DISPLAY=1
run_model "zai/glm-5.1" "glm-5.1"
run_model "cursor/composer-2.5" "composer-2.5"

echo "Suite complete. Captures in ${ROOT}/captures"
