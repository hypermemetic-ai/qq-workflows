#!/usr/bin/env python3
"""Order the existing data volume before login and inventory remaining SSD data."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import time
import uuid

spec=importlib.util.spec_from_file_location('volume',Path(__file__).with_name('native-cache-volume.py'))
volume=importlib.util.module_from_spec(spec);spec.loader.exec_module(volume)
base=volume.base
ORDER='[Unit]\nBefore=systemd-user-sessions.service user@1000.service\n'
BROKER_LIBRARY=Path('/usr/local/lib/qq-cold-tier-refs')
BROKER_SOCKET=Path('/etc/systemd/system/qq-cold-tier-refs.socket')
BROKER_SERVICE=Path('/etc/systemd/system/qq-cold-tier-refs.service')
SOCKET_TEXT='''[Unit]
Description=Read-only cached-file process reference checks
[Socket]
ListenStream=/run/qq-cold-tier-refs/socket
SocketUser=root
SocketGroup=1000
SocketMode=0660
DirectoryMode=0755
Backlog=8
[Install]
WantedBy=sockets.target
'''


def broker_service_text(script):
    return '''[Unit]
Description=Read-only cached-file process reference collector
Requires=qq-cold-tier-refs.socket
After=qq-cold-tier-refs.socket
[Service]
Type=exec
ExecStart=/usr/bin/python3 '''+str(script)+'''
User=root
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=no
ReadOnlyPaths=/tmp
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_PTRACE CAP_CHECKPOINT_RESTORE
CPUQuota=10%
MemoryMax=128M
MemorySwapMax=0
TasksMax=4
StandardOutput=null
StandardError=journal
'''


def owned_file(path,raw,mode):
    if os.path.lexists(path):
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022 or path.read_bytes()!=raw:
            raise ValueError('Unrecognized reference collector file; preserved: '+str(path))
        return
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())


def collector_unit(script):
    """Upgrade only an intact unit pointing at a verified root-pinned release."""
    raw=broker_service_text(script).encode()
    if not os.path.lexists(BROKER_SERVICE):
        owned_file(BROKER_SERVICE,raw,0o644);return False
    info=BROKER_SERVICE.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022:
        raise ValueError('Unrecognized reference collector unit; preserved')
    with BROKER_SERVICE.open('rb') as stream:previous=stream.read(65537)
    if len(previous)>65536:raise ValueError('Unrecognized reference collector unit; preserved')
    if previous==raw:return False
    commands=[line.removeprefix('ExecStart=/usr/bin/python3 ') for line in previous.decode().splitlines()
              if line.startswith('ExecStart=/usr/bin/python3 ')]
    if len(commands)!=1:raise ValueError('Unrecognized reference collector unit; preserved')
    old=Path(commands[0])
    expected=broker_service_text(old).encode()
    legacy=expected.replace(b'PrivateTmp=no\nReadOnlyPaths=/tmp\n',b'PrivateTmp=yes\n')
    recognized=(expected,legacy,legacy.replace(b' CAP_CHECKPOINT_RESTORE',b''))
    if (old.parent.parent!=BROKER_LIBRARY or old.name!='process-reference-broker.py' or old.resolve()!=old or
        previous not in recognized):
        raise ValueError('Unrecognized reference collector unit; preserved')
    info=old.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022:
        raise ValueError('Unrecognized pinned reference collector; preserved')
    with old.open('rb') as stream:old_raw=stream.read(262145)
    if len(old_raw)>262144 or hashlib.sha256(old_raw).hexdigest()[:16]!=old.parent.name:
        raise ValueError('Pinned reference collector digest differs; preserved')
    temporary=BROKER_SERVICE.with_name('.refs-unit-'+uuid.uuid4().hex)
    try:
        owned_file(temporary,raw,0o644);os.replace(temporary,BROKER_SERVICE)
    finally:temporary.unlink(missing_ok=True)
    fd=os.open(BROKER_SERVICE.parent,os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
    return True


def reference_collector():
    raw=Path(__file__).with_name('process-reference-broker.py').read_bytes()
    base.private_directory(BROKER_LIBRARY)
    release=BROKER_LIBRARY/hashlib.sha256(raw).hexdigest()[:16];base.private_directory(release)
    script=release/'process-reference-broker.py';owned_file(script,raw,0o600)
    owned_file(BROKER_SOCKET,SOCKET_TEXT.encode(),0o644)
    upgraded=collector_unit(script)
    base.run('systemctl','daemon-reload')
    base.run('systemctl','enable','--now',BROKER_SOCKET.name)
    if upgraded:base.run('systemctl','try-restart',BROKER_SERVICE.name)
    if base.run('systemctl','is-active',BROKER_SOCKET.name).strip()!='active':
        raise ValueError('Read-only reference collector socket did not activate')
    return {'socket':'/run/qq-cold-tier-refs/socket','checks':'open descriptors and mapped file identities across process namespaces',
            'permissions':'read-only; owned cached regular files or owned SSD user directories; no candidate contents read',
            'directory_queries':True,'upgraded':upgraded}


def reference_smoke(path):
    """Require an actual complete host scan, not just successful installation."""
    client='''import json,socket,sys,uuid
from pathlib import Path
path=Path(sys.argv[1]);nonce=uuid.uuid4().hex
identity=[path.stat().st_dev,path.stat().st_ino]
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
    connection.settimeout(35);connection.connect('/run/qq-cold-tier-refs/socket')
    connection.sendall(json.dumps(dict(nonce=nonce,paths=[str(path)],kind='ssd_directories')).encode()+b'\\n')
    raw=connection.makefile('rb').readline(262145)
if len(raw)>262144:raise SystemExit('reference smoke response budget exceeded')
report=json.loads(raw)
if report.get('nonce')!=nonce or report.get('identities')!=[identity]:raise SystemExit('reference smoke identity differs')
print(json.dumps(report))
'''
    result=subprocess.run(['/usr/sbin/runuser','--user',pwd.getpwuid(volume.OWNER).pw_name,'--',
                           '/usr/bin/python3','-c',client,str(path)],capture_output=True,text=True,timeout=45)
    if result.returncode:raise RuntimeError('Reference smoke failed: '+(result.stderr or result.stdout)[-1500:])
    raw=result.stdout
    if len(raw.encode())>262144:raise ValueError('Reference smoke response budget exceeded')
    report=json.loads(raw)
    if report.get('complete') is not True:
        reason=report.get('error','process reference coverage incomplete')
        raise ValueError('Reference collector host check failed: '+str(reason)[:160])
    return {key:report[key] for key in ('complete','processes','fds')}


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
    report={'timestamp':time.time(),'boot_order':boot_order(),'reference_collector':reference_collector()}
    report['reference_collector']['host_scan']=reference_smoke(output.parent.resolve())
    report['ssd_census']=census()
    base.atomic_json(output,report,volume.OWNER,volume.OWNER)
    print('Volume ordered before login. No running applications or volume were restarted.')
    print('Saved SSD census:',output)
    return 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as e:raise SystemExit(str(e))
