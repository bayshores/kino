# Workspace

Copying between projects, many variants from a CSV, imports, and workspace actions.

## More editing ops

- `duplicate_layers`, `multi_transform`, `import_svg`, `copy_layers`, `copy_scene`,
  `copy_animations`, `apply_easing`, `apply_text_effect`: `library {topic:"op", name}` for each.
- `copy_layers {fromProject, layers:["title"], scene:"s1"}` copies dependencies too;
  `replaceLayers:["old-title"]` pastes in place. Source names/codes belong to fromProject.
- `multi_transform {layers:["card"], action:{kind:"scale",scaleX:120,scaleY:120}}` scales about
  the shared center; move uses dx/dy, rotate uses degrees. The layers' animations go along: a
  slide still ends where the layer is, and a quarter turn makes a slide up slide across.
- `import_svg {svg:"<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='#FF6B4A'/></svg>"}`
  imports editable vectors; read receipt warnings.
- `bulk_create {scene, csv}` makes one variant scene per CSV row (the header is `id` and layer
  names) and returns its result CSV in `summaries`; `dry_run` identifies it as a preview. With
  `deleteMissing:true` it deletes the variants the CSV leaves out, so the edit asks the person
  first (`awaiting_approval`, naming the scenes); a `dry_run` never asks. If more scenes would
  go by the time they allow it, nothing is deleted and it asks again (new Q id).

## Imports and workspace actions

- Media: `project {action:"import", file:"/absolute/path.png"}` returns a `src` for an image,
  video or audio layer.
- Project files: `project import /absolute/file.motion` (or `.json`) migrates into a new file.
- Workspace actions: `project {action:"manage", id, options:{resource, action, ...}}`.
  Resources: projects, templates, folders, trash, comments, shares, easings, effects, media,
  document, csv, exports. Load `library {topic:"rules", name:"workspace"}` for exact fields first.
- Saved easings and text effects: `options:{resource:"easings", action:"save", name, easing:[x1,y1,x2,y2]}`
  and `options:{resource:"effects", action:"save", name, sourceAnimation}`; then
  `apply_easing {name, animationIds}` and `apply_text_effect {name, layers}` use them.
- Share links, deleting from Trash forever and deleting a folder that holds projects may answer
  `awaiting_approval`. A folder delete covers only the projects it named: if more are in the
  folder when it is allowed, it asks again.
