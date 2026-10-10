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



def validate_directories(paths,roots=(Path('/home/qqp'),Path('/home/linuxbrew'),Path('/tmp')),owner=OWNER):
    """Directory queries expose only reference flags for owned root-SSD trees."""
    if not isinstance(paths,list) or not 1<=len(paths)<=16:raise ValueError('directory candidate budget exceeded')
    device=Path('/').stat().st_dev;identities=[]
    for raw in paths:
        if not isinstance(raw,str) or len(raw)>2048:raise ValueError('invalid candidate path')
        p=Path(raw)
        if not p.is_absolute() or p.resolve()!=p or not any(root in p.parents for root in roots):
            raise ValueError('directory candidate outside real user roots')
        info=p.lstat()
        if info.st_uid!=owner or info.st_dev!=device or not stat.S_ISDIR(info.st_mode):
            raise ValueError('candidate is not an owned SSD directory')
        identities.append([info.st_dev,info.st_ino])
    return identities


def decode_mount_path(raw):
    # Linux mountinfo escapes whitespace and backslashes using octal sequences.
    return re.sub(rb'\\([0-7]{3})',lambda match:bytes([int(match[1],8)]),raw).decode('utf-8','surrogateescape')


def within_path(path,parent):
    # These are already normalized Path objects. Avoid allocating every parent
    # for each mapping against each mount; a separator keeps siblings distinct.
    path=str(path);parent=str(parent)
    return path==parent or path.startswith(parent.rstrip('/')+'/')


def exited_status(raw):
    # TASK_ZOMBIE/TASK_DEAD is reached after exit releases files, fs and mm.
    # An exited leader can still have live sibling threads. Without proof that
    # the group has only this task, its unavailable references remain a failure.
    fields={line.partition(b':')[0]:line.partition(b':')[2].split()
            for line in raw.splitlines() if line.startswith((b'State:',b'Threads:'))}
    return fields.get(b'State',[])[:1] in ([b'Z'],[b'X']) and fields.get(b'Threads')==[b'1']


def exited_task(task):
    """Recognize an exit race without treating a live access failure as exit."""
    try:
        with (task/'status').open('rb') as stream:raw=stream.read(32769)
        return len(raw)<=32768 and exited_status(raw)
    except OSError as error:
        return isinstance(error,FileNotFoundError) or error.errno==errno.ESRCH


