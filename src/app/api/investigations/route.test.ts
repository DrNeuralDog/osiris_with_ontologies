import { it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/ssrf-guard", () => ({
  getClientIp: () => "local",
  isRateLimited: () => false,
}));
import { proxyInvestigations } from "./[...path]/route";
const id = "11111111-1111-4111-8111-111111111111";
const call = (
  path: string,
  method = "GET",
  body?: unknown,
  origin = "http://localhost:3000",
) =>
  proxyInvestigations(
    new Request("http://localhost:3000/api/investigations/" + path, {
      method,
      headers: {
        origin,
        host: "localhost:3000",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: path.split("/") }) },
  );
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  ),
);
it("rejects cross-origin mutations before forwarding", async () => {
  expect(
    (await call("cases", "POST", { title: "bad" }, "https://attacker.example"))
      .status,
  ).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it("only fixed route shapes and query dimensions are accepted", async () => {
  expect((await call("arbitrary", "POST", {})).status).toBe(404);
  expect((await call("cases/not-a-uuid")).status).toBe(404);
  expect(
    (await call("sets/evaluate", "POST", { kind: "objects", filters: [] }))
      .status,
  ).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("allows same-origin deployment behind Docker Host and limits body", async () => {
  expect(
    (
      await call(`cases/${id}/items/batch`, "POST", {
        items: [{ kind: "object", id }],
      })
    ).status,
  ).toBe(200);
  expect(
    (await call("cases", "POST", { title: "x".repeat(70000) })).status,
  ).toBe(413);
});
