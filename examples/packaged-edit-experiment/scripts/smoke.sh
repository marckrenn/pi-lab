#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

AB_RUNS_ROOT="$HOME/.pi/agent/ab/runs"
SAMPLE_FILE="smoke-test.txt"
OUTPUT_FILE="/tmp/packaged-edit-experiment-smoke.out"

cleanup() {
  rm -f "$SAMPLE_FILE"
}
trap cleanup EXIT

run_json_list() {
  if [ -d "$AB_RUNS_ROOT" ]; then
    find "$AB_RUNS_ROOT" -mindepth 3 -maxdepth 3 -type f -name run.json 2>/dev/null | sort || true
  else
    true
  fi
}

extract_run_id_from_output() {
  node - "$1" <<'NODE'
const fs = require('fs');

const path = process.argv[2];
const text = fs.readFileSync(path, 'utf8');
const matches = [...text.matchAll(/"run_id":"([^\"]+)"/g)];
if (matches.length > 0) {
  process.stdout.write(matches[matches.length - 1][1]);
}
NODE
}

run_count_before=$(run_json_list | wc -l | tr -d '[:space:]')

status_output="$(pi -e . --no-session --mode json '/ab status' 2>&1 || true)"
if ! printf '%s\n' "$status_output" | rg -q 'edit-fast'; then
  # Fallback for environments where slash-command output is not surfaced in JSON mode.
  if [ ! -f "package.json" ] || [ ! -f "experiments/edit-fast.json" ]; then
    echo "Smoke failed: cannot validate /ab status visibility and package wiring is missing." >&2
    echo "Status output was:\n$status_output" >&2
    exit 1
  fi

  package_has_extension=$(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));const ok=(p.pi && Array.isArray(p.pi.extensions) && p.pi.extensions.includes('./index.ts'));console.log(ok?'ok':'missing')" || echo missing)
  if [ "$package_has_extension" != "ok" ] || [ ! -f "index.ts" ]; then
    echo "Smoke failed: package manifest no longer exports the extension entry for index.ts." >&2
    exit 1
  fi
fi

cat > "$SAMPLE_FILE" <<'EOF'
hello
EOF

pi -e . --no-session --mode json "Please change 'hello' to 'world' in ${SAMPLE_FILE}." >"$OUTPUT_FILE" 2>&1 || {
  echo "Smoke failed: edit trigger did not run." >&2
  cat "$OUTPUT_FILE" >&2
  exit 1
}

run_id="$(extract_run_id_from_output "$OUTPUT_FILE")"

if [ -n "$run_id" ] && [ -d "$AB_RUNS_ROOT" ]; then
  run_path="$(find "$AB_RUNS_ROOT" -type d -name "$run_id" -print | head -n 1 || true)"
  if [ -n "$run_path" ] && [ -f "$run_path/run.json" ]; then
    node - "$run_path/run.json" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
const run = JSON.parse(fs.readFileSync(path, 'utf8'));
if (run.experiment_id !== 'edit-fast') {
  console.error(`Smoke failed: latest run has experiment_id '${run.experiment_id}', expected 'edit-fast'.`);
  process.exit(1);
}
if (run.intercepted_tool !== 'edit') {
  console.error(`Smoke failed: latest run intercepted_tool='${run.intercepted_tool}', expected 'edit'.`);
  process.exit(1);
}
console.log(`Smoke passed: run artifact -> ${path}`);
NODE
    exit 0
  fi
fi

# Fallback when run_id or artifact path was not directly discoverable.
run_count_after=$(run_json_list | wc -l | tr -d '[:space:]')
if [ "$run_count_after" -le "$run_count_before" ]; then
  echo "Smoke failed: no new run artifacts were created." >&2
  exit 1
fi

latest_run_json="$(find "$AB_RUNS_ROOT" -mindepth 3 -maxdepth 3 -type f -name run.json 2>/dev/null | sort | tail -n 1 || true)"
if [ -z "$latest_run_json" ]; then
  echo "Smoke failed: latest run artifact missing." >&2
  exit 1
fi

node - "$latest_run_json" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
const run = JSON.parse(fs.readFileSync(path, 'utf8'));
if (run.experiment_id !== 'edit-fast') {
  console.error(`Smoke failed: latest run has experiment_id '${run.experiment_id}', expected 'edit-fast'.`);
  process.exit(1);
}
if (run.intercepted_tool !== 'edit') {
  console.error(`Smoke failed: latest run intercepted_tool='${run.intercepted_tool}', expected 'edit'.`);
  process.exit(1);
}
console.log(`Smoke passed: run artifact -> ${path}`);
NODE