#!/usr/bin/env python3
"""Install reviewed job containment and its narrow ongoing-test fallback."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess


FILES = {
    'scripts/qq-job.py': 'qq-job.py',
    'monitoring/job-pressure-guard.py': 'job-pressure-guard.py',
    'monitoring/qq-job-pressure-guard.service': 'qq-job-pressure-guard.service',
    'config/qq-job/qqjobs.slice': 'qqjobs.slice',
    'config/qq-job/policy.example.json': 'policy.example.json',
    'config/qq-job/pressure-guard.example.json': 'pressure-guard.example.json',
    'config/qq-job/agent-guidance.txt': 'agent-guidance.txt',
}


def run(*arguments, cwd=None):
    return subprocess.run(arguments, cwd=cwd, check=True,
                          stdout=subprocess.DEVNULL, timeout=30)


def atomic_write(path, data, mode=0o600):
    temporary = path.with_name(path.name + '.install-new')
    with temporary.open('wb') as handle:
        os.chmod(temporary, mode)
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def replace_link(path, target):
    temporary = path.with_name(path.name + '.install-new')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(path)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def agreement_text(original, guidance):
    begin, end = '<!-- QQ_JOB_RESOURCE_START -->', '<!-- QQ_JOB_RESOURCE_END -->'
    if begin in original or end in original:
        if original.count(begin) != 1 or original.count(end) != 1:
            raise SystemExit('Unexpected resource-guidance markers; review AGENTS.md manually')
        start = original.index(begin)
        finish = original.index(end) + len(end)
        if finish <= start:
            raise SystemExit('Invalid resource-guidance marker order')
        return original[:start] + guidance.rstrip() + original[finish:]
    return original.rstrip() + '\n\n' + guidance


def unit_state(action, name):
    result = subprocess.run(['systemctl', '--user', action, name],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, timeout=10)
    return result.stdout.strip()


def restore_file(path, previous):
    if previous is None:
        path.unlink(missing_ok=True)
    else:
        atomic_write(path, previous[0], previous[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-activate', action='store_true')
    arguments = parser.parse_args()
    source = Path(__file__).resolve().parent.parent
    home = Path.home()
    config = home / '.config/qq-job'
    storage = home / '.local/share/qq-job'
    units = home / '.config/systemd/user'
    launcher = home / '.local/bin/qq-job'
    expected_link = storage / 'current/qq-job.py'
    os.umask(0o077)

    # Check manager access and the existing entry point before replacing files.
    run('systemctl', '--user', 'show-environment')
    if launcher.exists() or launcher.is_symlink():
        if not launcher.is_symlink() or os.readlink(launcher) != str(expected_link):
            raise SystemExit('Refusing to replace an unrelated ~/.local/bin/qq-job')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source,
                                     text=True, timeout=10).strip()
    changed = subprocess.check_output(['git', 'status', '--porcelain', '--',
                                       *FILES], cwd=source, text=True, timeout=10)
    if changed:
        raise SystemExit('Commit the reviewed resource-protection files before installation')
    content = {name: (source / name).read_bytes() for name in FILES}
    digest = hashlib.sha256(b''.join(name.encode() + b'\0' + content[name]
                                    for name in sorted(FILES))).hexdigest()
    release = storage / 'releases' / (commit[:12] + '-' + digest[:12])
    current = storage / 'current'
    previous_link = os.readlink(current) if current.is_symlink() else None
    if current.exists() and not current.is_symlink():
        raise SystemExit('Refusing to replace an unrelated qq-job current directory')
    previous_release = None
    if previous_link is not None:
        previous_release = current.resolve(strict=True)
        if not previous_release.is_relative_to((storage / 'releases').resolve()):
            raise SystemExit('Existing qq-job current link is outside its release directory')
        receipt_path = previous_release / 'receipt.json'
        if not receipt_path.is_file() or receipt_path.stat().st_size > 64 * 1024:
            raise SystemExit('Existing qq-job release has no valid ownership receipt')
        previous_receipt = json.loads(receipt_path.read_text())
    else:
        previous_receipt = {}
    previous_units = {}
    for name in ['qqjobs.slice', 'qq-job-pressure-guard.service']:
        target = units / name
        if target.is_symlink():
            raise SystemExit(f'Refusing to overwrite a symlinked unit: {name}')
        if target.exists():
            actual = target.read_bytes()
            source_name = next(key for key, value in FILES.items() if value == name)
            owned = previous_receipt.get('sha256', {}).get(source_name)
            if actual != content[source_name] and hashlib.sha256(actual).hexdigest() != owned:
                raise SystemExit(f'Refusing to overwrite an unrelated or locally modified unit: {name}')
            previous_units[name] = (actual, target.stat().st_mode & 0o777)
        else:
            previous_units[name] = None
    agreements = home / '.codex/AGENTS.md'
    if agreements.is_symlink():
        raise SystemExit('Refusing to replace a symlinked global AGENTS.md')
    previous_agreements = (agreements.read_bytes(), agreements.stat().st_mode & 0o777) if agreements.exists() else None
    original = previous_agreements[0].decode() if previous_agreements else ''
    guidance = content['config/qq-job/agent-guidance.txt'].decode().replace(
        '{{QQ_JOB}}', shlex.quote(str(launcher)))
    updated = agreement_text(original, guidance)
    guard_enabled = unit_state('is-enabled', 'qq-job-pressure-guard.service') == 'enabled'
    guard_active = unit_state('is-active', 'qq-job-pressure-guard.service') == 'active'

    # All ownership checks and marker validation above precede mutations.
    for directory in [config, release, units, launcher.parent,
                      home / '.local/state/qq-job',
                      home / '.local/state/qq-host-monitor']:
        directory.mkdir(parents=True, exist_ok=True)
    config.chmod(0o700)
    release.chmod(0o700)
    receipt = {'source_commit': commit, 'content_sha256': digest,
               'sha256': {name: hashlib.sha256(data).hexdigest()
                          for name, data in content.items()}}
    for name, installed in FILES.items():
        atomic_write(release / installed, content[name],
                     0o700 if installed.endswith('.py') else 0o600)
    atomic_write(release / 'receipt.json',
                 (json.dumps(receipt, indent=2) + '\n').encode())
    for filename, example in [('policy.json', 'policy.example.json'),
                              ('pressure-guard.json', 'pressure-guard.example.json')]:
        target = config / filename
        if not target.exists():
            atomic_write(target, (release / example).read_bytes())
        target.chmod(0o600)
    try:
        for name in ['qqjobs.slice', 'qq-job-pressure-guard.service']:
            atomic_write(units / name, (release / name).read_bytes(), 0o644)

        # Preserve the operator's other agreements, replacing only this owned block.
        agreements.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(agreements, updated.encode())
        replace_link(current, release)
        replace_link(launcher, expected_link)
        run('systemctl', '--user', 'daemon-reload')
        if not arguments.no_activate:
            run('systemctl', '--user', 'start', 'qqjobs.slice')
            run('systemctl', '--user', 'enable', 'qq-job-pressure-guard.service')
            run('systemctl', '--user', 'restart', 'qq-job-pressure-guard.service')
            run('systemctl', '--user', 'is-active', 'qqjobs.slice',
                'qq-job-pressure-guard.service')
    except (OSError, subprocess.SubprocessError):
        # Restore this owned deployment only; never stop a slice with live jobs.
        if previous_link is not None:
            replace_link(current, previous_link)
        else:
            current.unlink(missing_ok=True)
            launcher.unlink(missing_ok=True)
        for name, previous in previous_units.items():
            restore_file(units / name, previous)
        restore_file(agreements, previous_agreements)
        subprocess.run(['systemctl', '--user', 'disable', 'qq-job-pressure-guard.service'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        run('systemctl', '--user', 'daemon-reload')
        if guard_enabled:
            run('systemctl', '--user', 'enable', 'qq-job-pressure-guard.service')
        run('systemctl', '--user', 'restart' if guard_active else 'stop',
            'qq-job-pressure-guard.service')
        raise
    print('Installed resource protection release', release.name)
    print('Launcher:', launcher)
    print('Operator policy:', config)
    print('Activation:', 'deferred' if arguments.no_activate else 'active')


if __name__ == '__main__':
    main()
