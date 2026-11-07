import { createHash } from "node:crypto";

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedJsonValue(value[key])]),
    );
  }
  return value;
}

/** Build the stable, authorization-scoped identity for one operations request. */
export function createOperationRequest(input, scope) {
  const id = input?.requestId;
  if (id === undefined) return undefined;
  if (typeof id !== "string" || !REQUEST_ID.test(id)) {
    throw badRequest("requestId must be 1 to 128 letters, digits, underscores, periods, colons, or hyphens.");
  }

  if (scope !== "owner" && !(typeof scope === "string" && UUID.test(scope))) {
    throw badRequest("Operation request scope must be owner or a grant UUID.");
  }

  const normalizedScope = scope === "owner" ? scope : scope.toLowerCase();
  const payload = sortedJsonValue({ revision: input.revision, operations: input.operations });
  const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { id, scope: normalizedScope, fingerprint };
}
