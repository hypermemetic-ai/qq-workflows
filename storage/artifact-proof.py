"""Recognize published Cargo archives; never infer disposability from folder names."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import urllib.request

SCHEMA = 'verified-files-v1'
RECIPE = SCHEMA + ': Cargo redownloads published crates.io archives with the recorded SHA256'
ARCHIVE = re.compile(r'([A-Za-z][A-Za-z0-9_-]{0,63})-([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?)\.crate')


def identity(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('registry redirect refused')


def checksums(name, deadline):
    lower = name.lower()
    prefix = '1' if len(lower)==1 else '2' if len(lower)==2 else '3/'+lower[0] if len(lower)==3 else lower[:2]+'/'+lower[2:4]
    url = 'https://index.crates.io/'+prefix+'/'+lower
    request = urllib.request.Request(url, headers={'User-Agent':'qq-cold-tier/1'})
    rows = {}; total = 0
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=min(10,max(.1,deadline-time.monotonic()))) as response:
        for _ in range(20000):
            if time.monotonic() >= deadline: raise TimeoutError('verification time budget exhausted')
            line = response.readline(262145); total += len(line)
            if len(line)>262144 or total>8*1024**2: raise ValueError('registry metadata budget exceeded')
            if not line: return rows
            row = json.loads(line)
            if not isinstance(row,dict):raise ValueError('invalid registry record')
            if row.get('name')!=name: continue
            digest = row.get('cksum',''); version = row.get('vers')
            if isinstance(version,str) and isinstance(digest,str) and re.fullmatch('[0-9a-f]{64}',digest):
                if version in rows: raise ValueError('duplicate published version')
                rows[version] = digest
    raise ValueError('registry record budget exceeded')


def digest_file(path, budget, deadline):
    fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_size>256*1024**2:
            raise ValueError('archive is not a bounded owned regular file')
        digest = hashlib.sha256()
        with os.fdopen(fd,'rb',closefd=False) as f:
            while True:
                if time.monotonic()>=deadline: raise TimeoutError('verification time budget exhausted')
                block = f.read(262144)
                if not block: break
                digest.update(block); budget.account(len(block))
        if identity(before)!=identity(os.fstat(fd)) or identity(before)!=identity(path.lstat()):
            raise ValueError('archive changed during verification')
        return digest.hexdigest(), identity(before)
    finally: os.close(fd)


def verify(store,cfg,tier,max_files=100,seconds=60):
    if type(max_files)!=int or not 1<=max_files<=1000 or type(seconds)!=int or not 1<=seconds<=300:
        raise ValueError('artifact verification budgets are out of range')
    deadline = time.monotonic()+seconds; summary={'checked':0,'verified':0,'retained':0,'errors':[]}
    budget=tier.ReadBudget(cfg['verify_bytes_per_second'])
    for root in store.roots():
        if root['location']!='hdd' or Path(root['source']).name!='registry': continue
        target=Path(root['target']); relative=Path('cache/index.crates.io-1949cf8c6b5b557f'); base=target/relative
        if Path(root['source']).resolve()!=target or base.resolve()!=base or not base.is_dir() or tier.excluded_unit(base,cfg):continue
        proof=store.state/('cargo-proof-'+root['id']+'.json'); old={}
        scope=store.db.execute('SELECT * FROM scopes WHERE root=? AND path=?',(root['id'],str(relative))).fetchone()
        if scope:
            if scope['recipe']!=RECIPE or scope['proof']!=str(proof):continue  # Preserve operator declarations.
            if proof.exists() and tier.proof_digest(proof)==scope['digest']:
                old=tier.bounded_json(proof,1024**2).get('files',{})
        names=[]
        for path in base.iterdir():
            names.append(path.name)
            if len(names)>10000:break
        if len(names)>10000: summary['errors'].append('Cargo archive entry budget exceeded');continue
        names.sort()
        cursor=store.get('cargo-proof-cursor-'+root['id'],''); ordered=[n for n in names if n>cursor]+[n for n in names if n<=cursor]
        records=dict(old); metadata={}
        for name in ordered:
            if summary['checked']>=max_files or time.monotonic()>=deadline:break
            match=ARCHIVE.fullmatch(name); path=base/name
            if not match:continue
            summary['checked']+=1;store.put('cargo-proof-cursor-'+root['id'],name)
            try:
                info=path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid():raise ValueError('archive is not an owned regular file')
                if old.get(name,{}).get('identity')==identity(info):
                    summary['verified']+=1;continue
                crate,version=match.groups()
                if crate not in metadata:metadata[crate]=checksums(crate,deadline)
                expected=metadata[crate].get(version)
                if not expected:raise ValueError('archive version not established by crates.io')
                digest,info_key=digest_file(path,budget,deadline)
                if digest!=expected:raise ValueError('archive differs from published checksum')
                records[name]={'identity':info_key,'sha256':digest,'verified_at':time.time(),
                               'download':'https://static.crates.io/crates/'+crate+'/'+name}
                summary['verified']+=1
            except (OSError,ValueError,TimeoutError) as e:
                records.pop(name,None);summary['retained']+=1
                if len(summary['errors'])<10:summary['errors'].append(name+': '+str(e)[:160])
        records={name:row for name,row in records.items() if name in names}
        if records and (records!=old or not scope):
            value={'schema':SCHEMA,'scope':str(relative),'files':records}
            if len(json.dumps(value).encode())>1024**2:raise ValueError('artifact proof budget exceeded')
            tier.atomic_json(proof,value);tier.record_scope(store,root['id'],str(relative),RECIPE,proof)
    store.put('last_artifact_verification',dict(summary,timestamp=time.time()));store.db.commit()
    return summary
