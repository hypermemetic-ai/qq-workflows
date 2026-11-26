# Cascadeur in the animation workflow

## What 2026.3 changes for an artist

**A local correction can have its own track and weight.** The release adds Override alongside Additive and allows layer influence to be set per animation track. For a raised shoulder during a walk, keep the base take, try the smallest correction that changes the silhouette, and export the layer both enabled and muted. Compare the partner, the planted shoe and the neighboring steps in the game. Save the layered scene so the next artist can change the decision. [2026.3 release notes](https://cascadeur.com/help/category/327)

**Mocap Cleaning can be tried on a selected interval, on the artist's machine.** A useful first trial is a quiet planted foot with visible capture jitter. Save the raw take, clean a copy, then inspect the sole, the anticipation before lift, and the first frame on each side of the interval. An occluded limb can become smoother while still being on the wrong side of the body. The separate AI Cloud service uses credits and sends work to Cascadeur's servers. [Mocap Cleaning](https://cascadeur.com/help/category/203#mocap_cleaning) · [Release notes](https://cascadeur.com/help/category/327)

**Choose the solver explicitly for existing scenes.** For a baseline with an older control rig, use the legacy relaxation setting under Settings → Equilibrate. To evaluate the new IK chains, regenerate the control rig on a second copy. Compare the same planted step, hand path and exported deform skeleton. A control-rig migration deserves its own comparison even when the file opens normally. [Rig compatibility in the release notes](https://cascadeur.com/help/category/327)

## Rehearse an editor upgrade

Use a short neutral clip with two distinguishable actors, an asymmetric gesture and some root travel. A symmetric rest pose can hide a mirror, an actor swap or a lost animation track.

1. Import the original FBX through the game's current importer and preserve the played control. Record the source frame range and rate, the game tick count, actor order, opening places and facing.
2. Open a copy in the candidate editor and export with no artistic edits. The [round-trip probe](roundtrip.py) exercises the editor's FBX scene import and joint export. In an existing shell with the licensed editor available, run the example below. Use a fresh output directory for each take.
3. Process the exported FBX with the same importer, bind data and settings as the control. Compare both actors at every game tick, including root translation, orientation and elapsed time. Record angles and distances in their units. The importer's own reconstruction error tells you how well it fits *that file*. Two files can each reconstruct perfectly and still contain different poses. Inspect helpers such as necks and toes separately if the runtime folds them into other joints.
4. Open an existing native scene on a copy, verify the expected actors, and try the smallest edit the new feature should enable. Reopen the saved edit and play its export through the ordinary renderer before choosing a new production default.

On Linux, check the candidate itself with `cascadeur --help` before debugging a Python hook. The official 2026.3 binary requested `GLIBC_2.43` on a Debian 13 host with 2.41. A side-by-side runtime let us test a licensed export without changing the system libraries. On that build the shipped Python stub showed a zero-argument `add_stacked_layer()`, while the live binding required a boolean. We confirmed a new layer persisted by saving a disposable copy of the old rig and opening it in a second editor process. [Linux release requirements](https://cascadeur.com/help/category/327)

Example for a POSIX shell, from the workflow checkout:

```sh
export CASCADEUR_PROBE_SCRIPT="$PWD/docs/animation/roundtrip.py"
export CASCADEUR_PROBE_FBX="/absolute/path/to/neutral-pair.fbx"
export CASCADEUR_PROBE_DIR="/absolute/path/to/a-new-take"
test ! -e "$CASCADEUR_PROBE_DIR" &&
    cascadeur -c 'import os, runpy; runpy.run_path(os.environ["CASCADEUR_PROBE_SCRIPT"])' &&
    test -s "$CASCADEUR_PROBE_DIR/result.json"
```

The directory holds the editor export and a receipt with input and output hashes. Keep it beside the importer report. For automation, test a small script *inside* the installed editor. This release embeds Python 3.14. A registration in Scripts → MCP makes the editor reachable to a client. The game's replay, reference marks and camera checks still have to be run on the resulting take. Record the exact call that worked if the packaged Python type hints disagree with the running editor. [Cascadeur Python API](https://cascadeur.com/python-api/) · [Release notes](https://cascadeur.com/help/category/327)
