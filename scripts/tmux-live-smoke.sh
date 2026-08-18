#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/cursor-smoke-shell.sh
. "$ROOT/scripts/lib/cursor-smoke-shell.sh"

SMOKE_DIR="${SMOKE_DIR:-/tmp/pi-cursor-sdk-live-smoke-$(date +%Y%m%dT%H%M%S)}"
SHELL_BIN="${SHELL:-/bin/bash}"

PI_BIN=""
NODE_BIN=""
NPM_BIN=""
RG_BIN=""
TMUX_BIN=""
ENV_BIN=""
SEALED_PATH=""
PI_BASE=()
DEBUG_ENV_UNSETS=()
BASE_ENV=()
NONE_ENV=()
DEFAULT_ENV=()

TMUX_SESSIONS=()

cleanup() {
	local session
	[[ -n "${TMUX_BIN:-}" ]] || return 0
	for session in "${TMUX_SESSIONS[@]:-}"; do
		"$TMUX_BIN" kill-session -t "$session" 2>/dev/null || true
	done
}
trap cleanup EXIT

print_help() {
	printf '%s\n' 'Partial live smoke runner for pi-cursor-sdk (subset of docs/cursor-live-smoke-checklist.md).

Usage:
  ./scripts/tmux-live-smoke.sh
  SMOKE_DIR=/tmp/pi-cursor-smoke ./scripts/tmux-live-smoke.sh

Environment:
  SMOKE_DIR                     Artifact directory. Defaults to /tmp/pi-cursor-sdk-live-smoke-<timestamp>.
  CURSOR_API_KEY                Optional fallback auth. Stored pi auth in ~/.pi/agent/auth.json is also supported.

Prerequisites:
  pi, node, npm, rg, tmux on PATH
  Resolved pi/node/npm/rg/tmux paths from the parent shell are reused in tmux-launched checks; pi shims run with the resolved node directory first on PATH.
  timeout or gtimeout optional; bash process-group kill fallback is used when absent
  Child pi runs clear Cursor SDK event-debug env; isolated cases force PI_CURSOR_SETTING_SOURCES=none and default-settings unsets it.

Coverage:
  - prereq model listing
  - basic non-interactive prompt (retry-empty-output; strict output assertion)
  - default ambient settings prompt (strict; no retry)
  - simple non-interactive math prompt (strict; no retry)
  - interactive TUI math/footer polling with cleanup
  - RPC steering after native replay tool execution (tmux-isolated)
  - diagnostics safety scan
  - JSONL assistant usage validation

Not covered here:
  - canonical rendered-PNG visual smoke; collect separately with docs/cursor-native-tool-visual-audit.md
  - bridge MCP
  - standalone native replay
  - abort/cancel cleanup
  - packaging and isolated smoke

Options:
  -h, --help                    Show this help.
  --self-test                   Run sealed PATH/env probes without live Cursor auth.

Exit codes:
  0  all partial checks passed
  1  prerequisite, smoke, safety, or JSONL validation failure'
}

log() { smoke_log "$@"; }
fail() { smoke_fail "$@"; }
run_with_timeout() { smoke_run_with_timeout "$@"; }

build_smoke_env_arrays() {
	smoke_build_cursor_sdk_event_debug_unsets
	DEBUG_ENV_UNSETS=( "${SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_UNSETS[@]}" )
	BASE_ENV=( "$ENV_BIN" "${DEBUG_ENV_UNSETS[@]}" "PATH=$SEALED_PATH" )
	NONE_ENV=( "$ENV_BIN" "${DEBUG_ENV_UNSETS[@]}" "PATH=$SEALED_PATH" PI_CURSOR_SETTING_SOURCES=none )
	DEFAULT_ENV=( "$ENV_BIN" "${DEBUG_ENV_UNSETS[@]}" -u PI_CURSOR_SETTING_SOURCES "PATH=$SEALED_PATH" )
}

tail_file() {
	local file="$1"
	local lines="${2:-80}"
	if [[ -s "$file" ]]; then
		tail -n "$lines" "$file" || true
	else
		printf '<empty: %s>\n' "$file"
	fi
}

assert_file_contains() {
	local name="$1"
	local file="$2"
	local pattern="$3"
	local label="$4"
	if ! "$RG_BIN" -q "$pattern" "$file"; then
		printf '[smoke] %s missing %s in %s\n' "$name" "$label" "$file" >&2
		printf '[smoke] %s transcript tail:\n' "$name" >&2
		tail_file "$file" 120 >&2
		fail "$name missing ${label}"
	fi
}

