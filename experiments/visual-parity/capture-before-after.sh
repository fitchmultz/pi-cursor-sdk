#!/usr/bin/env bash
# Capture composer-2.5 tool cards on main (before) vs parity branch (after).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${ROOT}/../.." && pwd)"
ASSETS="${ROOT}/pr-assets"
BEFORE="${ASSETS}/before/screenshots"
AFTER="${ASSETS}/after/screenshots"
REF="${ASSETS}/reference-glm/screenshots"
WORKTREE="${REPO}/.worktrees/main-parity"
BRANCH="$(git -C "${REPO}" branch --show-current)"

mkdir -p "${BEFORE}" "${AFTER}" "${REF}" "${WORKTREE}"

run_composer_suite() {
  local repo_dir="$1"
  local out_subdir="$2"
  rm -rf "${ROOT}/captures" "${ROOT}/sessions" "${ROOT}/screenshots"
  cd "${ROOT}"
  export PI_CURSOR_NATIVE_TOOL_DISPLAY=1
  local i=1
  local prompts=(
    'Read package.json and reply with only the value of the "name" field.'
    'Use the ls tool to list the top-level entries in the src directory. Reply with only the file names, one per line.'
    'Use the bash tool to run: echo visual-parity-bash-ok. Reply with only the command stdout.'
    'Use grep to search for the string "export" in src/index.ts. Reply with at most 2 matching lines.'
    'Use find to list files matching "src/*.ts". Reply with at most 5 file paths, one per line.'
  )
  for prompt in "${prompts[@]}"; do
    PI_REPO_DIR="${repo_dir}" bash "${ROOT}/run-prompt.sh" "cursor/composer-2.5" "$prompt" "capture-p${i}"
    i=$((i + 1))
  done
  node "${ROOT}/capture-html-tool-cards.mjs"
  mkdir -p "${out_subdir}"
  cp -a "${ROOT}/screenshots/." "${out_subdir}/"
}

echo "=== Prepare main worktree ==="
git -C "${REPO}" fetch origin main 2>/dev/null || true
if git -C "${REPO}" worktree list | rg -q "${WORKTREE}"; then
  git -C "${REPO}" worktree remove --force "${WORKTREE}" 2>/dev/null || rm -rf "${WORKTREE}"
fi
git -C "${REPO}" worktree add "${WORKTREE}" main
(cd "${WORKTREE}" && npm ci >/dev/null 2>&1)

echo "=== BEFORE (main worktree) ==="
run_composer_suite "${WORKTREE}" "${BEFORE}"

echo "=== AFTER (${BRANCH}) ==="
(cd "${REPO}" && npm ci >/dev/null 2>&1)
run_composer_suite "${REPO}" "${AFTER}"

echo "=== REFERENCE glm read/bash (${BRANCH}) ==="
rm -rf "${ROOT}/captures" "${ROOT}/sessions" "${ROOT}/screenshots"
export PI_CURSOR_NATIVE_TOOL_DISPLAY=1
bash "${ROOT}/run-prompt.sh" "zai/glm-5.1" 'Read package.json and reply with only the value of the "name" field.' "glm-read"
bash "${ROOT}/run-prompt.sh" "zai/glm-5.1" 'Use the bash tool to run: echo visual-parity-bash-ok. Reply with only the command stdout.' "glm-bash"
node "${ROOT}/capture-html-tool-cards.mjs"
mkdir -p "${REF}"
cp -a "${ROOT}/screenshots/." "${REF}/"

node "${ROOT}/build-comparison-gallery.mjs"
echo "Done. Assets: ${ASSETS}"
