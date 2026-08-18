#!/bin/bash
# Isolated /tmp install + fail-fast live smoke for pi-cursor-sdk native replay.
#
# Validates packed extension load, plan-strip resync, and absence of "Tool * not found".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/cursor-smoke-shell.sh
. "$ROOT/scripts/lib/cursor-smoke-shell.sh"
SMOKE_LOG_PREFIX=isolated-smoke

REAL_HOME="${REAL_HOME:-$HOME}"
PI_AGENT_DIR="${PI_AGENT_DIR:-$REAL_HOME/.pi/agent}"
AUTH_JSON="${AUTH_JSON:-$PI_AGENT_DIR/auth.json}"
REPO="${REPO:-$ROOT}"
ISOLATED="${ISOLATED:-/tmp/pi-cursor-sdk-isolated-$(date +%Y%m%dT%H%M%S)}"
PI_LIVE_TIMEOUT="${PI_LIVE_TIMEOUT:-45}"
SKIP_LIVE="${SKIP_LIVE:-0}"
SKIP_UNIT="${SKIP_UNIT:-0}"

PACK_DIR="$ISOLATED/pack"
EXTRACT_DIR="$ISOLATED/extract"
PROJECT_DIR="$ISOLATED/project"
SESSION_ROOT="$ISOLATED/sessions"
SHIM_DIR="$ROOT/scripts/fixtures/plan-strip-shim"
HOME_DIR="$ISOLATED/home"

PI_BIN="${PI_BIN:-}"
NODE_BIN=""
NPM_BIN=""
RG_BIN=""
ENV_BIN=""
SHELL_BIN="${BASH:-/bin/bash}"
SEALED_PATH=""
DEBUG_ENV_UNSETS=()
TOOL_ENV=()
PI_DEFAULT_ENV=()
PI_NONE_ENV=()
SELF_TEST_TEMP_DIR=""

print_help() {
	printf '%s\n' 'Isolated /tmp install smoke for pi-cursor-sdk (native replay + plan-strip resync).

Usage:
  ./scripts/isolated-cursor-smoke.sh
  SKIP_LIVE=1 ./scripts/isolated-cursor-smoke.sh
  PI_LIVE_TIMEOUT=90 ./scripts/isolated-cursor-smoke.sh

Environment:
  REPO                          Repo under test (default: script parent directory).
  ISOLATED                      Artifact root (default: /tmp/pi-cursor-sdk-isolated-<timestamp>).
  REAL_HOME                     Source for auth.json (default: $HOME).
  AUTH_JSON                     Path to pi auth.json to seed isolated HOME (default: ~/.pi/agent/auth.json).
  PI_LIVE_TIMEOUT               Per live pi check timeout in seconds (default: 45).
  PI_BIN                        Optional pi command/path to resolve from the parent PATH (default: pi).
  SKIP_LIVE=1                   Run unit tests + pack only; skip live Cursor calls.
  SKIP_UNIT=1                   Skip repo unit tests (live checks only).
  CURSOR_API_KEY                Optional fallback when auth.json lacks cursor provider.

Prerequisites:
  SKIP_LIVE=1: node, npm, env, tar on PATH; pi is not required.
  Live checks: pi, rg, python3, and ~/.pi/agent/auth.json with cursor provider OR CURSOR_API_KEY.
  Resolved node/npm/env paths from the parent shell are reused for pack-only work; live checks then resolve pi/rg.
  Pi and npm shims run with the resolved node directory first on PATH.
  Child pi runs clear Cursor SDK event-debug env. Live provider checks force PI_CURSOR_SETTING_SOURCES=none; install/list checks explicitly unset it.

Options:
  -h, --help                    Show this help.
  --self-test                   Run sealed PATH/env probes without live Cursor auth.

Exit codes:
  0  all requested checks passed
  1  prerequisite, unit, pack, live smoke, or JSONL replay validation failure'
}

log() { smoke_log "$@"; }
fail() { smoke_fail "$@"; }
seed_pi_agent_home() { smoke_seed_pi_agent_home "$@"; }
has_auth_provider() { smoke_has_auth_provider "$1" "$HOME_DIR/.pi/agent/auth.json"; }
run_with_timeout() { smoke_run_with_timeout_or_fail "$@"; }

