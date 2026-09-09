"""Check the built RW image's identity and configured flash allocation."""
import os
from pathlib import Path
import subprocess

image = Path('build/redrix-forkit/RW/ec.RW.bin').read_bytes()
identity = f'redrix-forkit-{os.environ["FORKIT_COMMIT"][:12]}'.encode()
if not image or len(image) > 0x40000:
    raise ValueError(f'RW image does not fit its 256 KiB region: {len(image)} bytes')
if identity + b'\0' not in image:
    raise ValueError('RW image lacks the composed-commit identity')
symbols = subprocess.check_output([os.environ['CROSS_COMPILE'] + 'nm', 'build/redrix-forkit/RW/ec.RW.elf'], text=True)
for name in ['keyboard_backlight_sysjump_init', 'board_init_mkbp_sci']:
    if name not in symbols:
        raise ValueError(f'RW ELF lacks {name}')
print(f'PASS: RW image is {len(image)} bytes, identifies {identity.decode()}, and includes both hooks')
