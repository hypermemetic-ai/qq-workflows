#!/usr/bin/env python3
"""Install only the cold-tier services. No existing application restarts."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

os.umask(0o077)
source = Path(__file__).resolve().parent
home = Path.home()
subprocess.run(['systemctl','--user','show-environment'],check=True,stdout=subprocess.DEVNULL)
commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
digest = hashlib.sha256((source/'cold-tier.py').read_bytes()).hexdigest()
storage = home/'.local/share/qq-cold-tier'
release = storage/'releases'/(commit[:12]+'-'+digest[:12])
release.mkdir(parents=True,exist_ok=True); release.chmod(0o700)
shutil.copyfile(source/'cold-tier.py',release/'cold-tier.py')
(release/'receipt.json').write_text(json.dumps({'commit':commit,'sha256':digest})+'\n')
link = storage/'.new-current'; link.unlink(missing_ok=True); link.symlink_to(release); link.replace(storage/'current')
units = home/'.config/systemd/user'; units.mkdir(parents=True,exist_ok=True)
for name in ('qq-cold-tier.service','qq-cold-tier-migrate.service','qq-cold-tier-migrate.timer'):
    shutil.copyfile(source/name,units/name)
binpath=home/'.local/bin/qq-cold-tier'
binpath.write_text('#!/bin/sh\nexec /usr/bin/python3 "$HOME/.local/share/qq-cold-tier/current/cold-tier.py" "$@"\n'); binpath.chmod(0o700)
subprocess.run([str(binpath),'init'],check=True)
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now','qq-cold-tier.service','qq-cold-tier-migrate.timer'],check=True)
print('Installed cold-tier release', release.name)
