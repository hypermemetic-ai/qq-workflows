#!/usr/bin/env python3
"""Install only the cold-tier services. No existing application restarts."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess

os.umask(0o077)
source = Path(__file__).resolve().parent
home = Path.home()
subprocess.run(['systemctl','--user','show-environment'],check=True,stdout=subprocess.DEVNULL)
commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
files=('cold-tier.py','native-cache-preflight.py','native-cache-trial.py','native-cache-git-pilot.py','native-cache-startup.py')
digest = hashlib.sha256(b''.join((source/name).read_bytes() for name in files)).hexdigest()
storage = (home/'.local/share/qq-cold-tier').resolve()
state = (home/'.local/state/qq-cold-tier').resolve()
release = storage/'releases'/(commit[:12]+'-'+digest[:12])
release.mkdir(parents=True,exist_ok=True); release.chmod(0o700)
for name in files: shutil.copyfile(source/name,release/name)
(release/'receipt.json').write_text(json.dumps({'commit':commit,'sha256':{name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in files}})+'\n')
link = storage/'.new-current'; link.unlink(missing_ok=True); link.symlink_to(release); link.replace(storage/'current')
units = home/'.config/systemd/user'; units.mkdir(parents=True,exist_ok=True)
for name in ('qq-cold-tier.service','qq-cold-tier-migrate.service','qq-cold-tier-migrate.timer'):
    content=(source/name).read_text()
    content=content.replace('%h/.local/share/qq-cold-tier/current/cold-tier.py',
                           str(storage/'current/cold-tier.py')+' --state-dir '+str(state))
    (units/name).write_text(content)
binpath=home/'.local/bin/qq-cold-tier'
binpath.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(storage/'current/cold-tier.py'))+
                   ' --state-dir '+shlex.quote(str(state))+' "$@"\n'); binpath.chmod(0o700)
preflight=home/'.local/bin/qq-cold-tier-preflight'
preflight.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(storage/'current/native-cache-preflight.py'))+
                    ' --output '+shlex.quote(str(state/'native-preflight.json'))+' "$@"\n');preflight.chmod(0o700)
trial=home/'.local/bin/qq-cold-tier-trial'
trial.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(storage/'current/native-cache-trial.py'))+
                ' --output '+shlex.quote(str(state/'native-trial.json'))+' "$@"\n');trial.chmod(0o700)
pilot=home/'.local/bin/qq-cold-tier-pilot'
pilot.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(storage/'current/native-cache-trial.py'))+
                ' --application-pilot --output '+shlex.quote(str(state/'native-pilot.json'))+' "$@"\n');pilot.chmod(0o700)
startup=home/'.local/bin/qq-cold-tier-startup-test'
startup.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(storage/'current/native-cache-startup.py'))+
                  ' --output '+shlex.quote(str(state/'native-startup.json'))+' "$@"\n');startup.chmod(0o700)
subprocess.run([str(binpath),'init'],check=True)
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now','qq-cold-tier.service','qq-cold-tier-migrate.timer'],check=True)
print('Installed cold-tier release', release.name)
