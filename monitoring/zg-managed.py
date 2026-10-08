#!/usr/bin/python3
"""Keep established zg callers compatible with the pinned managed backend."""
import os
from pathlib import Path
import sys

arguments = sys.argv[1:]
# The pinned source uses flags for management operations. Preserve existing
# MCP configuration, scheduler and operator management commands at the boundary.
if arguments and arguments[0] in {'server', 'index', 'status', 'config', 'auth', 'install'}:
    arguments[0] = '--' + arguments[0]
elif arguments and arguments[0] == 'search':
    arguments.pop(0)
environment = os.environ.copy()
environment['ZVEC_GREP_DAEMON_AUTOSTART'] = '0'
environment['ZVEC_GREP_CPU_THREADS'] = '2'
environment['ZVEC_GREP_MODE'] = 'server'
environment.setdefault('NODE_OPTIONS', '--max-old-space-size=2048')
entry = Path.home() / '.local/share/zvec-grep/current/dist/cli/index.js'
os.execve('/home/linuxbrew/.linuxbrew/bin/node',
          ['node', '--liftoff-only', str(entry), *arguments], environment)
