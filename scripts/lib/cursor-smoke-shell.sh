# Shared maintainer smoke shell helpers (timeout, logging, auth seeding).
# Source from top-level smoke scripts: . "$(dirname "$0")/lib/cursor-smoke-shell.sh"

: "${SMOKE_LOG_PREFIX:=smoke}"
SMOKE_KILL_GRACE_SECS="${SMOKE_KILL_GRACE_SECS:-2}"
SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES=()
SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_UNSETS=()

smoke_log() {
	printf '[%s] %s\n' "$SMOKE_LOG_PREFIX" "$*"
}

smoke_fail() {
	printf '[%s] FAIL: %s\n' "$SMOKE_LOG_PREFIX" "$*" >&2
	exit 1
}

smoke_require_cmd() {
	command -v "$1" >/dev/null 2>&1 || smoke_fail "missing required command: $1"
}

smoke_resolve_cmd() {
	local name="$1"
	local path
	if ! path="$(command -v -- "$name" 2>/dev/null)" || [[ -z "$path" ]]; then
		smoke_fail "missing required command: $name"
	fi
	if [[ "$path" != /* ]]; then
		smoke_fail "required command $name did not resolve to an absolute path: $path"
	fi
	printf '%s\n' "$path"
}

smoke_resolve_node_cmd() {
	local node_cmd node_path
	node_cmd="$(smoke_resolve_cmd node)"
	if ! node_path="$("$node_cmd" -p 'process.execPath' 2>/dev/null)" || [[ -z "$node_path" ]]; then
		smoke_fail "failed to resolve real node executable from $node_cmd"
	fi
	if [[ "$node_path" != /* ]]; then
		smoke_fail "real node executable did not resolve to an absolute path: $node_path"
	fi
	printf '%s\n' "$node_path"
}

smoke_build_sealed_node_path() {
	local node_bin="$1"
	local base_path
	if (( $# >= 2 )); then
		base_path="$2"
	else
		base_path="$PATH"
	fi
	if [[ -n "$base_path" ]]; then
		printf '%s:%s\n' "$(dirname "$node_bin")" "$base_path"
	else
		printf '%s\n' "$(dirname "$node_bin")"
	fi
}

smoke_load_cursor_sdk_event_debug_env_names() {
	local node_bin="$1"
	local module_path="$2"
	local name
	SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES=()
	while IFS= read -r name; do
		[[ -n "$name" ]] || continue
		SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES+=( "$name" )
	done < <("$node_bin" --input-type=module -e 'import { pathToFileURL } from "node:url"; const mod = await import(pathToFileURL(process.argv[1]).href); for (const name of mod.CURSOR_SDK_EVENT_DEBUG_ENV_NAMES) console.log(name);' "$module_path")
	if [[ "${#SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES[@]}" -eq 0 ]]; then
		smoke_fail "failed to load Cursor SDK event-debug env names from $module_path"
	fi
}

smoke_build_cursor_sdk_event_debug_unsets() {
	local name
	SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_UNSETS=()
	for name in "${SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_NAMES[@]}"; do
		SMOKE_CURSOR_SDK_EVENT_DEBUG_ENV_UNSETS+=( -u "$name" )
	done
}

# Run a command with a wall-clock timeout: TERM, then KILL after SMOKE_KILL_GRACE_SECS if the
# command is still running. Prefer GNU/BSD timeout; fall back to a process-group kill watcher.
smoke_run_with_timeout() {
	local timeout_secs="$1"
	shift
	if command -v timeout >/dev/null 2>&1; then
		timeout -k "$SMOKE_KILL_GRACE_SECS" "$timeout_secs" "$@"
		return $?
	fi
	if command -v gtimeout >/dev/null 2>&1; then
		gtimeout -k "$SMOKE_KILL_GRACE_SECS" "$timeout_secs" "$@"
		return $?
	fi

	local restore_monitor=0
	case $- in
		*m*) ;;
		*)
			restore_monitor=1
			set -m
			;;
	esac

	"$@" &
	local pid=$!
	(
		sleep "$timeout_secs"
		kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
		sleep "$SMOKE_KILL_GRACE_SECS"
		kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
	) &
	local watcher=$!
	local code=0
	if wait "$pid"; then
		code=0
	else
		code=$?
	fi
	# Under set -m the watcher leads its own process group; kill the group so its sleep goes too.
	kill -- "-$watcher" 2>/dev/null || kill "$watcher" 2>/dev/null || true
	wait "$watcher" 2>/dev/null || true
	if (( restore_monitor )); then
		set +m
	fi
	return "$code"
}

# Run with timeout; map exit 124/137/143 to a smoke_fail timeout message.
smoke_run_with_timeout_or_fail() {
	local label="$1"
	local timeout_secs="$2"
	shift 2
	smoke_log "$label (timeout ${timeout_secs}s)"
	local restore_errexit=0
	case $- in
		*e*)
			restore_errexit=1
			set +e
			;;
	esac
	local rc=0
	smoke_run_with_timeout "$timeout_secs" "$@"
	rc=$?
	if (( restore_errexit )); then
		set -e
	fi
	if [[ "$rc" -eq 0 ]]; then
		return 0
	fi
	case "$rc" in
		124|137|143) smoke_fail "$label timed out after ${timeout_secs}s" ;;
		*) smoke_fail "$label exited $rc" ;;
	esac
}

smoke_seed_pi_agent_home() {
	local home="$1"
	local auth_json="${2:-${AUTH_JSON:-${REAL_HOME:-$HOME}/.pi/agent/auth.json}}"
	local models_src="${3:-${PI_AGENT_DIR:-${REAL_HOME:-$HOME}/.pi/agent}/models.json}"
	mkdir -p "$home/.pi/agent"
	if [[ -f "$auth_json" ]]; then
		cp "$auth_json" "$home/.pi/agent/auth.json"
		chmod 600 "$home/.pi/agent/auth.json"
		smoke_log "seeded $home/.pi/agent/auth.json"
	else
		smoke_log "WARN: no auth.json at $auth_json"
	fi
	if [[ -f "$models_src" ]]; then
		cp "$models_src" "$home/.pi/agent/models.json"
	fi
}

smoke_has_auth_provider() {
	local provider="$1"
	local auth_path="$2"
	python3 - "$provider" "$auth_path" <<'PY'
import json, sys
provider, path = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path))
except FileNotFoundError:
    sys.exit(1)
sys.exit(0 if provider in data and data[provider] else 1)
PY
}
