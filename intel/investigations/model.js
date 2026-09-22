const M = require("../ontology/model");
const { createHash } = require("node:crypto");
const { stable } = require("../intelligence/history");
const LIMITS = {
  items: 500,
  notes: 200,
  sets: 30,
  filters: 16,
  page: 100,
  bytes: 2 * 1024 * 1024,
  timeout: 4000,
  range: 31 * 86400000,
};
function fields(o, allowed) {
  M.check(o && typeof o === "object" && !Array.isArray(o), "Invalid input");
  M.check(
    Object.keys(o).every((k) => allowed.includes(k)),
    "Unknown field",
  );
  return o;
}
function bbox(v) {
  if (v == null) return null;
  M.check(
    Array.isArray(v) &&
      v.length === 4 &&
      v.every(Number.isFinite) &&
      v[0] >= -180 &&
      v[2] <= 180 &&
      v[1] >= -90 &&
      v[3] <= 90 &&
      v[0] < v[2] &&
      v[1] < v[3] &&
      v[2] - v[0] <= 60 &&
      v[3] - v[1] <= 60,
    "Invalid AOI (maximum 60 degrees per axis)",
  );
  return v;
}
function range(from, to, required = false) {
  if (!from && !to && !required) return null;
  const end = M.timestamp(to) || new Date().toISOString(),
    start =
      M.timestamp(from) || new Date(Date.parse(end) - 86400000).toISOString();
  M.check(
    Date.parse(end) >= Date.parse(start) &&
      Date.parse(end) - Date.parse(start) <= LIMITS.range,
    "Invalid time range (maximum 31 days)",
  );
  return { from: start, to: end };
}
function limit(v = 50, max = LIMITS.page) {
  M.check(
    /^\d+$/.test(String(v)) && Number(v) > 0 && Number(v) <= max,
    "Invalid limit",
  );
  return Number(v);
}
function hash(o) {
  return createHash("sha256").update(stable(o)).digest("hex");
}
function encode(o) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
function cursor(raw, scope) {
  if (!raw) return null;
  M.check(typeof raw === "string" && raw.length < 1000, "Invalid cursor");
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString());
    M.check(p.scope === scope && typeof p.id === "string", "Invalid cursor");
    return p;
  } catch {
    throw new M.InputError("Invalid cursor");
  }
}
const sensitiveKey = /(password|secret|token|api.?key|authorization|cookie)/i;
function safe(value, depth = 0) {
  if (depth > 8) return "[depth limit]";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()])
          if (sensitiveKey.test(key)) url.searchParams.delete(key);
        return url.toString().slice(0, 4000);
      } catch {
        /* Non-URL source text is retained as text. */
      }
    }
    return value.slice(0, 4000);
  }
  if (Array.isArray(value))
    return value.slice(0, 40).map((v) => safe(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !sensitiveKey.test(k))
        .slice(0, 80)
        .map(([k, v]) => [k, safe(v, depth + 1)]),
    );
  return value;
}
function snapshot(row) {
  const s = safe(row);
  // Preserve complete bounded lineage, even when descriptive metadata is summarized.
  for (const key of [
    "source_ids",
    "report_ids",
    "related_object_ids",
    "object_ids",
  ]) {
    if (Array.isArray(row[key]))
      s[key] = row[key].slice(0, 500).map((v) => String(v).slice(0, 100));
  }
  if (Buffer.byteLength(JSON.stringify(s)) > 60000) {
    s.properties = { snapshot_truncated: true };
    s.data = { snapshot_truncated: true };
    s.provenance = (s.provenance || [])
      .slice(0, 8)
      .map((p) => ({ ...p, metadata: { snapshot_truncated: true } }));
    s.evidence = [];
    s.snapshot_truncated = true;
  }
  M.check(
    Buffer.byteLength(JSON.stringify(s)) <= 64000,
    "Snapshot exceeds budget",
  );
  return s;
}
async function transaction(store, work) {
  return store.transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='4000ms'");
    return work(db);
  });
}
function budget(result, max = LIMITS.bytes) {
  M.check(
    Buffer.byteLength(JSON.stringify(result)) <= max,
    "Response byte budget exceeded; reduce limit",
  );
  return result;
}
module.exports = {
  ...M,
  LIMITS,
  fields,
  bbox,
  range,
  limit,
  hash,
  encode,
  cursor,
  safe,
  snapshot,
  transaction,
  budget,
};