build_smoke_env_arrays() {
	smoke_build_cursor_sdk_event_debug_unsets
	DEBUG_ENV_UNSETS=( "${SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_UNSETS[@]}" )
	TOOL_ENV=( "$ENV_BIN" "${DEBUG_ENV_UNSETS[@]}" "PATH=$SEALED_PATH" )
	PI_DEFAULT_ENV=( "$ENV_BIN" -i "${DEBUG_ENV_UNSETS[@]}" -u PI_CURSOR_SETTING_SOURCES HOME="$HOME_DIR" PATH="$SEALED_PATH" MISE_DISABLE=1 )
	PI_NONE_ENV=( "$ENV_BIN" -i "${DEBUG_ENV_UNSETS[@]}" HOME="$HOME_DIR" PATH="$SEALED_PATH" MISE_DISABLE=1 PI_CURSOR_SETTING_SOURCES=none )
}

run_in_dir() {
	local label="$1"
	local timeout_secs="$2"
	local dir="$3"
	shift 3
	run_with_timeout "$label" "$timeout_secs" "$SHELL_BIN" -c 'cd "$1" || exit 97; shift; exec "$@"' sh "$dir" "$@"
}

run_in_dir_capture_combined() {
	local label="$1"
	local timeout_secs="$2"
	local dir="$3"
	local output="$4"
	shift 4
	run_with_timeout "$label" "$timeout_secs" "$SHELL_BIN" -c 'cd "$1" || exit 97; output="$2"; shift 2; exec "$@" >"$output" 2>&1' sh "$dir" "$output" "$@"
}

run_in_dir_capture_split() {
	local label="$1"
	local timeout_secs="$2"
	local dir="$3"
	local stdout="$4"
	local stderr="$5"
	shift 5
	run_with_timeout "$label" "$timeout_secs" "$SHELL_BIN" -c 'cd "$1" || exit 97; stdout="$2"; stderr="$3"; shift 3; exec "$@" </dev/null >"$stdout" 2>"$stderr"' sh "$dir" "$stdout" "$stderr" "$@"
}

validate_replay_jsonl() {
	local dir="$1"
	"$NODE_BIN" "$ROOT/scripts/validate-smoke-jsonl.mjs" --replay-errors-only "$dir"
}

