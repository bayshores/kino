const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROGRESS_STAGES = new Set(["render", "encode"]);
export const EXPORT_PROGRESS_LIMIT = 128;
export const EXPORT_PROGRESS_TTL_MS = 5 * 60 * 1000;

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function normalizeExportProgressId(value) {
  if (typeof value !== "string" || !UUID.test(value))
    throw httpError("Export ID must be a UUID.", 400);
  return value.toLowerCase();
}

function snapshot(record) {
  return {
    id: record.id,
    status: record.status,
    stage: record.stage,
    completed: record.completed,
    total: record.total,
  };
}

export function createExportProgressRegistry({
  limit = EXPORT_PROGRESS_LIMIT,
  terminalTtlMs = EXPORT_PROGRESS_TTL_MS,
  now = Date.now,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Export progress limit must be a positive integer.");
  if (!Number.isFinite(terminalTtlMs) || terminalTtlMs < 0) throw new RangeError("Export progress TTL must be nonnegative.");
  if (typeof now !== "function") throw new TypeError("Export progress clock must be a function.");

  const records = new Map();

  function prune() {
    const currentTime = now();
    for (const [id, record] of records) {
      if (record.terminalAt !== null && currentTime - record.terminalAt >= terminalTtlMs)
        records.delete(id);
    }
  }

  function removeOldestTerminal() {
    let oldest = null;
    for (const record of records.values()) {
      if (record.terminalAt !== null && (!oldest || record.terminalAt < oldest.terminalAt)) oldest = record;
    }
    if (oldest) records.delete(oldest.id);
    return Boolean(oldest);
  }

  function find(value) {
    const id = normalizeExportProgressId(value);
    prune();
    return records.get(id) ?? null;
  }

  return Object.freeze({
    create(value, { projectId, grantId = null } = {}) {
      if (value === undefined || value === null) return null;
      const id = normalizeExportProgressId(value);
      if (typeof projectId !== "string" || !projectId) throw new TypeError("Export progress project ID is required.");
      if (grantId !== null && (typeof grantId !== "string" || !grantId)) throw new TypeError("Export progress grant ID must be a nonempty string or null.");
      prune();
      if (records.has(id)) throw httpError("This export ID is already in use.", 409);
      while (records.size >= limit) {
        if (!removeOldestTerminal()) throw httpError("Too many exports are active. Try again shortly.", 503);
      }

      const record = { id, projectId, grantId, status: "preparing", stage: null, completed: null, total: null,
        terminalAt: null };
      records.set(id, record);
      const active = () => records.get(id) === record && record.terminalAt === null;
      const finish = (status) => {
        if (!active()) return false;
        record.status = status;
        record.terminalAt = now();
        return true;
      };
      return Object.freeze({
        id,
        progress(event) {
          if (!active() || !event || !PROGRESS_STAGES.has(event.stage) ||
              !Number.isSafeInteger(event.completed) || !Number.isSafeInteger(event.total) ||
              event.total < 1 || event.completed < 0 || event.completed > event.total) return false;
          record.status = "running";
          record.stage = event.stage;
          record.completed = event.completed;
          record.total = event.total;
          return true;
        },
        complete: () => finish("complete"),
        fail: () => finish("failed"),
        cancel: () => finish("cancelled"),
      });
    },
    get(value) {
      const record = find(value);
      return record ? snapshot(record) : null;
    },
    getScope(value) {
      const record = find(value);
      return record ? { projectId: record.projectId, grantId: record.grantId } : null;
    },
    clear() { records.clear(); },
    get size() { prune(); return records.size; },
  });
}