is_empty_retryable_exit() {
	local code="$1"
	local stdout="$2"
	[[ ! -s "$stdout" && ( "$code" == "0" || "$code" == "124" || "$code" == "137" || "$code" == "143" ) ]]
}

run_direct_attempt() {
	local name="$1"
	local timeout_secs="$2"
	local stdout="$3"
	local stderr="$4"
	shift 4
	rm -f "$stdout" "$stderr"

	if run_with_timeout "$timeout_secs" "$@" </dev/null >"$stdout" 2>"$stderr"; then
		return 0
	fi
	return $?
}

run_direct_fail() {
	local name="$1"
	local code="$2"
	local stdout="$3"
	local stderr="$4"
	local label="$5"
	if [[ "$code" != "0" ]]; then
		cat "$stderr" >&2 || true
		fail "$name exited $code"
	fi
	printf '[smoke] %s missing %s in %s\n' "$name" "$label" "$stdout" >&2
	printf '[smoke] %s stdout tail:\n' "$name" >&2
	tail_file "$stdout" 120 >&2
	printf '[smoke] %s stderr tail:\n' "$name" >&2
	tail_file "$stderr" 80 >&2
	fail "$name missing ${label}"
}

run_direct() {
	local name="$1"
	local timeout_secs="$2"
	local policy="$3"
	local expected_pattern="$4"
	local expected_label="$5"
	shift 5
	local stdout="$SMOKE_DIR/${name}.stdout.txt"
	local stderr="$SMOKE_DIR/${name}.stderr.txt"
	local code=0

	if run_direct_attempt "$name" "$timeout_secs" "$stdout" "$stderr" "$@"; then
		code=0
	else
		code=$?
	fi
	if [[ "$code" == "0" ]] && "$RG_BIN" -q "$expected_pattern" "$stdout"; then
		log "$name PASS"
		return 0
	fi

	case "$policy" in
		strict)
			run_direct_fail "$name" "$code" "$stdout" "$stderr" "$expected_label"
			;;
		retry-empty-output)
			local first_stdout="$SMOKE_DIR/${name}.attempt1.stdout.txt"
			local first_stderr="$SMOKE_DIR/${name}.attempt1.stderr.txt"
			if ! is_empty_retryable_exit "$code" "$stdout"; then
				run_direct_fail "$name" "$code" "$stdout" "$stderr" "$expected_label"
			fi
			mv "$stdout" "$first_stdout" 2>/dev/null || true
			mv "$stderr" "$first_stderr" 2>/dev/null || true
			log "$name retrying once after empty output with exit $code"
			if run_direct_attempt "$name" "$timeout_secs" "$stdout" "$stderr" "$@"; then
				local retry_code=0
				if "$RG_BIN" -q "$expected_pattern" "$stdout"; then
					log "$name PASS after retry (first exit $code; first stderr: $first_stderr)"
					return 0
				fi
				printf '[smoke] %s retry exited %s but still missed %s\n' "$name" "$retry_code" "$expected_label" >&2
			else
				local retry_code=$?
				printf '[smoke] %s retry exited %s after first empty output exit %s\n' "$name" "$retry_code" "$code" >&2
			fi
			printf '[smoke] %s first stdout tail:\n' "$name" >&2
			tail_file "$first_stdout" 80 >&2
			printf '[smoke] %s first stderr tail:\n' "$name" >&2
			tail_file "$first_stderr" 80 >&2
			printf '[smoke] %s retry stdout tail:\n' "$name" >&2
			tail_file "$stdout" 120 >&2
			printf '[smoke] %s retry stderr tail:\n' "$name" >&2
			tail_file "$stderr" 80 >&2
			fail "$name retry failed after empty output"
			;;
		*)
			fail "$name unknown run_direct policy: $policy (expected strict or retry-empty-output)"
			;;
	esac
}

quote_command() {
	local quoted=()
	local arg
	for arg in "$@"; do
		printf -v arg '%q' "$arg"
		quoted+=("$arg")
	done
	printf '%s ' "${quoted[@]}"
}

