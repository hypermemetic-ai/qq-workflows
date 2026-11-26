"""Run in Cascadeur's embedded Python on a neutral clip in a disposable session."""

import hashlib
import json
import os
from pathlib import Path
import sys

import csc
from PySide6.QtCore import qVersion
from pycsc.general import fbx


def digest(path):
    with path.open("rb") as data:
        return hashlib.file_digest(data, "sha256").hexdigest()


def main():
    source = Path(os.environ["CASCADEUR_PROBE_FBX"]).resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != ".fbx":
        raise ValueError("CASCADEUR_PROBE_FBX must name an FBX file")
    target = Path(os.environ["CASCADEUR_PROBE_DIR"]).resolve()
    # A stale export could make a failed editor command look successful.
    target.mkdir(parents=True, exist_ok=False)
    exported = target / "roundtrip.fbx"
    source_digest = digest(source)
    fbx.import_fbx(str(source), fbx.FbxFilterType.SCENE, new_scene=True)
    scene = csc.app.get_application().get_scene_manager().current_scene()
    viewer = scene.domain_scene().model_viewer().behaviour_viewer()
    joint_count = len(viewer.get_behaviours("Joint"))
    if not joint_count:
        raise RuntimeError("Imported scene has no joints to export")
    fbx.export_fbx(str(exported), fbx.FbxFilterType.ANIMATION)
    if not exported.is_file() or exported.stat().st_size == 0:
        raise RuntimeError("Cascadeur produced no FBX. Check the editor log and export entitlement.")
    receipt = {
        "source": source.name,
        "source_sha256": source_digest,
        "export": exported.name,
        "export_sha256": digest(exported),
        "python": sys.version.split()[0],
        "qt": qVersion(),
        "joints": joint_count,
    }
    (target / "result.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


main()
