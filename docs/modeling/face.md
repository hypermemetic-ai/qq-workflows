# Face, camera and materials

## Recover the camera before measuring the face

Preserve the original picture, its dimensions, crop and side. Solve or recover the camera on the editable head. Project the built game mesh through that camera and check untouched eye corners or other registration landmarks against the original. Inspect the profile as well as the front. A registration fitted using the eyes can demonstrate that an export preserved their positions. It tells you little about whether the eyelids, iris or cheeks *look* right. Moving a camera changes perspective. Cropping a picture at a fixed viewpoint changes its framing.

Trace the visible contour on the original pixels. Mark hair-covered edges, skin against a dark background and a cheek fading into neck shadow separately. Overlay the old and new mesh using one registration. Sample each side independently at recognizable heights and inspect the curve between those samples. Equal widths can conceal a sideways shift, a broad chin tip or an abrupt corner. The front can constrain a chin's taper, the profile its projection below the lips, and the three-quarter view the volume that joins them. Where the drawings disagree, record which one directs which feature.

## Find out what produces a mark

| Observation | Cheap control | Editable decision |
| --- | --- | --- |
| Mouth reads stern, broad or high | Compare the lip gap at center and corners, colored lip border and space to chin in the fitted camera. Render neutral material, then restore color and highlights. | Rest shape, expression, vermilion color and lip roughness are separate controls. A translation moves center and corners together. |
| Eye looks like a lens or reads as a squint | Look at lid aperture over the iris in front and three-quarter. Slice through lid, globe and cornea. Sweep the key light. Inspect sclera/iris contrast and the shadow of the upper lid. | Adjust the responsible layer. Keep corneal catchlights, lid contact, eye gaze and the tear line independently editable where supported. |
| Face looks heavy, waxy or like clay | Keep mesh and camera fixed. Compare soft reference light, game light and a neutral-material control. Inspect the form inside the outline. Compare face, neck and arms together. | Broad color, roughness, surface normals, ambient shading and lighting can all change the cheek read. Inspect directional shadows baked into color before adding a second light. |
| Head looks good in the sculptor and poor in game | Render the same head and pose in both. Inspect exported normals, texture/color space, roughness, shadow support and pixel size. | Correct the handoff or renderer if it discards something essential to the look. Save a matched pair demonstrating the difference. |

Begin from fitted topology or another authored base when it supplies useful anatomy. A parametric fit supplies editable form and cameras. Its original neutral pose is just a starting point. Preserve the base, layer local corrections, and inspect anatomical features in the whole expression. An attractive frontal still can hide a flat profile or painted highlights that never move.

For production examples, see Guerrilla's [character development for Horizon Forbidden West](https://www.guerrilla-games.com/read/creating-the-many-faces-of-horizon-forbidden-west) and Unity's [eye shading model](https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/understand-eyes.html). Research on [shape, material and expression in CG faces](https://graphics.unizar.es/papers/perceptionCGfaces_final.pdf) supports checking each separately. Population preference studies can suggest artistic variants. The particular reference and the owner's whole-face judgments determine the likeness.
