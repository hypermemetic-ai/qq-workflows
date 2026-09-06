"""Read-only worktree evidence distinguishes repeated observations from progress."""
import hashlib
import subprocess
from pathlib import Path

def worktree_state(cwd):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=cwd, stderr=subprocess.DEVNULL)
    try:
        digest = hashlib.sha256(git('diff', 'HEAD', '--', '.', ':!.zvec-grep'))
        for name in git('ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':!.zvec-grep').split(b'\0'):
            if not name: continue
            path = Path(cwd) / name.decode()
            digest.update(name)
            if path.is_file() and not path.is_symlink():
                with path.open('rb') as stream:
                    for block in iter(lambda: stream.read(65536), b''): digest.update(block)
        return digest.hexdigest()
    except (OSError, subprocess.CalledProcessError):
        return None
