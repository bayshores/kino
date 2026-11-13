// Workspace metadata is intentionally separate from an atomic document edit.
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { commentKeyHash, commentListText } from "../comments.mjs";
import { parseDocument } from "../../engine/model.js";
import { savedTextEffectInput } from "../../engine/savedTextEffects.js";
import { sceneCsvRows } from "../../engine/sceneCsv.js";
import { writeCsv, parseCsv } from "../../engine/csv.js";
import { planBulkCreate, bulkCreateSummary, bulkCreateTemplate } from "../../engine/bulkCreate.js";
import { copyLayers } from "../../engine/layerClipboard.js";
import { copyScene } from "../../engine/sceneClipboard.js";
import { namedItem } from "./reach-operations.mjs";
import { assignCodes, createResolver, documentObjects } from "./refs.mjs";
import { shareUrl } from "../../engine/shareUrls.js";
import { TEMPLATE_CATALOG, createTemplateDocument } from "../../engine/templates.js";

export const WORKSPACE_HELP = `project {action:"manage", id?:project, options:{resource,action,...}}.
folders: list, create {name}, rename {id,name}, delete {id}, move {folderId:null|id}.
projects: list {search?,folderId?,offset?:0,limit?:30}; returns total and next offset.
templates: list; create {id} creates an independent project from an original template.
easings: list, save {name,easing,intensity?}, rename {id,name}, delete {id}.
effects: list, save {name,animation,rest} or save {name,sourceAnimation}, rename {id,name}, delete {id}.
comments: list, add {text,author?,scene?,layer?,x?,y?,time?,timeEnd?,parentId?,mentions?}, update {id,patch}, resolve {id,resolved?}, delete {id}. layer pins a layer (by name or code); time..timeEnd is a range; no scene is the whole video; patch layer:null unpins, scene:null makes it whole video. Replies use parentId. Agent authorship is persisted privately.
trash: list, restore {id}, delete {id,confirm:true}. Only trashed files may be deleted forever.
shares: list, create {role:view|comment|edit,label?,scene?,layer?,origin?}, revoke {id}. Tokens appear only in URL fragments and are omitted from activity logs.
document: import {document} (migrates old versions, creates an independent project), export (saved JSON).
csv: template {scene,variants?:true adds the base row and saved variants}, review {scene,csv} (validation and planned changes; nothing is saved).
media: list {search?}, original {id} (copies original bytes to a private output file), peaks {id} (cached waveform).
exports: start {sceneIds?,quality:draft|final,options:{format,profile?,width?,height?,fps?,transparent?,loop?,playbackDirection?,time?,design?},out?:absolute folder}; status/wait/cancel/resume/zip/close {batch}. A draft is half size at 30fps (fps up to 30) unless options give a width, height or size. Formats include png, jpeg, apng, lottie, png-sequence, mp4, webm, mov, gif.
pieces: list, save {name,layers:[..] or scene,description?,replace?}, rename {piece,name}, delete {piece}, export {piece,out?} writes a .kinopiece file, import {file}. edit use_piece {piece,scene?,at?,x?,y?,name?} puts one in a project.
These are individual workspace actions, not document undo steps. library {topic:"op",name:"apply_easing"|"apply_text_effect"} applies named presets in an atomic edit.`;

