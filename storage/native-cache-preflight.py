#!/usr/bin/env python3
"""Read-only native-cache preflight, restricted to the healthy sda/sdb pair.

Prints JSON and optionally saves it to an operator-selected report path. Does
not mount, format, repartition, unlock, load modules or change configuration.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess


def inspect(argv):
    try:
        result=subprocess.run(argv,capture_output=True,text=True,timeout=15)
        output=result.stdout[:65536]
        try: value=json.loads(output)
        except ValueError: value=output
        return {'returncode':result.returncode,'data':value,'error':result.stderr[:1000]}
    except (OSError,subprocess.TimeoutExpired) as error: return {'error':str(error)[:1000]}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output');args=parser.parse_args()
    if os.geteuid()!=0: raise SystemExit('Run this read-only preflight with sudo')
    uid=int(os.environ.get('SUDO_UID','0'));gid=int(os.environ.get('SUDO_GID','0'))
    home=Path(pwd.getpwuid(uid).pw_dir)
    report={'schema':1,'devices_inspected':['/dev/sda','/dev/sdb'],'nvme_excluded':True,
        'disks':inspect(['lsblk','--json','--bytes','--output','NAME,TYPE,SIZE,ROTA,FSTYPE,UUID,MOUNTPOINTS','/dev/sda','/dev/sdb']),
        'root_mount':inspect(['findmnt','--json','--target','/']),
        'hdd_mount':inspect(['findmnt','--json','--target','/srv/media-box']),
        'dm_targets':inspect(['dmsetup','targets']),
        'root_free_bytes':shutil.disk_usage('/').free,
        'hdd_free_bytes':shutil.disk_usage('/srv/media-box').free,
        'fstab':Path('/etc/fstab').read_text()[:16384],
        'existing_ssd_cache_files':inspect(['find','/var/lib/qq-media-cache','-maxdepth','1','-printf','%f %s\n'])}
    smart=shutil.which('smartctl')
    if smart:
        report['ssd_health']=inspect([smart,'--json','--health','--attributes','/dev/sda'])
        report['hdd_health']=inspect([smart,'--json','--health','--attributes','--device=sat','/dev/sdb'])
    else: report['smart_unavailable']=True
    text=json.dumps(report,indent=2)+'\n'
    if args.output:
        output=Path(args.output).expanduser().absolute()
        resolved_parent=output.parent.resolve()
        if not output.parent.exists() or not resolved_parent.is_relative_to(home.resolve()):
            raise SystemExit('report must be inside the invoking operator home in an existing directory')
        fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as f: os.fchown(f.fileno(),uid,gid);f.write(text)
        print('Saved read-only cache preflight:',output)
    else: print(text,end='')


if __name__=='__main__':main()
