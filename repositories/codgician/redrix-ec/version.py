"""Validation identity tied to the composed commit, not the historical mkbp2 image."""
import os
from pathlib import Path
import re
import sys

commit = os.environ['FORKIT_COMMIT']
if not re.fullmatch(r'[0-9a-f]{40}', commit):
    raise ValueError('Expected a composed commit SHA')
version = f'redrix-forkit-{commit[:12]}'
header = '/* Forkit validation build; not a ChromeOS release identity. */\n'
for name, value in {
    'CROS_EC_VERSION32': version,
    'CROS_ECTOOL_VERSION': version,
    'CROS_STM32MON_VERSION': version,
    'VERSION': version,
    'CROS_FWID32': version,
    'CROS_FWID_MISSING_STR': 'CROS_FWID_MISSING',
    'BUILDER': 'forkit',
    'DATE': '1970-01-01 00:00:00',
}.items():
    header += f'#define {name} "{value}"\n'
path = Path(sys.argv[1])
if not path.exists() or path.read_text() != header:
    path.write_text(header)