export function createReachWorkspace(deps) {
  const { store, agentDirectory, agentState } = deps;
  let actorPromise;
  const actor = () => actorPromise ??= (async () => {
    await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
    const file = path.join(agentDirectory, "comment-author-key");
    try { await writeFile(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    return { role: "owner", keyHash: commentKeyHash((await readFile(file, "utf8")).trim()) };
  })();

  return async function manage(input, record) {
    const { resource, action = "list" } = input;
    const document = record?.document;
    const projectId = document?.id;
    let result, text;
    const needProject = () => { if (!document) throw new Error("Choose a project with id or open one first."); };
    if (resource === "templates") {
      if (action === "list") result = { templates: TEMPLATE_CATALOG };
      else if (action === "create") {
        const created = await deps.createProject(createTemplateDocument(input.id));
        result = { project: created.document.id, name: created.document.name, revision: created.revision };
      }
    } else if (resource === "projects" && action === "list") {
      const offset = input.offset ?? 0, limit = input.limit ?? 30;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("offset must be nonnegative; limit must be 1 to 100.");
      const projects = (await store.listProjects()).filter((item) => (!input.search || item.name.toLowerCase().includes(String(input.search).toLowerCase())) && (input.folderId === undefined || item.folderId === input.folderId));
      result = { projects: projects.slice(offset, offset + limit), total: projects.length, next: offset + limit < projects.length ? offset + limit : null };
    } else if (["easings", "effects"].includes(resource)) {
      const list = resource === "easings" ? store.listEasings : store.listTextEffects;
      const save = resource === "easings" ? store.saveEasing : store.saveTextEffect;
      const rename = resource === "easings" ? store.renameEasing : store.renameTextEffect;
      const remove = resource === "easings" ? store.deleteEasing : store.deleteTextEffect;
      if (action === "list") result = { [resource]: await list() };
      else if (action === "save") {
        let value;
        if (resource === "effects" && input.sourceAnimation) {
          needProject();
          const resolver = createResolver(document, assignCodes((await agentState.read(projectId)).codes, document));
          const id = resolver.resolve(input.sourceAnimation, "animation");
          const entry = documentObjects(document).animations.find((item) => item.id === id);
          value = savedTextEffectInput(input.name, entry.layer, entry.animation);
        } else value = Object.fromEntries((resource === "easings" ? ["name", "easing", "intensity"] : ["name", "animation", "rest"]).filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
        result = await save(value);
      } else if (action === "rename" || action === "delete") {
        const item = namedItem(await list(), input.id, resource);
        result = action === "rename" ? await rename(item.id, input.name) : await remove(item.id);
      }
    } else if (resource === "folders") {
      if (action === "list") result = { folders: await store.listFolders() };
      else if (action === "create") result = await store.createFolder(input.name);
      else if (action === "rename") result = await store.renameFolder(input.id, input.name);
      else if (action === "delete") result = await deps.deleteFolder(input.id);
      else if (action === "move") { needProject(); const moved = await store.moveProject(projectId, input.folderId); result = { id: projectId, folderId: moved.folderId }; }
    } else if (resource === "comments") {
      needProject();
      // scene and layer by name or code; a layer brings its scene. null clears (update only):
      // layer:null unpins the layer, scene:null makes the thread about the whole video.
      const place = async (from) => {
        const value = { ...from };
        delete value.scene; delete value.layer;
        const resolver = createResolver(document, assignCodes((await agentState.read(projectId)).codes, document));
        if (from.scene === null) value.sceneId = null;
        else if (from.scene) value.sceneId = resolver.resolve(from.scene, "scene");
        if (from.layer === null) value.layerId = null;
        else if (from.layer) {
          value.layerId = resolver.resolve(from.layer, "layer");
          value.sceneId ??= resolver.sceneOf("layer", value.layerId);
        }
        return value;
      };
      if (action === "list") {
        const { comments } = await store.getProject(projectId);
        result = { comments };
        text = commentListText(comments, document);
      } else {
        const author = await actor();
        if (action === "add") {
          const value = Object.fromEntries(["text", "author", "sceneId", "x", "y", "time", "timeEnd", "parentId", "mentions", "scene", "layer"].filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
          result = await store.addComment(projectId, { author: "Agent", ...(await place(value)) }, author);
        } else if (action === "update") result = await store.updateComment(projectId, input.id, input.patch && typeof input.patch === "object" ? await place(input.patch) : input.patch, author);
        else if (action === "resolve") result = await store.resolveComment(projectId, input.id, input.resolved ?? true, author);
        else if (action === "delete") result = await store.deleteComment(projectId, input.id, author);
        if (result) await deps.commentsChanged?.(projectId);
      }
    } else if (resource === "trash") {
      if (action === "list") result = { projects: await store.listTrashedProjects() };
      else if (action === "restore") result = await store.restoreProject(input.id);
      else if (action === "delete") result = await deps.deleteProjectForever(input.id, input.confirm);
    } else if (resource === "shares") {
      needProject();
      let selection;
      if (action === "create") {
        const resolver = createResolver(document, assignCodes((await agentState.read(projectId)).codes, document));
        const layerId = input.layer ? resolver.resolve(input.layer, "layer") : undefined;
        const sceneId = input.scene ? resolver.resolve(input.scene, "scene") : layerId ? resolver.sceneOf("layer", layerId) : undefined;
        if (layerId && resolver.sceneOf("layer", layerId) !== sceneId) throw new Error("The link's layer must belong to its scene.");
        selection = { sceneId, layerId };
        if (input.origin && !shareUrl(input.origin, projectId, selection)) throw new Error("origin must be an HTTP(S) URL.");
      }
      result = await deps.manageShares(projectId, input);
      if (result.token) result = { ...result, url: shareUrl(input.origin ?? deps.origin(), projectId, selection, { token: result.token }), desktopUrl: shareUrl("kino://open", projectId, selection, { desktop: true, token: result.token }) };
    } else if (resource === "document") {
      if (action === "import") {
        const created = await deps.createProject(parseDocument(input.document));
        result = { project: created.document.id, name: created.document.name, revision: created.revision };
      }
      else if (action === "export") {
        needProject();
        const directory = path.join(agentDirectory, "out", projectId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${projectId}-r${record.revision}.json`);
        await writeFile(file, JSON.stringify(document, null, 2), { mode: 0o600 });
        result = { document, revision: record.revision, path: file };
      }
    } else if (resource === "csv") {
      needProject();
      const resolver = createResolver(document, assignCodes((await agentState.read(projectId)).codes, document));
      const sceneId = input.scene ? resolver.resolve(input.scene, "scene") : document.scenes[0].id;
      if (action === "template") result = { csv: writeCsv(input.variants ? bulkCreateTemplate(document, sceneId) : sceneCsvRows(document, sceneId, await deps.listMedia())) };
      if (action === "review") {
        const parsed = parseCsv(input.csv);
        const sources = new Map((await deps.listMedia()).map((item) => [item.src, item]));
        const plan = planBulkCreate(document, sceneId, parsed.header, parsed.rows, [], sources);
        const summary = bulkCreateSummary(parsed.header, parsed.rows, plan);
        // A preview must not claim a write occurred.
        result = { csv: writeCsv(summary.map((row, index) => index ? row.map((value, column) => column === row.length - 1 ? `Preview: ${value}` : value) : row)), plan };
      }
    } else if (resource === "media") {
      const media = await deps.listMedia();
      if (action === "list") result = { media: media.filter((item) => !input.search || item.name.toLowerCase().includes(String(input.search).toLowerCase())) };
      else if (action === "original" || action === "peaks") {
        const item = namedItem(media, input.id, "media");
        if (action === "peaks") result = await deps.mediaPeaks(item.id);
        else {
          const directory = path.join(agentDirectory, "out", "originals");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const target = path.join(directory, path.basename(item.id));
          await copyFile(path.join(deps.mediaRoot, path.basename(item.id)), target);
          result = { ...item, path: target };
        }
      }
    }
    else if (resource === "pieces") {
      const pieces = deps.pieces;
      if (!pieces) throw new Error("Pieces are not available here.");
      const ref = input.piece ?? input.id;
      const brief = (piece) => ({ name: piece.name, id: piece.id, kind: piece.kind, canvas: piece.canvas, length: piece.length, layers: piece.layerCount, fonts: piece.media.filter((item) => item.type === "font").length, media: piece.media.filter((item) => item.type !== "font").length });
      if (action === "list") {
        const saved = await pieces.list();
        result = { pieces: saved.map(brief) };
        text = saved.length ? saved.map((piece) => pieces.line(piece)).join("\n") : 'No pieces saved yet. Save one: options:{resource:"pieces", action:"save", name, layers:["title"]} (or scene:"s1").';
      } else if (action === "save") {
        needProject();
        const resolver = createResolver(document, assignCodes((await agentState.read(projectId)).codes, document));
        const fonts = await deps.loadFonts?.();
        let envelope, scene;
        if (input.layers !== undefined) {
          if (!Array.isArray(input.layers) || !input.layers.length) throw new Error("layers must list the layer names or codes to save.");
          const ids = input.layers.map((item) => resolver.resolve(item, "layer"));
          const sceneId = input.scene !== undefined ? resolver.resolve(input.scene, "scene") : resolver.sceneOf("layer", ids[0]);
          scene = document.scenes.find((item) => item.id === sceneId);
          if (ids.some((id) => !scene?.layers.some((layer) => layer.id === id))) throw new Error("The layers to save must belong to one scene.");
          envelope = copyLayers(document, sceneId, ids, { fonts });
        } else if (input.scene !== undefined) {
          scene = document.scenes.find((item) => item.id === resolver.resolve(input.scene, "scene"));
          envelope = copyScene(document, scene.id);
        } else throw new Error('Name what to save: layers:["title","card"] (one scene) or scene:"s1".');
        const saved = await pieces.save({ name: input.name, description: input.description, envelope, canvas: { width: scene.width, height: scene.height }, replace: input.replace === true });
        result = brief(saved);
        text = `Saved piece ${pieces.line(saved)}. Use it in any project: edit {op:"use_piece", piece:"${saved.name}"}.`;
      } else if (action === "rename") {
        const renamed = await pieces.rename(ref, input.name);
        result = brief(renamed);
      } else if (action === "delete") {
        result = brief(await pieces.delete(ref));
        text = `Deleted piece "${result.name}". Projects that already used it keep their copy.`;
      } else if (action === "export") {
        const piece = await pieces.find(ref);
        const folder = path.join(agentDirectory, "out", "pieces");
        let out = input.out === undefined ? path.join(folder, `${piece.name.replace(/[^A-Za-z0-9 _.-]+/g, "-").trim() || "piece"}.kinopiece`) : input.out;
        if (typeof out !== "string" || !path.isAbsolute(out)) throw new Error("out must be an absolute path to the .kinopiece file or its folder.");
        if (!out.endsWith(".kinopiece")) out = path.join(out, `${piece.name.replace(/[^A-Za-z0-9 _.-]+/g, "-").trim() || "piece"}.kinopiece`);
        await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
        result = await pieces.exportTo(piece.id, out);
        text = `Wrote ${result.path} (${result.bytes} bytes, ${result.media} media file${result.media === 1 ? "" : "s"}).${result.missing ? ` Missing from the library and left out: ${result.missing.join(", ")}.` : ""} Import it elsewhere: project import ${result.path}`;
      } else if (action === "import") {
        if (typeof input.file !== "string" || !path.isAbsolute(input.file)) throw new Error("file must be the absolute path of a .kinopiece file.");
        result = await pieces.importFrom(input.file, { replace: input.replace === true });
        text = `Imported piece ${result.line}. Use it: edit {op:"use_piece", piece:"${result.piece}"}.`;
      }
    }
    if (result === undefined) throw new Error(`Unknown workspace action ${resource}/${action}. Resources: templates, projects, folders, easings, effects, pieces, comments, trash, shares, document, csv, media, exports. Read library {topic:"rules",name:"workspace"}.`);
    return { text: text ?? JSON.stringify(result), data: result };
  };
}
