#!/usr/bin/env bash
# Compile every golden sketch (crates/microflow-core/tests/golden/*.ino) with
# arduino-cli, choosing the FQBN from the filename's board prefix. Run by
# .github/workflows/sketch-compile.yml; runs locally too if arduino-cli and the
# cores/libraries it needs are installed.
set -euo pipefail

GOLDEN_DIR="$(cd "$(dirname "$0")/.." && pwd)/crates/microflow-core/tests/golden"
WORK="${GOLDEN_COMPILE_DIR:-${TMPDIR:-/tmp}/microflow-golden-compile}"

# uno_kitchen_sink deliberately does NOT compile on AVR: its Cloud Node emits
# ESP32-class network code (#include <WiFi.h>) and generation surfaces exactly
# that as a validation warning. The golden snapshots the warning path; skipping
# it here mirrors what the warning tells the Author.
SKIP=("uno_kitchen_sink")

status=0
for ino in "$GOLDEN_DIR"/*.ino; do
  name="$(basename "$ino" .ino)"
  for s in "${SKIP[@]}"; do
    if [[ "$name" == "$s" ]]; then
      echo "== $name: skipped (documented as non-compiling on its target)"
      continue 2
    fi
  done
  case "$name" in
    uno_*) fqbn="arduino:avr:uno" ;;
    esp32_*) fqbn="esp32:esp32:esp32" ;;
    *)
      echo "unknown board prefix on golden '$name'" >&2
      exit 1
      ;;
  esac
  # arduino-cli requires the sketch in a directory matching its name.
  sketch_dir="$WORK/$name"
  mkdir -p "$sketch_dir"
  cp "$ino" "$sketch_dir/$name.ino"
  echo "== $name ($fqbn)"
  if ! arduino-cli compile --fqbn "$fqbn" "$sketch_dir"; then
    echo "!! $name failed to compile" >&2
    status=1
  fi
done
exit "$status"
