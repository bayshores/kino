import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const queues = new Map();
const roles = new Set(["view", "comment", "edit"]);
const tokenPattern = /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function accessFor(role = "owner") {
  return {
    role,
    canEdit: ["owner", "edit"].includes(role),
    canComment: ["owner", "edit", "comment"].includes(role),
    canExport: true,
    manageShares: role === "owner",
  };
}

export function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

// A link secret in text, even one cut short: anything after "#share=" in a URL, or a bare
// token: the grant id (a UUID), a dot and exactly 43 base64url characters (32 random bytes).
// A shorter tail (8 to 42 characters) counts only at the very end of the text or right
// before "…", where a log line cut a token off. So ordinary text such as "<id>.json",
// "<id>.thumbnail.png" or "layer.<id>.componentSceneId: must …" stays as it is.
const SECRET_IN_TEXT = /#share=[\w.%-]*|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:[\w-]{43}(?![\w-])|[\w-]{8,42}(?=…|$))/g;

/** Text for logs and screens: every share link secret in it is replaced. */
export function hideShareSecrets(text) {
  return String(text ?? "").replace(SECRET_IN_TEXT, (found) => (found.startsWith("#share=") ? "#share=(secret omitted)" : "(secret omitted)"));
}

function metadata(grant) {
  const { tokenHash, ...publicFields } = grant;
  return publicFields;
}

/** Only token digests are persisted. Link secrets are returned once at creation. */
export async function openShareStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "shares.json");
  async function read() {
    let state;
    try { state = JSON.parse(await readFile(filename, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return { version: 1, grants: [] };
      throw new Error("The sharing store could not be read.");
    }
    if (state.version !== 1 || !Array.isArray(state.grants)) throw new Error("Invalid sharing store format.");
    const ids = new Set();
    for (const grant of state.grants) {
      if (!grant || !idPattern.test(grant.id) || ids.has(grant.id) || !idPattern.test(grant.projectId) || !roles.has(grant.role)
          || typeof grant.label !== "string" || grant.label.length > 100 || !/^[a-f0-9]{64}$/.test(grant.tokenHash)
          || typeof grant.createdAt !== "string" || (grant.revokedAt !== null && typeof grant.revokedAt !== "string"))
        throw new Error("The sharing store contains an invalid grant.");
      ids.add(grant.id);
    }
    return state;
  }
  async function write(state) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
      await chmod(filename, 0o600);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async function queue(operation) {
    const previous = queues.get(filename) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    queues.set(filename, task);
    try { return await task; }
    finally { if (queues.get(filename) === task) queues.delete(filename); }
  }
  return {
    async list(projectId) {
      return queue(async () => (await read()).grants.filter((grant) => grant.projectId === projectId).map(metadata));
    },
    async create(projectId, { role = "view", label = "" } = {}) {
      if (!idPattern.test(projectId) || !roles.has(role) || typeof label !== "string" || label.length > 100 || /[\u0000-\u001F]/.test(label))
        throw new Error("Choose view, comment, or edit access and a label of at most 100 characters.");
      return queue(async () => {
        const state = await read();
        if (state.grants.filter((grant) => grant.projectId === projectId && !grant.revokedAt).length >= 100)
          throw new Error("Revoke an existing link before creating more than 100 active links for a project.");
        const id = randomUUID();
        const token = `${id}.${randomBytes(32).toString("base64url")}`;
        const grant = { id, projectId, role, label: label.trim(), tokenHash: createHash("sha256").update(token).digest("hex"), createdAt: new Date().toISOString(), revokedAt: null };
        state.grants.push(grant);
        await write(state);
        return { grant: metadata(grant), token };
      });
    },
    async authorize(token) {
      if (typeof token !== "string" || !tokenPattern.test(token)) return null;
      return queue(async () => {
        const id = token.split(".")[0];
        const grant = (await read()).grants.find((entry) => entry.id === id && entry.revokedAt === null);
        if (!grant || !sameSecret(grant.tokenHash, createHash("sha256").update(token).digest("hex"))) return null;
        return metadata(grant);
      });
    },
    async revoke(projectId, grantId) {
      return queue(async () => {
        const state = await read();
        const grant = state.grants.find((entry) => entry.id === grantId && entry.projectId === projectId);
        if (!grant) throw new Error("This sharing link could not be found.");
        grant.revokedAt ??= new Date().toISOString();
        await write(state);
        return { grant: metadata(grant) };
      });
    },
  };
}