run_tui_math_footer_poll() {
	local name="$1"
	local timeout_secs="$2"
	shift 2
	local session="pi-cursor-smoke-${name}-$$"
	local capture="$SMOKE_DIR/${name}.capture.txt"
	local script
	local command
	command="$(quote_command "$@")"
	rm -f "$capture"

	printf -v script 'export PATH=%q
cd %q || exit 97
exec %s
' "$SEALED_PATH" "$ROOT" "$command"
	"$TMUX_BIN" new-session -d -s "$session" -x 120 -y 40 -- "$SHELL_BIN" -lc "$script"
	TMUX_SESSIONS+=("$session")

	local elapsed=0
	local missing=""
	while true; do
		"$TMUX_BIN" capture-pane -pt "$session" >"$capture" 2>/dev/null || true
		missing=""
		"$RG_BIN" -q "SUM=42" "$capture" || missing="${missing} SUM=42"
		"$RG_BIN" -q "\\(cursor\\) grok-4\\.6" "$capture" || missing="${missing} footer (cursor) grok-4.6"
		if [[ -z "$missing" ]]; then
			"$TMUX_BIN" kill-session -t "$session" 2>/dev/null || true
			log "$name PASS"
			return 0
		fi

		sleep 2
		elapsed=$((elapsed + 2))
		if (( elapsed >= timeout_secs )); then
			"$TMUX_BIN" kill-session -t "$session" 2>/dev/null || true
			printf '[smoke] %s timed out after %ss; missing:%s\n' "$name" "$timeout_secs" "$missing" >&2
			printf '[smoke] %s capture tail:\n' "$name" >&2
			tail_file "$capture" 120 >&2
			fail "$name timed out waiting for TUI evidence"
		fi
	done
}

run_tmux() {
	local name="$1"
	local timeout_secs="$2"
	local dump_stderr_on_fail="$3"
	shift 3
	local session="pi-cursor-smoke-${name}-$$"
	local marker="$SMOKE_DIR/${name}.done"
	local stdout="$SMOKE_DIR/${name}.stdout.txt"
	local stderr="$SMOKE_DIR/${name}.stderr.txt"
	local command
	local script
	command="$(quote_command "$@")"
	rm -f "$marker" "$stdout" "$stderr"

	printf -v script 'export PATH=%q
cd %q || exit 97
%s> %q 2> %q
code=$?
printf '\''%%s\n'\'' "$code" > %q
' "$SEALED_PATH" "$ROOT" "$command" "$stdout" "$stderr" "$marker"
	"$TMUX_BIN" new-session -d -s "$session" -- "$SHELL_BIN" -lc "$script"
	TMUX_SESSIONS+=("$session")

	local elapsed=0
	while [[ ! -f "$marker" ]]; do
		sleep 2
		elapsed=$((elapsed + 2))
		if (( elapsed >= timeout_secs )); then
			"$TMUX_BIN" capture-pane -pt "$session" >"$SMOKE_DIR/${name}.capture.txt" || true
			"$TMUX_BIN" kill-session -t "$session" 2>/dev/null || true
			fail "$name timed out after ${timeout_secs}s (see ${name}.capture.txt)"
		fi
	done

	local code
	code="$(cat "$marker")"
	"$TMUX_BIN" kill-session -t "$session" 2>/dev/null || true
	if [[ "$code" != "0" ]]; then
		if [[ "$dump_stderr_on_fail" == "1" ]]; then
			cat "$stderr" >&2 || true
		fi
		fail "$name exited $code"
	fi
	log "$name PASS"
}

model_listed() {
	local file="$1"
	if [[ -n "${RG_BIN:-}" ]]; then
		"$RG_BIN" -q "grok-4\.6" "$file"
	else
		grep -q "grok-4\.6" "$file"
	fi
}

# Capture full catalog then search. Never pipe list-models into rg -q under pipefail.
capture_and_require_default_model() {
	local list_cmd=("$@")
	local models_out="$SMOKE_DIR/prereq.models.txt"
	local models_err="$SMOKE_DIR/prereq.stderr.txt"
	if ! "${list_cmd[@]}" >"$models_out" 2>"$models_err"; then
		fail "pi --list-models cursor failed"
	fi
	if ! model_listed "$models_out" && ! model_listed "$models_err"; then
		fail "cursor/grok-4.6 not listed"
	fi
}

