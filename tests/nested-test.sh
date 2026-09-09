#!/bin/bash
# Runs the extension in a headless nested GNOME Shell with an isolated
# settings database, opens a few windows, drives it over D-Bus, exercises the
# preferences window and takes screenshots. Nothing touches the live session.
#
# Usage: tests/nested-test.sh <run-id> [basic|stage|pill|opacity|readme|dodge]
# Output: $TMPDIR/aoi-test/run-<run-id>/ (test.log, shell.log, *.png)
# Requires: gnome-shell, gjs, python3, gnome-calculator, gedit, xterm.
# The extension must be installed (make install) first.
set -u
S=$(cd "$(dirname "$0")" && pwd)
export OUT=${TMPDIR:-/tmp}/aoi-test/run-$1
export SCENARIO=${2:-basic}
export UUID=always-on-indicate@beekrbonkr.github.io
export S
rm -rf "$OUT"; mkdir -p "$OUT/config" "$OUT/data/gnome-shell/extensions"
export XDG_CONFIG_HOME="$OUT/config"
export XDG_DATA_HOME="$OUT/data"
ln -s "$HOME/.local/share/gnome-shell/extensions/$UUID" "$OUT/data/gnome-shell/extensions/"
ln -s "$S/helper/aoi-test-helper@local" "$OUT/data/gnome-shell/extensions/"
dbus-run-session -- bash "$S/inner.sh" > "$OUT/test.log" 2>&1
echo "done: $OUT"
