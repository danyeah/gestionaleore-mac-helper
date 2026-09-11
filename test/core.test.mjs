import test from "node:test";
import assert from "node:assert/strict";
import {
  GestionaleOreClient,
  buildHourPayload,
  computeWindow,
  dedupeKey,
  normalizeList,
  parseDuration,
} from "../src/core.mjs";

test("computeWindow creates a same-day two-hour interval", () => {
  const result = computeWindow(new Date(2026, 7, 29, 10, 7), 120);
  assert.deepEqual(result, {
    day: "2026-08-29",
    start: "08:05",
    end: "10:05",
    pause: "00:00",
    qty: "02:00",
  });
});

test("parseDuration validates H:MM", () => {
  assert.equal(parseDuration("1:30"), 90);
  assert.throws(() => parseDuration("1.5"));
});

test("buildHourPayload removes empty optional fields", () => {
  const payload = buildHourPayload({
    preset: { name: "Cliente", userId: "u1", customerId: "c1" },
    description: "Revisione dashboard",
    window: { day: "2026-08-29", start: "08:00", end: "10:00", pause: "00:00", qty: "02:00" },
  });
  assert.equal(payload.activityFreeText, "Revisione dashboard");
  assert.equal(payload.note, "Revisione dashboard");
  assert.equal(payload.customerId, "c1");
  assert.ok(!("projectId" in payload));
  assert.match(dedupeKey(payload), /2026-08-29\|08:00\|10:00\|u1\|c1/);
});

test("normalizeList supports Gestionale Ore paginated tuples", () => {
  assert.deepEqual(normalizeList([[{ id: 1 }], 1]), [{ id: 1 }]);
  assert.deepEqual(normalizeList({ data: [[{ id: 2 }], 1] }), [{ id: 2 }]);
});

test("API client sends the observed auth and tenant headers", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ id: "h1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new GestionaleOreClient({ token: "jwt", companyId: "company", userId: "user", fetchImpl });
  await client.createHour({ userId: "u1", qty: "02:00" });
  assert.equal(captured.url, "https://api.gestionaleore.it/hours");
  assert.equal(captured.options.headers.Authorization, "Bearer jwt");
  assert.equal(captured.options.headers.companyId, "company");
  assert.equal(captured.options.headers.userId, "user");
  assert.deepEqual(JSON.parse(captured.options.body), { userId: "u1", qty: "02:00" });
});

test("listAll follows Gestionale Ore pagination", async () => {
  const pages = [
    [[{ id: 1 }, { id: 2 }], 3],
    [[{ id: 3 }], 3],
  ];
  const fetchImpl = async url => {
    const page = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(pages[page]), { status: 200 });
  };
  const client = new GestionaleOreClient({ token: "jwt", fetchImpl });
  assert.deepEqual(await client.listAll("customers/select", { active: true }), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("API query arrays use the qs format used by Gestionale Ore", async () => {
  let capturedUrl;
  const fetchImpl = async url => {
    capturedUrl = new URL(url);
    return new Response(JSON.stringify([[], 0]), { status: 200 });
  };
  const client = new GestionaleOreClient({ token: "jwt", fetchImpl });
  await client.listAll("hours", { userId: ["u1"], day: JSON.stringify({ from: "2026-08-01", to: "2026-08-31" }) });
  assert.equal(capturedUrl.searchParams.get("userId[0]"), "u1");
  assert.equal(capturedUrl.searchParams.get("day"), '{"from":"2026-08-01","to":"2026-08-31"}');
});