run_self_test() {
	local temp_dir bin_dir fake_pi fake_node fake_node_marker fake_list_pi env_capture hostile_path captured_path node_dir name
	RG_BIN="$(command -v rg || true)"
	temp_dir="$(mktemp -d /tmp/pi-cursor-sdk-live-smoke-self-test.XXXXXX)"
	trap 'rm -rf "$temp_dir"' RETURN
	bin_dir="$temp_dir/bin"
	mkdir -p "$bin_dir"
	fake_pi="$bin_dir/pi"
	fake_node="$bin_dir/node"
	fake_node_marker="$temp_dir/fake-node-used"
	env_capture="$temp_dir/fake-pi.env"
	cat >"$fake_pi" <<EOF_SELFTEST_PI
#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("$env_capture", Object.entries(process.env).map(([key, value]) => key + "=" + (value ?? "")).join("\\n") + "\\n", "utf8");
EOF_SELFTEST_PI
	cat >"$fake_node" <<EOF_SELFTEST_NODE
#!/usr/bin/env bash
echo fake-node-used > "$fake_node_marker"
exit 99
EOF_SELFTEST_NODE
	chmod +x "$fake_pi" "$fake_node"

	ENV_BIN="$(smoke_resolve_cmd env)"
	NODE_BIN="$(smoke_resolve_node_cmd)"
	smoke_load_cursor_sdk_event_debug_env_names "$NODE_BIN" "$ROOT/shared/cursor-sdk-event-debug-env.mjs"
	hostile_path="$bin_dir:$PATH"
	[[ "$(smoke_build_sealed_node_path "$NODE_BIN" "")" != *: ]] || fail "self-test failed: empty inherited PATH left a trailing PATH separator"
	SEALED_PATH="$(smoke_build_sealed_node_path "$NODE_BIN" "$hostile_path")"
	build_smoke_env_arrays
	node_dir="$(dirname "$NODE_BIN")"

	PI_CURSOR_SETTING_SOURCES=all \
	PI_CURSOR_SDK_EVENT_DEBUG=1 \
	PI_CURSOR_SDK_EVENT_DEBUG_DIR="$temp_dir/debug-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR="$temp_dir/debug-run-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR="$temp_dir/debug-session-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_STDERR=1 \
		"${NONE_ENV[@]}" "$fake_pi" --version
	[[ ! -e "$fake_node_marker" ]] || fail "self-test failed: sealed PATH still used hostile fake node"
	captured_path="$(awk -F= '$1 == "PATH" { print substr($0, 6); exit }' "$env_capture")"
	[[ "${captured_path%%:*}" == "$node_dir" ]] || fail "self-test failed: PATH did not start with resolved node dir"
	grep -qx 'PI_CURSOR_SETTING_SOURCES=none' "$env_capture" || fail "self-test failed: isolated env did not force PI_CURSOR_SETTING_SOURCES=none"
	for name in "${SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES[@]}"; do
		if grep -q "^${name}=" "$env_capture"; then
			fail "self-test failed: $name was not cleared"
		fi
	done

	PI_CURSOR_SETTING_SOURCES=all "${DEFAULT_ENV[@]}" "$fake_pi" --version
	if grep -q '^PI_CURSOR_SETTING_SOURCES=' "$env_capture"; then
		fail "self-test failed: default-settings env did not unset PI_CURSOR_SETTING_SOURCES"
	fi
	# Large-catalog prereq: exercise the same capture_and_require_default_model helper.
	fake_list_pi="$bin_dir/pi-list-models"
	cat >"$fake_list_pi" <<'EOF_FAKE_LIST'
#!/usr/bin/env bash
i=0
while [[ $i -lt 20000 ]]; do
	printf 'cursor/model-%s\n' "$i"
	i=$((i + 1))
done
printf 'cursor/grok-4.6\n'
exit 0
EOF_FAKE_LIST
	chmod +x "$fake_list_pi"
	SMOKE_DIR="$temp_dir" capture_and_require_default_model "$fake_list_pi"
	if [[ "$(wc -l <"$temp_dir/prereq.models.txt" | tr -d ' ')" -lt 20000 ]]; then
		fail "self-test failed: large catalog was truncated before search"
	fi

	printf '[smoke] self-test PASS\n'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	print_help
	exit 0
fi
if [[ "${1:-}" == "--self-test" ]]; then
	run_self_test
	exit 0
fi

PI_BIN="$(smoke_resolve_cmd pi)"
NODE_BIN="$(smoke_resolve_node_cmd)"
NPM_BIN="$(smoke_resolve_cmd npm)"
RG_BIN="$(smoke_resolve_cmd rg)"
TMUX_BIN="$(smoke_resolve_cmd tmux)"
ENV_BIN="$(smoke_resolve_cmd env)"
smoke_load_cursor_sdk_event_debug_env_names "$NODE_BIN" "$ROOT/shared/cursor-sdk-event-debug-env.mjs"
SEALED_PATH="$(smoke_build_sealed_node_path "$NODE_BIN" "$PATH")"
build_smoke_env_arrays
if [[ "$SHELL_BIN" != /* ]]; then
	SHELL_BIN="$(smoke_resolve_cmd "$SHELL_BIN")"
fi
PI_BASE=(
	"$PI_BIN" --approve -e "$ROOT"
	--cursor-no-fast
	--model cursor/grok-4.6
)

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
	log "CURSOR_API_KEY is unset; relying on stored pi auth or other supported Cursor auth"
fi

mkdir -p "$SMOKE_DIR"
printf '%s\n' "$SMOKE_DIR" >"$SMOKE_DIR/smoke-dir.txt"

log "SMOKE_DIR=$SMOKE_DIR"
log "pi=$PI_BIN"
log "node=$NODE_BIN"
log "npm=$NPM_BIN"
log "tmux=$TMUX_BIN"
log "partial live smoke: prereq, basic, default-settings, noninteractive-math, tui, steering, diagnostics, jsonl"

"${BASE_ENV[@]}" "$PI_BIN" --version | tee "$SMOKE_DIR/prereq.pi-version.txt"
"${BASE_ENV[@]}" "$NPM_BIN" --prefix "$ROOT" ls @cursor/sdk @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui | tee "$SMOKE_DIR/prereq.npm-ls.txt"

capture_and_require_default_model "${NONE_ENV[@]}" "${PI_BASE[@]}" --list-models cursor
log "prereq PASS"

run_direct basic 600 retry-empty-output "PI_CURSOR_SMOKE_OK" "PI_CURSOR_SMOKE_OK" \
	"${NONE_ENV[@]}" "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/basic" \
	--no-tools \
	-p 'Live smoke. Reply exactly: PI_CURSOR_SMOKE_OK'

run_direct default-settings 300 strict "PRODUCT=42" "PRODUCT=42" \
	"${DEFAULT_ENV[@]}" "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/default-settings" \
	--no-tools \
	-p 'Default settings smoke. Include PRODUCT=42 in the final answer.'

run_direct noninteractive-math 300 strict "SUM=42" "SUM=42" \
	"${NONE_ENV[@]}" "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/noninteractive-math" \
	--no-tools \
	-p 'Noninteractive math smoke. Compute 19 + 23. Reply only with SUM=42.'

run_tui_math_footer_poll tui 420 \
	"${NONE_ENV[@]}" "${PI_BASE[@]}" \
	--session-dir "$SMOKE_DIR/tui" \
	--no-tools \
	'TUI smoke. Compute 19 + 23. Reply only with SUM=<number>.'

run_tmux steering 420 1 \
	"${NONE_ENV[@]}" "SMOKE_SESSION_DIR=$SMOKE_DIR/steering" "PI_BIN=$PI_BIN" "$NODE_BIN" "$ROOT/scripts/steering-rpc-smoke.mjs"
"$RG_BIN" -q '"steerOk":true' "$SMOKE_DIR/steering.stdout.txt" || fail "steering missing steerOk"
"$RG_BIN" -q '"steerChain":true' "$SMOKE_DIR/steering.stdout.txt" || fail "steering missing steerChain"
"$RG_BIN" -q "already has active run|AgentBusyError" "$SMOKE_DIR/steering.stdout.txt" "$SMOKE_DIR/steering.stderr.txt" && fail "steering hit AgentBusyError" || true

forbidden_files="$(find "$SMOKE_DIR" -type f \( -name '*stderr.txt' -o -name '*capture*.txt' \) -print0 |
	xargs -0 grep -IlE 'CURSOR_API_KEY|Bearer [A-Za-z0-9._-]+|/cursor-pi-tool-bridge/[^ ]+/mcp|127\.0\.0\.1:[0-9]+/cursor-pi-tool-bridge|apiKey|cookie|session-cookie|secret-token' || true)"
if [[ -n "$forbidden_files" ]]; then
	printf '[smoke] diagnostics safety scan found forbidden material in:\n' >&2
	while IFS= read -r file; do
		[[ -z "$file" ]] && continue
		if [[ "$file" == "$SMOKE_DIR/"* ]]; then
			printf '[smoke]   %s\n' "${file#"$SMOKE_DIR/"}" >&2
		else
			printf '[smoke]   %s\n' "$file" >&2
		fi
	done <<<"$forbidden_files"
	fail "diagnostics safety scan found forbidden material"
fi
log "diagnostics safety PASS"

"$NODE_BIN" "$ROOT/scripts/validate-smoke-jsonl.mjs" "$SMOKE_DIR"
log "jsonl structural scan PASS"
log "partial live smoke checks passed (see --help for uncovered named release checks)"
