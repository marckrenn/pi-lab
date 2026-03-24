#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/packaged-edit-experiment"

PACK_FILE=""
CURRENT_PACK_LIST=""

cleanup() {
  if [ -n "${PACK_FILE}" ] && [ -f "${PACK_FILE}" ]; then
    rm -f "${PACK_FILE}"
  fi
  if [ -n "${CURRENT_PACK_LIST}" ] && [ -f "${CURRENT_PACK_LIST}" ]; then
    rm -f "${CURRENT_PACK_LIST}"
  fi
}
trap cleanup EXIT

log() {
  printf '[release-dry-run] %s\n' "$*"
}

fail() {
  printf '[release-dry-run] ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Required command '$cmd' not found."
  fi
}

extract_pack_field() {
  local json="$1"
  local field="$2"
  local json_file

  json_file="$(mktemp)"
  printf '%s' "$json" >"$json_file"

  node - "$json_file" "$field" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const field = process.argv[3];

const raw = fs.readFileSync(file, 'utf8').trim();
if (!raw) {
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (_error) {
  process.exit(1);
}

const entry = Array.isArray(data) ? data[0] : data;
if (!entry || typeof entry !== 'object' || typeof entry[field] === 'undefined') {
  process.exit(1);
}

process.stdout.write(String(entry[field]));
NODE

  rm -f "$json_file"
}

run_pack_checks() {
  local pack_json

  log "Running npm pack --json"
  if ! pack_json="$(npm pack --json)"; then
    fail "npm pack --json failed."
  fi

  PACK_FILE="$(extract_pack_field "$pack_json" filename || true)"
  if [ -z "${PACK_FILE}" ]; then
    fail "Could not extract packed filename from npm pack output."
  fi

  if [ ! -f "$PACK_FILE" ]; then
    fail "Packed tarball '$PACK_FILE' was not created."
  fi

  CURRENT_PACK_LIST="$(mktemp)"
  log "Inspecting pack contents in $PACK_FILE"

  tar -tzf "$PACK_FILE" >"$CURRENT_PACK_LIST" || fail "Could not list tarball contents for $PACK_FILE"

  if ! grep -Fxq 'package/index.ts' "$CURRENT_PACK_LIST"; then
    fail "Missing expected file 'package/index.ts' in packed artifact."
  fi
  if ! grep -Fxq 'package/pi-extension/ab/index.ts' "$CURRENT_PACK_LIST"; then
    fail "Missing expected file 'package/pi-extension/ab/index.ts' in packed artifact."
  fi

  log "Pack content checks passed for $PACK_FILE"
  rm -f "$CURRENT_PACK_LIST"
  CURRENT_PACK_LIST=""
  rm -f "$PACK_FILE"
  PACK_FILE=""
}

run_dry_run_checks() {
  local dry_json
  local dry_name
  local dry_version
  local expected_name
  local expected_version

  log "Running npm pack --dry-run --json"
  if ! dry_json="$(npm pack --dry-run --json)"; then
    fail "npm pack --dry-run --json failed."
  fi

  dry_name="$(extract_pack_field "$dry_json" name || true)"
  dry_version="$(extract_pack_field "$dry_json" version || true)"

  if [ -z "$dry_name" ]; then
    fail "Could not extract 'name' from npm pack --dry-run output."
  fi
  if [ -z "$dry_version" ]; then
    fail "Could not extract 'version' from npm pack --dry-run output."
  fi

  expected_name="$(node -p "require('./package.json').name")"
  expected_version="$(node -p "require('./package.json').version")"

  if [ "$dry_name" != "$expected_name" ]; then
    fail "Pack metadata name mismatch: expected '$expected_name', got '$dry_name'."
  fi
  if [ "$dry_version" != "$expected_version" ]; then
    fail "Pack metadata version mismatch: expected '$expected_version', got '$dry_version'."
  fi

  log "Pack metadata checks passed: $dry_name@$dry_version"
}

run_example_smoke() {
  local require_smoke="${RELEASE_DRY_RUN_REQUIRE_EXAMPLE_SMOKE:-0}"

  if [ ! -d "$EXAMPLE_DIR" ]; then
    if [ "$require_smoke" = "1" ]; then
      fail "Example smoke test directory '$EXAMPLE_DIR' is missing."
    fi
    log "Skipping example smoke test (directory missing)."
    return 0
  fi

  if [ ! -x "$EXAMPLE_DIR/node_modules/.bin/pi" ] && [ ! -x "$ROOT_DIR/node_modules/.bin/pi" ]; then
    if [ "$require_smoke" = "1" ]; then
      fail "Example smoke dependencies are missing. Run 'npm ci' in examples/packaged-edit-experiment or set RELEASE_DRY_RUN_REQUIRE_EXAMPLE_SMOKE=0 to allow skip."
    fi
    log "Skipping example smoke test (pi executable not installed for example run)."
    return 0
  fi

  log "Running packaged-edit-experiment smoke test"
  (cd "$EXAMPLE_DIR" && PATH="$PWD/node_modules/.bin:$ROOT_DIR/node_modules/.bin:$PATH" npm run smoke) || fail "Example smoke test failed."
}

main() {
  log "Starting release dry-run checks"

  require_cmd npm
  require_cmd node
  require_cmd tar

  cd "$ROOT_DIR"

  run_pack_checks
  run_dry_run_checks
  npm run typecheck
  npm test
  run_example_smoke

  log "Release dry-run checks passed"
}

main
