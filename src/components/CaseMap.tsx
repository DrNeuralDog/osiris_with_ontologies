"use client";
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { ItemSnapshot } from "@/lib/cases";
import { useLocale } from "@/lib/i18n";
export default function CaseMap({
  items,
  onSelect,
  temporal = false,
}: {
  items: ItemSnapshot[];
  temporal?: boolean;
  onSelect: (item: ItemSnapshot) => void;
}) {
  const { t } = useLocale(),
    container = useRef<HTMLDivElement>(null),
    map = useRef<maplibregl.Map | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const records = useRef(items),
    select = useRef(onSelect);
  useEffect(() => {
    records.current = items;
    select.current = onSelect;
  }, [items, onSelect]);
  useEffect(() => {
    if (!container.current) return;
    maplibregl.setWorkerUrl(
      `/vendor/maplibre/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`,
    );
    const m = new maplibregl.Map({
      container: container.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [0, 30],
      zoom: 2,
      attributionControl: { compact: true },
      transformRequest: (url) => ({
        url:
          url.startsWith("https://basemaps.cartocdn.com/") ||
          url.startsWith("https://tiles.basemaps.cartocdn.com/")
            ? window.location.origin +
              "/api/proxy-tiles?url=" +
              encodeURIComponent(url)
            : url,
      }),
    });
    map.current = m;
    m.on("load", () => {
      m.addSource("case-items", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: "case-points",
        type: "circle",
        source: "case-items",
        paint: {
          "circle-radius": 7,
          "circle-color": "#d4af37",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fafafa",
        },
      });
      m.on("click", "case-points", (e) => {
        const r = records.current.find(
          (r) => r.id === e.features?.[0].properties?.id,
        );
        if (r) select.current(r);
      });
      setReady(true);
    });
    m.on("error", () => setError("Basemap unavailable"));
    const resize = new ResizeObserver(() => m.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);
  const focus = () => {
    const points = items.filter(
      (i) => Number.isFinite(i.lat) && Number.isFinite(i.lon),
    );
    if (!points.length || !map.current) return;
    const b = new maplibregl.LngLatBounds();
    points.forEach((i) => b.extend([i.lon!, i.lat!]));
    map.current.fitBounds(b, { padding: 55, maxZoom: 12, duration: 500 });
  };
  useEffect(() => {
    if (!ready || !map.current) return;
    const s = map.current.getSource("case-items") as maplibregl.GeoJSONSource;
    s.setData({
      type: "FeatureCollection",
      features: items
        .filter((i) => Number.isFinite(i.lat) && Number.isFinite(i.lon))
        .slice(0, 500)
        .map((i) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [i.lon!, i.lat!] },
          properties: { id: i.id },
        })),
    });
  }, [items, ready]);
  return (
    <div className="relative flex-1 min-h-[350px]">
      <div ref={container} style={{ height: 400, width: "100%" }} />
      <button
        onClick={focus}
        className="absolute top-2 left-2 bg-slate-950 border p-2 text-xs"
      >
        {t("Focus all")}
      </button>
      {error && (
        <span className="absolute bottom-8 left-2 bg-slate-950 text-amber-300 text-xs">
          {t(error)}
        </span>
      )}
      <span className="absolute bottom-2 left-2 bg-slate-950 text-xs p-1">
        {t(
          temporal
            ? "Retained replay observations + static context"
            : "Snapshot at add",
        )}{" "}
        · {t("No coordinates")}:{" "}
        {
          items.filter(
            (i) => !Number.isFinite(i.lat) || !Number.isFinite(i.lon),
          ).length
        }
      </span>
    </div>
  );
}
