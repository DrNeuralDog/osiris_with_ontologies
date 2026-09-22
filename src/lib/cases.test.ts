import { describe, it, expect, vi, afterEach } from "vitest";
import {
  caseVisibleAt,
  caseMapSnapshot,
  caseJumpTime,
  casePoint,
  caseReferenceFromSeed,
  type CaseItem,
} from "./cases";
import { translate } from "./i18n";
import { ru } from "./i18n/ru";
import { draftFilter } from "@/components/ObjectSetExplorer";
const item = {
  id: "case-item",
  kind: "observation",
  snapshot_at_add: {
    at: "2026-09-21T10:00:00Z",
    lat: 50,
    lon: 30,
    name: "Original source name",
  },
} as CaseItem;
afterEach(() => vi.unstubAllGlobals());
describe("case temporal context", () => {
  it("jumps to real recorded time without interpolation", () => {
    expect(caseJumpTime(item)).toBe(Date.parse(item.snapshot_at_add.at!));
    expect(casePoint(item)?.lat).toBe(50);
    expect(caseVisibleAt(item, Date.parse("2026-09-21T09:00:00Z"))).toBe(false);
    expect(caseVisibleAt(item, null)).toBe(true);
  });
  it("respects server replay windows and expiry", () => {
    const timed = {
      ...item,
      snapshot_at_add: {
        ...item.snapshot_at_add,
        replay_interval: {
          from: "2026-09-21T10:00:00Z",
          to: "2026-09-21T10:05:00Z",
        },
      },
    };
    expect(caseVisibleAt(timed, Date.parse("2026-09-21T10:04:59Z"))).toBe(true);
    expect(caseVisibleAt(timed, Date.parse("2026-09-21T10:05:00Z"))).toBe(
      false,
    );
  });
  it("static pinned identities remain available in replay without inventing observations", () => {
    expect(
      caseVisibleAt({ ...item, kind: "object" }, Date.parse("2020-01-01")),
    ).toBe(true);
    expect(
      caseJumpTime({
        ...item,
        snapshot_at_add: { ...item.snapshot_at_add, at: undefined },
      }),
    ).toBeNull();
  });
  it("map seed registers once and uses canonical identity", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        object: { id: "canonical" },
        relationships: 0,
        observations: 0,
      }),
    });
    vi.stubGlobal("fetch", fetch);
    expect(
      await caseReferenceFromSeed({ type: "aircraft", id: "abc123" }),
    ).toEqual({ kind: "object", id: "canonical" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("typed UI filters keep SQL-like text as a value", () => {
    expect(
      draftFilter({ field: "name", op: "eq", value: "' OR 1=1 --", or: false })
        .value,
    ).toBe("' OR 1=1 --");
    expect(
      draftFilter({
        field: "properties.magnitude",
        op: "range",
        value: "4,8",
        or: false,
      }).value,
    ).toEqual([4, 8]);
    expect(
      draftFilter({
        field: "properties.military",
        op: "eq",
        value: "true",
        or: false,
      }).value,
    ).toBe(true);
  });
});
describe("Russian UI catalog", () => {
  it("covers primary navigation and preserves source content", () => {
    for (const key of [
      "CASES",
      "INTELLIGENCE CENTER",
      "GLOBAL TIMELINE",
      "SOURCE HEALTH",
      "CORRELATIONS",
      "CIVILIAN AIR THREAT AWARENESS",
      "Explore relationships",
      "Add to case",
      "Object sets",
    ])
      expect(translate(key, "ru")).not.toBe(key);
    expect(translate("USGS", "ru")).toBe("USGS");
    expect(translate("Original witness report: aircraft", "ru")).toBe(
      "Original witness report: aircraft",
    );
  });
  it("English is reversible and catalogs contain nonempty entries", () => {
    for (const [key, value] of Object.entries(ru)) {
      expect(key.trim()).not.toBe("");
      expect(value.trim()).not.toBe("");
      expect(translate(key, "en")).toBe(key);
    }
    expect(Object.keys(ru).length).toBeGreaterThan(600);
  });
});

it("moving Case objects never reuse current/saved positions as historical facts", () => {
  const moving = {
    ...item,
    kind: "object",
    object_id: "plane",
    snapshot_at_add: { ...item.snapshot_at_add, type: "aircraft" },
  } as CaseItem;
  expect(caseMapSnapshot(moving, Date.now(), []).lat).toBeNull();
  expect(caseMapSnapshot(moving, null, []).lat).toBe(50);
});
