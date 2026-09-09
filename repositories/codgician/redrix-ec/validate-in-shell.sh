#!/usr/bin/env bash
# Runs in a disposable archive. Build-host adaptations never enter the mirror.
set -euo pipefail
unset out
python3 - <<'PY'
from pathlib import Path
for path in Path('util').rglob('*'):
    if path.is_file() and not path.is_symlink():
        data = path.read_bytes()
        if data.startswith(b'#!/bin/bash') or data.startswith(b'#!/usr/bin/python3'):
            path.write_bytes(data.replace(b'#!/bin/bash', b'#!/usr/bin/env bash', 1)
                                 .replace(b'#!/usr/bin/python3', b'#!/usr/bin/env python3', 1))
path = Path('chip/host/uart.c')
path.write_text(path.read_text().replace('<termio.h>', '<termios.h>'))
PY
python3 "$FORKIT_CONFIG_DIR/test-backlight.py"
export ALLOW_CONFIG=1
jobs=$(nproc)
if (( jobs > 12 )); then jobs=12; fi
make -j"$jobs" BOARD=redrix out=build/redrix-forkit \
  CROSS_COMPILE="$CROSS_COMPILE" BUILDCC=gcc HOSTCC=gcc \
  EXTRA_CFLAGS='-Wno-array-bounds -Wno-address -Wno-stringop-truncation' \
  "cmd_version=python3 $FORKIT_CONFIG_DIR/version.py \$@"
make -j"$jobs" host-lid_sw host-kb_mkbp BUILDCC=gcc HOSTCC=gcc \
  CROSS_COMPILE= HOST_CROSS_COMPILE= CROSS_COMPILE_CC_NAME=gcc \
  CRYPTOC_DIR="$CRYPTOC_DIR" \
  EXTRA_CFLAGS='-Wno-array-bounds -Wno-address -Wno-stringop-truncation' \
  "cmd_version=python3 $FORKIT_CONFIG_DIR/version.py \$@"
python3 util/run_host_test.py lid_sw
python3 util/run_host_test.py kb_mkbp
python3 "$FORKIT_CONFIG_DIR/check-image.py"
