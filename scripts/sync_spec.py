#!/usr/bin/env python3
"""Regenerate contracts, merged prose, validation report and hashes together."""
from pathlib import Path
import subprocess
import sys
import hashlib

root = Path(__file__).resolve().parents[1]
spec = root / 'spec'
for script in ('generate_contracts.py', 'generate_tools_examples.py'):
    subprocess.run([sys.executable, str(spec / 'scripts' / script)], check=True)
merged = (spec / 'PROJECT_SPEC.md').read_text()
prefix = merged.split('# 第一部分：项目规格')[0]
parts = [('第一部分：项目规格', 'SPEC.md'), ('第二部分：详细协议', 'PROTOCOLS.md'),
         ('第三部分：源码调研', 'RESEARCH.md'), ('第四部分：验收标准', 'ACCEPTANCE.md'),
         ('第五部分：工程任务', 'IMPLEMENTATION_PLAN.md')]
(spec / 'PROJECT_SPEC.md').write_text(prefix + '\n\n---\n\n'.join(
    '# ' + title + '\n\n' + (spec / path).read_text().strip() for title, path in parts) + '\n')
subprocess.run([sys.executable, str(spec / 'scripts' / 'validate.py')], check=True)
paths = [line.split('  ', 1)[1] for line in (spec / 'SHA256SUMS').read_text().splitlines()]
(spec / 'SHA256SUMS').write_text(''.join(
    hashlib.sha256((spec / path).read_bytes()).hexdigest() + '  ' + path + '\n' for path in paths))
