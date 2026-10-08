#!/usr/bin/env python3
"""Install a versioned local monitoring release; preserve private configuration."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def main():
    source = Path(__file__).resolve().parent
    home = Path.home()
    config = home / '.config/qq-host-monitor'
    state = home / '.local/state/qq-host-monitor'
    storage = home / '.local/share/qq-host-monitor'
    os.umask(0o077)
    # Establish activation prerequisites before changing the installed release.
    subprocess.run(['systemctl', '--user', 'show-environment'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'], check=True)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    files = ('host-health.py', 'alert-bridge.py', 'investigator-AGENTS.md')
    digest = hashlib.sha256(b''.join((source / name).read_bytes() for name in files)).hexdigest()
    release = storage / 'releases' / (commit[:12] + '-' + digest[:12])
    for path in (config, state, release, state / 'investigator'):
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(0o700)
    for name in files:
        shutil.copyfile(source / name, release / name)
        (release / name).chmod(0o600)
    (release / 'receipt.json').write_text(json.dumps({'source_commit': commit,
        'sha256': {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in files}}, indent=2) + '\n')
    shutil.copyfile(source / 'investigator-AGENTS.md', state / 'investigator/AGENTS.md')
    for name, example in (('collector.json', 'collector-policy.example.json'), ('bridge.json', 'bridge.example.json')):
        target = config / name
        if not target.exists():
            shutil.copyfile(source / example, target)
        target.chmod(0o600)
    export = state / 'export'
    export.mkdir(exist_ok=True)
    export.chmod(0o755)
    # Mount this directory, since the bridge replaces the metrics file atomically.
    metrics = export / 'metrics.prom'
    if not metrics.exists():
        metrics.write_text('# Waiting for host collector\n')
        metrics.chmod(0o644)
    units = home / '.config/systemd/user'
    units.mkdir(parents=True, exist_ok=True)
    for name in ('qq-host-health.service', 'qq-host-alerts.service'):
        shutil.copyfile(source / name, units / name)
    netdata = storage / 'netdata'
    netdata.mkdir(parents=True, exist_ok=True)
    for name in ('compose.yaml', 'netdata.conf', 'prometheus.conf'):
        shutil.copyfile(source / name, netdata / name)
    link = storage / '.current-new'
    link.unlink(missing_ok=True)
    link.symlink_to(release)
    link.replace(storage / 'current')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', 'qq-host-health.service', 'qq-host-alerts.service'], check=True)
    subprocess.run(['systemctl', '--user', 'restart', 'qq-host-health.service', 'qq-host-alerts.service'], check=True)
    env = os.environ.copy()
    env['MONITOR_EXPORT_DIR'] = str(export)
    subprocess.run(['docker', 'compose', 'up', '-d'], cwd=netdata, env=env, check=True)
    subprocess.run(['docker', 'restart', 'qq-netdata'], check=True, stdout=subprocess.DEVNULL)
    print('Installed monitoring release', release.name)
    print('Netdata: http://127.0.0.1:19999; private state:', state)


if __name__ == '__main__':
    main()