def collect_directories(paths,identities,proc=PROC,seconds=25):
    """Inspect namespace-relative references without reading candidate contents."""
    candidates=[(Path(p),key[0]) for p,key in zip(paths,identities)]
    devices={key[0] for key in identities}
    blocked=set();complete=True;errors=[];deadline=time.monotonic()+seconds
    processes=fds=maps_bytes=mount_bytes=0
    mount_cache={};mount_cache_bytes=0
    def vanished(error):return isinstance(error,FileNotFoundError) or getattr(error,'errno',None)==errno.ESRCH
    def failed(reason):
        nonlocal complete
        complete=False
        if len(errors)<16:errors.append(reason[:160])
    for task in proc.iterdir():
        if not task.name.isdecimal() or int(task.name)==os.getpid():continue
        processes+=1
        if processes>8192 or time.monotonic()>deadline:
            failed('process count or time budget exceeded');break
        try:
            with (task/'status').open('rb') as stream:status=stream.read(32769)
            if len(status)>32768:failed('process status budget exceeded');break
            if b'Kthread:\t1' in status or exited_status(status):continue
            with (task/'mountinfo').open('rb') as stream:raw=stream.read(262145)
            mount_bytes+=len(raw)
            if len(raw)>262144 or mount_bytes>64*1024**2:failed('mount table budget exceeded');break
            mounts=mount_cache.get(raw)
            if mounts is None:
                mounts=[]
                for line in raw.splitlines():
                    fields=line.split()
                    if len(fields)<10 or b'-' not in fields[6:]:raise ValueError('invalid mount record')
                    major,minor=fields[2].split(b':');device=os.makedev(int(major),int(minor))
                    # nsfs roots are valid but are not filesystem paths.
                    if device not in devices:continue
                    root=Path(decode_mount_path(fields[3]));point=Path(decode_mount_path(fields[4]))
                    if not root.is_absolute() or not point.is_absolute():raise ValueError('invalid mount path')
                    mounts.append((point,root,device))
                mounts.sort(key=lambda row:len(row[0].parts),reverse=True)
                # Re-read every task's mountinfo. Reuse only byte-identical
                # parsing within this query, with a small bounded cache.
                if len(mount_cache)>=8 or mount_cache_bytes+len(raw)>1024**2:
                    mount_cache.clear();mount_cache_bytes=0
                mount_cache[raw]=mounts;mount_cache_bytes+=len(raw)
            for point,root,device in mounts:
                # A bind of a strict subtree pins that tree even with no open FD.
                for index,(candidate,wanted_device) in enumerate(candidates):
                    if device==wanted_device and within_path(root,candidate):blocked.add(index)
            inspected=set()
            def inspect(raw_path,device,inode):
                if device not in devices:return
                key=(raw_path,device,inode)
                if key in inspected:return
                if len(inspected)>=4096:inspected.clear()
                inspected.add(key)
                for index,key in enumerate(identities):
                    if [device,inode]==key:blocked.add(index)
                if raw_path.endswith(' (deleted)'):raw_path=raw_path[:-10]
                path=Path(raw_path)
                if not path.is_absolute():raise ValueError('unresolved relevant reference')
                # proc renderings can use either the inspected task's root or
                # the reader's root. Count both interpretations conservatively.
                for index,(candidate,wanted_device) in enumerate(candidates):
                    if device==wanted_device and within_path(path,candidate):blocked.add(index)
                mount=next((row for row in mounts if row[2]==device and within_path(path,row[0])),None)
                if mount is None:
                    # A process can retain an executable or mapping opened
                    # before chroot. Its proc rendering then names the reader's
                    # filesystem, even though that device is no longer mounted
                    # in the inspected task. Accept that interpretation only
                    # when its actual file identity matches the reference.
                    try:
                        physical=path.resolve(strict=True);info=physical.stat()
                    except OSError as error:
                        raise ValueError('relevant mount coverage unavailable') from error
                    if (info.st_dev,info.st_ino)!=(device,inode):
                        raise ValueError('relevant mount coverage unavailable')
                    for index,(candidate,wanted_device) in enumerate(candidates):
                        if device==wanted_device and within_path(physical,candidate):blocked.add(index)
                    return
                point,root,_=mount;physical=root/path.relative_to(point)
                for index,(candidate,wanted_device) in enumerate(candidates):
                    if device==wanted_device and within_path(physical,candidate):blocked.add(index)
            for name in ('cwd','exe'):
                try:
                    link=task/name;info=link.stat();inspect(os.readlink(link),info.st_dev,info.st_ino)
                except OSError as error:
                    if not vanished(error) and not exited_task(task):
                        failed(f'process {task.name}: {name} access unavailable')
            with (task/'maps').open('rb') as stream:raw=stream.read(2*1024**2+1)
            maps_bytes+=len(raw)
            if len(raw)>2*1024**2 or maps_bytes>32*1024**2:failed('mapping budget exceeded');break
            for line in raw.splitlines():
                fields=line.split(None,5)
                if len(fields)<5:raise ValueError('invalid map record')
                major,minor=fields[3].split(b':');device=os.makedev(int(major,16),int(minor,16));inode=int(fields[4])
                if inode:inspect(fields[5].decode('utf-8','surrogateescape') if len(fields)==6 else '',device,inode)
            for fd in (task/'fd').iterdir():
                fds+=1
                if fds>250000 or time.monotonic()>deadline:
                    failed('descriptor count or time budget exceeded');break
                try:
                    info=fd.stat();inspect(os.readlink(fd),info.st_dev,info.st_ino)
                except OSError as error:
                    if not vanished(error) and not exited_task(task):
                        failed(f'process {task.name}: descriptor access unavailable')
            if time.monotonic()>deadline:
                failed('process-reference time budget exceeded');break
            if fds>250000:break
        except OSError as error:
            if not vanished(error) and not exited_task(task):
                failed(f'process {task.name}: {error.strerror or type(error).__name__}')
        except (ValueError,OverflowError) as error:
            failed(f'process {task.name}: {error}')
    report={'complete':complete,'blocked':sorted(blocked),'identities':identities,
            'processes':processes,'fds':fds}
    if not complete:
        report['error']=errors[0];report['errors']=errors
    return report


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
            if b'Kthread:\t1' in status or exited_status(status):continue
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
        kind=request.get('kind','cached_files')
        if kind=='cached_files':validator=validate;collector=lambda paths,keys:collect(keys)
        elif kind=='ssd_directories':validator=validate_directories;collector=collect_directories
        else:raise ValueError('unrecognized reference query')
        identities=validator(request.get('paths'));report=collector(request['paths'],identities)
        if validator(request['paths'])!=identities:raise ValueError('candidate changed during inspection')
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
