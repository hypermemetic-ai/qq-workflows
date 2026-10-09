#!/usr/bin/env python3
"""Order the existing data volume before login and inventory remaining SSD data."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import time
import uuid

spec=importlib.util.spec_from_file_location('volume',Path(__file__).with_name('native-cache-volume.py'))
volume=importlib.util.module_from_spec(spec);spec.loader.exec_module(volume)
base=volume.base
ORDER='[Unit]\nBefore=systemd-user-sessions.service user@1000.service\n'


def boot_order():
    unit=volume.UNIT
    info=unit.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022:
        raise ValueError('Unrecognized volume service; preserved')
    volume.verify_managed_unit(unit.read_text())
    folder=unit.with_name(unit.name+'.d')
    base.private_directory(folder)
    path=folder/'20-before-user-data.conf'
    if os.path.lexists(path):
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022 or path.read_text()!=ORDER:
            raise ValueError('Unrecognized ordering drop-in; preserved')
    else:
        temporary=folder/('.order-'+uuid.uuid4().hex)
        try:
            fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
            with os.fdopen(fd,'w') as f:f.write(ORDER);f.flush();os.fsync(f.fileno())
            os.link(temporary,path)
        finally:temporary.unlink(missing_ok=True)
        fd=os.open(folder,os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    base.run('systemctl','daemon-reload')
    before=base.run('systemctl','show',volume.SERVICE,'--property=Before','--value').split()
    if not {'systemd-user-sessions.service','user@1000.service'}<=set(before):
        raise ValueError('Volume ordering was not loaded')
    return {'drop_in':str(path),'before':before,'applies_to':'future starts; no running service restarted'}


def census():
    # Depth bounds output; root privileges remove the inaccessible-directory gaps.
    result=subprocess.run(['ionice','-c','3','du','-x','-B1','--max-depth=2','/home','/var','/tmp','/opt'],
                          capture_output=True,text=True,timeout=600)
    if len(result.stdout.encode())>262144 or len(result.stderr.encode())>262144:
        raise ValueError('System census exceeded its output bound')
    rows=[]
    for line in result.stdout.splitlines():
        size,separator,path=line.partition('\t')
        if separator and size.isdecimal():rows.append({'bytes':int(size),'path':path})
    return {'complete':result.returncode==0,'rows':sorted(rows,key=lambda r:r['bytes'],reverse=True),
            'errors':result.stderr[-4096:]}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',required=True)
    parser.add_argument('--worker',action='store_true');args=parser.parse_args()
    if os.geteuid()!=0 or (not args.worker and int(os.environ.get('SUDO_UID','0'))!=volume.OWNER):
        raise ValueError('Invoke through the operator sudo wrapper')
    output=base.output_path(args.output,volume.OWNER)
    if not args.worker:
        command=['systemd-run','--quiet','--collect','--scope','--unit=qq-storage-system-prepare',
                 '--property=CPUQuota=10%','--property=MemoryMax=512M','--property=MemorySwapMax=0',
                 '--property=TasksMax=16','--property=IOWeight=10',
                 '/usr/bin/python3',str(Path(__file__).resolve()),'--worker','--output',str(output)]
        return subprocess.run(command,timeout=660).returncode
    os.umask(0o077);base.verified_host_mounts();volume.read_manifest()
    report={'timestamp':time.time(),'boot_order':boot_order(),'ssd_census':census()}
    base.atomic_json(output,report,volume.OWNER,volume.OWNER)
    print('Volume ordered before login. No running applications or volume were restarted.')
    print('Saved SSD census:',output)
    return 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as e:raise SystemExit(str(e))
