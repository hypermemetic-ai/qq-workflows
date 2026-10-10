#!/usr/bin/env python3
"""Read-only socket-activated inode reference checks for the operator's cached data."""
import errno
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import time

OWNER=1000
MOUNT=Path('/srv/qqcachedpilot')
PROC=Path('/proc')


def validate(paths,mount=MOUNT,owner=OWNER):
    if not isinstance(paths,list) or not 1<=len(paths)<=1000:raise ValueError('candidate budget exceeded')
    if not os.path.ismount(mount) or mount.stat().st_dev==Path('/').stat().st_dev:
        raise ValueError('cached data volume is unavailable')
    device=mount.stat().st_dev;identities=[]
    for raw in paths:
        if not isinstance(raw,str) or len(raw)>2048:raise ValueError('invalid candidate path')
        p=Path(raw)
        if not p.is_absolute() or mount not in p.parents or p.resolve()!=p:raise ValueError('candidate outside real cached volume')
        info=p.lstat()
        if info.st_uid!=owner or info.st_dev!=device or not stat.S_ISREG(info.st_mode):
            raise ValueError('candidate is not an owned regular cached file')
        identities.append([info.st_dev,info.st_ino])
    return identities


def collect(identities,proc=PROC,seconds=25):
    wanted={tuple(identity) for identity in identities};held=set();complete=True
    deadline=time.monotonic()+seconds;fds=0;maps_bytes=0;processes=0
    def vanished(error):return isinstance(error,FileNotFoundError) or getattr(error,'errno',None)==errno.ESRCH
    for task in proc.iterdir():
        if not task.name.isdecimal() or int(task.name)==os.getpid():continue
        processes+=1
        if processes>8192 or time.monotonic()>deadline:complete=False;break
        try:
            with (task/'status').open('rb') as f:status=f.read(32769)
            if len(status)>32768:complete=False;break
            if b'Kthread:\t1' in status:continue
            for name in ('cwd','exe'):
                try:
                    info=(task/name).stat();key=(info.st_dev,info.st_ino)
                    if key in wanted:held.add(key)
                except OSError as error:
                    if not vanished(error):complete=False
            with (task/'maps').open('rb') as f:raw=f.read(2*1024**2+1)
            maps_bytes+=len(raw)
            if len(raw)>2*1024**2 or maps_bytes>32*1024**2:complete=False;break
            for line in raw.splitlines():
                fields=line.split(None,5)
                if len(fields)<5:complete=False;break
                major,minor=fields[3].split(b':');key=(os.makedev(int(major,16),int(minor,16)),int(fields[4]))
                if key in wanted:held.add(key)
            for fd in (task/'fd').iterdir():
                fds+=1
                if fds>250000 or time.monotonic()>deadline:complete=False;break
                try:
                    info=fd.stat();key=(info.st_dev,info.st_ino)
                    if key in wanted:held.add(key)
                except OSError as error:
                    if not vanished(error):complete=False
            if not complete:break
        except OSError as error:
            if not vanished(error):complete=False;break
        except (ValueError,OverflowError):complete=False;break
    return {'complete':complete,'blocked':[n for n,key in enumerate(identities) if tuple(key) in held],
            'identities':identities,'processes':processes,'fds':fds}


def handle(connection):
    connection.settimeout(5);nonce=''
    try:
        if struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=OWNER:
            raise ValueError('operator credentials required')
        with connection.makefile('rb') as stream:raw=stream.readline(262145)
        if len(raw)>262144 or not raw.endswith(b'\n'):raise ValueError('request budget exceeded')
        request=json.loads(raw);nonce=request.get('nonce','')
        if not isinstance(nonce,str) or not re.fullmatch('[0-9a-f]{32}',nonce):raise ValueError('invalid request nonce')
        identities=validate(request.get('paths'));report=collect(identities)
        if validate(request['paths'])!=identities:raise ValueError('candidate changed during inspection')
        report['nonce']=nonce
    except (OSError,ValueError,TypeError) as error:report={'nonce':nonce,'complete':False,'error':str(error)[:160]}
    connection.sendall(json.dumps(report).encode()+b'\n')


def main():
    if os.geteuid()!=0 or os.environ.get('LISTEN_PID')!=str(os.getpid()) or os.environ.get('LISTEN_FDS')!='1':
        raise ValueError('root socket activation required')
    with socket.socket(fileno=3) as server:
        while True:
            connection,_=server.accept()
            with connection:
                try:handle(connection)
                except (OSError,ValueError):pass


if __name__=='__main__':main()
