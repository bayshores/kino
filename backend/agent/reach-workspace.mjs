// Workspace metadata is intentionally separate from an atomic document edit.
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { commentKeyHash } from "../comments.mjs";
import { parseDocument } from "../../engine/model.js";
import { savedTextEffectInput } from "../../engine/savedTextEffects.js";
import { sceneCsvRows } from "../../engine/sceneCsv.js";
import { writeCsv, parseCsv } from "../../engine/csv.js";
import { planBulkCreate, bulkCreateSummary, bulkCreateTemplate } from "../../engine/bulkCreate.js";
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
comments: list, add {text,author?,scene?,x?,y?,time?,parentId?,mentions?}, update {id,patch}, resolve {id,resolved?}, delete {id}. Replies use parentId. Agent authorship is persisted privately.
trash: list, restore {id}, delete {id,confirm:true}. Only trashed files may be deleted forever.
shares: list, create {role:view|comment|edit,label?,scene?,layer?,origin?}, revoke {id}. Tokens appear only in URL fragments and are omitted from activity logs.
document: import {document} (migrates old versions, creates an independent project), export (saved JSON).
csv: template {scene,variants?:true adds the base row and saved variants}, review {scene,csv} (validation and planned changes; nothing is saved).
media: list {search?}, original {id} (copies original bytes to a private output file), peaks {id} (cached waveform).
exports: start {sceneIds?,quality:draft|final,options:{format,profile?,width?,height?,fps?,transparent?,loop?,playbackDirection?,time?,design?},out?:absolute folder}; status/wait/cancel/resume/zip/close {batch}. A draft is half size at 30fps (fps up to 30) unless options give a width, height or size. Formats include png, jpeg, apng, lottie, png-sequence, mp4, webm, mov, gif.
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
    let result;
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
      if (action === "list") result = { comments: (await store.getProject(projectId)).comments };
      else {
        const author = await actor();
        if (action === "add") {
          const value = Object.fromEntries(["text", "author", "sceneId", "x", "y", "time", "parentId", "mentions"].filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
          if (input.scene) value.sceneId = createResolver(document, assignCodes((await agentState.read(projectId)).codes, document)).resolve(input.scene, "scene");
          result = await store.addComment(projectId, { author: "Agent", ...value }, author);
        } else if (action === "update") result = await store.updateComment(projectId, input.id, input.patch, author);
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
    if (result === undefined) throw new Error(`Unknown workspace action ${resource}/${action}. Read library {topic:"rules",name:"workspace"}.`);
    return { text: JSON.stringify(result), data: result };
  };
}