run_self_test() {
	local temp_dir bin_dir fake_pi fake_node fake_node_marker env_capture hostile_path captured_path node_dir name
	local old_path old_pi_bin old_pi_bin_was_set
	local no_pi_bin fake_npm fake_npm_marker no_pi_repo no_pi_isolated no_pi_path no_pi_output_file no_pi_status
	temp_dir="$(mktemp -d /tmp/pi-cursor-sdk-isolated-smoke-self-test.XXXXXX)"
	SELF_TEST_TEMP_DIR="$temp_dir"
	trap '[[ -z "${SELF_TEST_TEMP_DIR:-}" ]] || rm -rf "$SELF_TEST_TEMP_DIR"' EXIT
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
	if [[ "$SHELL_BIN" != /* ]]; then
		SHELL_BIN="$(smoke_resolve_cmd "$SHELL_BIN")"
	fi
	smoke_load_cursor_sdk_event_debug_env_names "$NODE_BIN" "$ROOT/shared/cursor-sdk-event-debug-env.mjs"
	hostile_path="$bin_dir:$PATH"
	old_path="$PATH"
	old_pi_bin="${PI_BIN-}"
	old_pi_bin_was_set=0
	[[ ${PI_BIN+x} ]] && old_pi_bin_was_set=1
	unset PI_BIN
	PATH="$hostile_path"
	[[ "$(smoke_resolve_cmd "${PI_BIN:-pi}")" == "$fake_pi" ]] || fail "self-test failed: default PI_BIN did not resolve through parent PATH"
	PI_BIN="$fake_pi"
	[[ "$(smoke_resolve_cmd "${PI_BIN:-pi}")" == "$fake_pi" ]] || fail "self-test failed: absolute PI_BIN was not honored"
	PATH="$old_path"
	if (( old_pi_bin_was_set )); then
		PI_BIN="$old_pi_bin"
	else
		unset PI_BIN
	fi

	[[ "$(smoke_build_sealed_node_path "$NODE_BIN" "")" != *: ]] || fail "self-test failed: empty inherited PATH left a trailing PATH separator"
	SEALED_PATH="$(smoke_build_sealed_node_path "$NODE_BIN" "$hostile_path")"
	HOME_DIR="$temp_dir/home"
	mkdir -p "$HOME_DIR"
	build_smoke_env_arrays
	node_dir="$(dirname "$NODE_BIN")"

	PI_CURSOR_SETTING_SOURCES=all \
	PI_CURSOR_SDK_EVENT_DEBUG=1 \
	PI_CURSOR_SDK_EVENT_DEBUG_DIR="$temp_dir/debug-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR="$temp_dir/debug-run-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR="$temp_dir/debug-session-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_STDERR=1 \
		"${PI_NONE_ENV[@]}" "$fake_pi" --version
	[[ ! -e "$fake_node_marker" ]] || fail "self-test failed: sealed PATH still used hostile fake node"
	captured_path="$(awk -F= '$1 == "PATH" { print substr($0, 6); exit }' "$env_capture")"
	[[ "${captured_path%%:*}" == "$node_dir" ]] || fail "self-test failed: PATH did not start with resolved node dir"
	grep -qx "HOME=$HOME_DIR" "$env_capture" || fail "self-test failed: isolated HOME was not set"
	grep -qx 'MISE_DISABLE=1' "$env_capture" || fail "self-test failed: MISE_DISABLE was not set"
	grep -qx 'PI_CURSOR_SETTING_SOURCES=none' "$env_capture" || fail "self-test failed: live pi env did not force PI_CURSOR_SETTING_SOURCES=none"
	for name in "${SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES[@]}"; do
		if grep -q "^${name}=" "$env_capture"; then
			fail "self-test failed: $name was not cleared"
		fi
	done

	PI_CURSOR_SETTING_SOURCES=all \
	PI_CURSOR_SDK_EVENT_DEBUG=1 \
	PI_CURSOR_SDK_EVENT_DEBUG_DIR="$temp_dir/debug-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_RUN_DIR="$temp_dir/debug-run-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_SESSION_DIR="$temp_dir/debug-session-dir" \
	PI_CURSOR_SDK_EVENT_DEBUG_STDERR=1 \
		"${PI_DEFAULT_ENV[@]}" "$fake_pi" --version
	if grep -q '^PI_CURSOR_SETTING_SOURCES=' "$env_capture"; then
		fail "self-test failed: default pi env did not unset PI_CURSOR_SETTING_SOURCES"
	fi
	for name in "${SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES[@]}"; do
		if grep -q "^${name}=" "$env_capture"; then
			fail "self-test failed: default pi env leaked $name"
		fi
	done

	PI_CURSOR_SDK_EVENT_DEBUG=1 \
	PI_CURSOR_SDK_EVENT_DEBUG_DIR="$temp_dir/debug-dir" \
		"${TOOL_ENV[@]}" "$fake_pi" --version
	[[ ! -e "$fake_node_marker" ]] || fail "self-test failed: tool env still used hostile fake node"
	captured_path="$(awk -F= '$1 == "PATH" { print substr($0, 6); exit }' "$env_capture")"
	[[ "${captured_path%%:*}" == "$node_dir" ]] || fail "self-test failed: tool PATH did not start with resolved node dir"
	for name in "${SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES[@]}"; do
		if grep -q "^${name}=" "$env_capture"; then
			fail "self-test failed: tool env leaked $name"
		fi
	done

	no_pi_bin="$temp_dir/no-pi-bin"
	fake_npm="$no_pi_bin/npm"
	fake_npm_marker="$temp_dir/fake-npm-pack-used"
	no_pi_repo="$temp_dir/no-pi-repo"
	no_pi_isolated="$temp_dir/no-pi-isolated"
	mkdir -p "$no_pi_bin" "$no_pi_repo"
	ln -s "$NODE_BIN" "$no_pi_bin/node"
	cat >"$fake_npm" <<EOF_SELFTEST_NPM
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" != "pack" ]]; then
	printf 'fake npm only supports pack, got: %s\\n' "\$*" >&2
	exit 64
fi
destination=""
shift
while (( \$# )); do
	case "\$1" in
		--pack-destination)
			destination="\${2:-}"
			shift 2
			;;
		*)
			shift
			;;
	esac
done
[[ -n "\$destination" ]] || { printf 'missing --pack-destination\\n' >&2; exit 64; }
mkdir -p "\$destination/.fake/package"
printf '{"name":"fake-package","version":"1.0.0"}\\n' > "\$destination/.fake/package/package.json"
tar -czf "\$destination/fake-package-1.0.0.tgz" -C "\$destination/.fake" package
printf 'pack\\n' > "$fake_npm_marker"
EOF_SELFTEST_NPM
	chmod +x "$fake_npm"
	no_pi_path="$no_pi_bin:/usr/bin:/bin"
	no_pi_output_file="$temp_dir/no-pi-output.txt"
	set +e
	env -i PATH="$no_pi_path" REAL_HOME="$temp_dir/no-auth" PI_BIN=pi-must-not-exist REPO="$no_pi_repo" ISOLATED="$no_pi_isolated" SKIP_LIVE=1 SKIP_UNIT=1 "$SHELL_BIN" "$ROOT/scripts/isolated-cursor-smoke.sh" >"$no_pi_output_file" 2>&1
	no_pi_status=$?
	set -e
	if [[ "$no_pi_status" != "0" ]]; then
		cat "$no_pi_output_file" >&2 || true
		fail "self-test failed: SKIP_LIVE=1 required pi or another live-only prerequisite"
	fi
	[[ -f "$fake_npm_marker" ]] || fail "self-test failed: no-pi SKIP_LIVE path did not run pack"
	! grep -q 'missing required command: pi' "$no_pi_output_file" || fail "self-test failed: no-pi SKIP_LIVE path still resolved pi"
	grep -q 'SKIP_LIVE=1' "$no_pi_output_file" || fail "self-test failed: no-pi SKIP_LIVE path did not reach skip-live exit"

	printf '[isolated-smoke] self-test PASS\n'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	print_help
	exit 0
fi
if [[ "${1:-}" == "--self-test" ]]; then
	run_self_test
	exit 0
fi

if [[ -f "${SECRETS_FILE:-$REAL_HOME/.secrets}" ]]; then
	set +u
	# shellcheck disable=SC1090
	source "${SECRETS_FILE:-$REAL_HOME/.secrets}"
	set -u
fi

NODE_BIN="$(smoke_resolve_node_cmd)"
NPM_BIN="$(smoke_resolve_cmd npm)"
ENV_BIN="$(smoke_resolve_cmd env)"
if [[ "$SHELL_BIN" != /* ]]; then
	SHELL_BIN="$(smoke_resolve_cmd "$SHELL_BIN")"
fi
smoke_load_cursor_sdk_event_debug_env_names "$NODE_BIN" "$ROOT/shared/cursor-sdk-event-debug-env.mjs"
SEALED_PATH="$(smoke_build_sealed_node_path "$NODE_BIN" "$PATH")"
build_smoke_env_arrays

mkdir -p "$PACK_DIR" "$EXTRACT_DIR" "$PROJECT_DIR" "$SESSION_ROOT" "$HOME_DIR"
seed_pi_agent_home "$HOME_DIR"

log "isolated root: $ISOLATED"
log "HOME=$HOME_DIR"
log "node=$NODE_BIN"
log "npm=$NPM_BIN"

if [[ "$SKIP_UNIT" != "1" ]]; then
	log "preflight: repo unit tests"
	run_in_dir "npm test" 120 "$REPO" "${TOOL_ENV[@]}" "$NPM_BIN" test
fi

log "npm pack from $REPO"
run_in_dir_capture_combined "npm pack" 120 "$REPO" "$ISOLATED/npm-pack.log" "${TOOL_ENV[@]}" "$NPM_BIN" pack --pack-destination "$PACK_DIR"
PACK_TGZ=""
for candidate in "$PACK_DIR"/*.tgz; do
	[[ -e "$candidate" ]] || continue
	if [[ -z "$PACK_TGZ" || "$candidate" -nt "$PACK_TGZ" ]]; then
		PACK_TGZ="$candidate"
	fi
done
[[ -n "$PACK_TGZ" && -f "$PACK_TGZ" ]] || fail "missing pack tarball"
tar -xzf "$PACK_TGZ" -C "$EXTRACT_DIR"
[[ -d "$EXTRACT_DIR/package" ]] || fail "extract missing package/ dir"

if [[ "$SKIP_LIVE" == "1" ]]; then
	log "SKIP_LIVE=1 — skipping live pi checks after unit + pack"
	exit 0
fi

PI_BIN="$(smoke_resolve_cmd "${PI_BIN:-pi}")"
RG_BIN="$(smoke_resolve_cmd rg)"
smoke_require_cmd python3
log "pi=$PI_BIN"
log "rg=$RG_BIN"

if ! has_auth_provider cursor && [[ -z "${CURSOR_API_KEY:-}" ]]; then
	fail "no cursor auth in $HOME_DIR/.pi/agent/auth.json and CURSOR_API_KEY unset"
fi

log "npm install packed extension deps"
run_in_dir_capture_combined "npm install --omit=dev" 120 "$EXTRACT_DIR/package" "$ISOLATED/npm-install.log" "${TOOL_ENV[@]}" "$NPM_BIN" install --omit=dev

log "pi install --approve -l (clean HOME)"
cp "$REPO/README.md" "$PROJECT_DIR/README.md"
run_in_dir_capture_combined "pi install" 30 "$PROJECT_DIR" "$ISOLATED/pi-install.log" "${PI_DEFAULT_ENV[@]}" "$PI_BIN" install --approve -l "$EXTRACT_DIR/package"

PI_LIST_OUT="$ISOLATED/pi-list.txt"
run_in_dir_capture_combined "pi list" 15 "$PROJECT_DIR" "$PI_LIST_OUT" "${PI_DEFAULT_ENV[@]}" "$PI_BIN" list --approve
"$RG_BIN" -q "extract/package" "$PI_LIST_OUT" || fail "packed extension not installed"

PI_CURSOR_ENV=( "${PI_NONE_ENV[@]}" )
if [[ -n "${CURSOR_API_KEY:-}" ]]; then
	PI_CURSOR_ENV+=( CURSOR_API_KEY="$CURSOR_API_KEY" )
fi

log "check: list-models"
LIST_OUT="$ISOLATED/list-models.txt"
run_in_dir_capture_combined "list-models" 30 "$PROJECT_DIR" "$LIST_OUT" "${PI_CURSOR_ENV[@]}" \
	"$PI_BIN" --approve --cursor-no-fast --list-models cursor
"$RG_BIN" -q "grok-4\\.6" "$LIST_OUT" || fail "grok-4.6 not listed (see $LIST_OUT)"
"$RG_BIN" -q "composer-2\\.5|composer-2-5" "$LIST_OUT" || fail "composer-2-5 not listed (see $LIST_OUT)"

log "check: basic provider prompt"
BASIC_DIR="$SESSION_ROOT/basic"
mkdir -p "$BASIC_DIR"
run_in_dir_capture_split "basic prompt" "$PI_LIVE_TIMEOUT" "$PROJECT_DIR" "$ISOLATED/basic.stdout.txt" "$ISOLATED/basic.stderr.txt" "${PI_CURSOR_ENV[@]}" \
	"$PI_BIN" --approve --cursor-no-fast --model cursor/grok-4.6 --session-dir "$BASIC_DIR" --no-tools -p 'Reply exactly: PI_CURSOR_ISOLATED_OK'
"$RG_BIN" -q "PI_CURSOR_ISOLATED_OK" "$ISOLATED/basic.stdout.txt" || fail "basic prompt missing PI_CURSOR_ISOLATED_OK"
validate_replay_jsonl "$BASIC_DIR"

log "check: native replay"
REPLAY_DIR="$SESSION_ROOT/native-replay"
mkdir -p "$REPLAY_DIR"
run_in_dir_capture_split "native replay" "$PI_LIVE_TIMEOUT" "$PROJECT_DIR" "$ISOLATED/replay.stdout.txt" "$ISOLATED/replay.stderr.txt" "${PI_CURSOR_ENV[@]}" PI_CURSOR_NATIVE_TOOL_DISPLAY=1 \
	"$PI_BIN" --approve --cursor-no-fast --model cursor/grok-4.6 --session-dir "$REPLAY_DIR" -p 'Read ./README.md briefly, then answer README_SEEN=yes if it mentions pi-cursor-sdk.'
validate_replay_jsonl "$REPLAY_DIR"

log "check: plan-strip shim (plan-mode execute reset)"
PLAN_DIR="$SESSION_ROOT/plan-strip"
mkdir -p "$PLAN_DIR"
run_in_dir_capture_split "plan-strip replay" "$PI_LIVE_TIMEOUT" "$PROJECT_DIR" "$ISOLATED/plan.stdout.txt" "$ISOLATED/plan.stderr.txt" "${PI_CURSOR_ENV[@]}" PI_CURSOR_NATIVE_TOOL_DISPLAY=1 \
	"$PI_BIN" --approve -e "$SHIM_DIR" --cursor-no-fast --model cursor/grok-4.6 --session-dir "$PLAN_DIR" -p 'After reset, read README.md and answer PLAN_STRIP_OK=yes.'
validate_replay_jsonl "$PLAN_DIR"

log "PASS isolated install smoke: $ISOLATED"
