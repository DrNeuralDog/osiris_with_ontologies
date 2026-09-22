import { NextResponse } from "next/server";
import { getClientIp, isRateLimited } from "@/lib/ssrf-guard";
export const dynamic = "force-dynamic";
const uuid =
  "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
export async function proxyInvestigations(
  req: Request,
  context: {
    params: Promise<{
      path: string[];
    }>;
  },
) {
  const path = (await context.params).path.join("/"),
    method = req.method;
  const patterns: Record<string, string> = {
    GET: `^(cases|cases/${uuid}(/(items|notes|activity|timeline|graph|export|set-counts))?|sets|sets/${uuid}(/results)?)$`,
    POST: `^(cases|cases/${uuid}/(items|items/batch|notes|sets)|sets|sets/evaluate|analyses)$`,
    PATCH: `^cases/${uuid}(/(items|notes)/${uuid})?$`,
    DELETE: `^cases/${uuid}/(items|sets)/${uuid}$`,
  };
  if (!patterns[method] || !new RegExp(patterns[method]).test(path))
    return NextResponse.json(
      { error: "Unknown workspace endpoint" },
      { status: 404 },
    );
  if (
    isRateLimited(
      `cases:${getClientIp(req)}`,
      method === "GET" ? 120 : 60,
      60000,
    )
  )
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  let body: string | undefined;
  if (method !== "GET") {
    try {
      const origin = req.headers.get("origin");
      if (
        req.headers.get("sec-fetch-site") === "cross-site" ||
        (origin &&
          new URL(origin).host !==
            (req.headers.get("host") || new URL(req.url).host))
      )
        return NextResponse.json(
          { error: "Cross-origin mutation denied" },
          { status: 403 },
        );
    } catch {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }
    if (Number(req.headers.get("content-length")) > 65536)
      return NextResponse.json({ error: "Body too large" }, { status: 413 });
    if (method !== "DELETE") {
      if (!req.headers.get("content-type")?.startsWith("application/json"))
        return NextResponse.json({ error: "JSON required" }, { status: 415 });
      const reader = req.body?.getReader();
      if (!reader)
        return NextResponse.json({ error: "JSON required" }, { status: 400 });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) {
          await reader.cancel();
          return NextResponse.json(
            { error: "Body too large" },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
      body = Buffer.concat(chunks).toString("utf8");
      try {
        JSON.parse(body);
      } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }
    }
  }
  const params = new URL(req.url).searchParams;
  for (const [k, v] of params)
    if (
      ![
        "status",
        "q",
        "tag",
        "limit",
        "cursor",
        "type",
        "from",
        "to",
        "expand",
        "format",
      ].includes(k) ||
      params.getAll(k).length !== 1 ||
      v.length > 1000
    )
      return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  try {
    const base =
      process.env.INTEL_URL ||
      (process.env.NODE_ENV === "production"
        ? "http://osiris-intel:4000"
        : "http://localhost:4000");
    const r = await fetch(`${base}/investigations/${path}?${params}`, {
      method,
      body,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return NextResponse.json(await r.json(), {
      status: r.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Workspace storage unavailable" },
      { status: 502 },
    );
  }
}
export const GET = proxyInvestigations,
  POST = proxyInvestigations,
  PATCH = proxyInvestigations,
  DELETE = proxyInvestigations;
