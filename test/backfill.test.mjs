import test from "node:test";
import assert from "node:assert/strict";
import { augustWeekdays, createAugustPlan, planSummary, reconcilePlan, resolveCustomers } from "../src/backfill.mjs";

const presets = Object.fromEntries(["csa", "tobetok", "certyclick", "martino", "enercoin"].map(key => [key, {
  name: key,
  userId: "user-1",
  customerId: `customer-${key}`,
}]));

test("August 2026 has 21 weekdays", () => {
  assert.equal(augustWeekdays(2026).length, 21);
  assert.equal(augustWeekdays(2026)[0], "2026-08-03");
  assert.equal(augustWeekdays(2026).at(-1), "2026-08-31");
});

test("August plan totals 168 hours and eight hours every weekday", () => {
  const plan = createAugustPlan(2026, presets);
  const summary = planSummary(plan);
  assert.equal(summary.totalMinutes, 168 * 60);
  assert.ok(Object.values(summary.byDay).every(minutes => minutes === 8 * 60));
  assert.deepEqual(summary.byProject, {
    csa: 64 * 60,
    tobetok: 20 * 60,
    certyclick: 10 * 60,
    martino: 10 * 60,
    enercoin: 64 * 60,
  });
});

test("customer aliases resolve requested projects", () => {
  const customers = [
    { id: "1", businessName: "EnerCoin" },
    { id: "2", businessName: "CSA - Football Exchange" },
    { id: "3", businessName: "Tobetok Srl" },
    { id: "4", businessName: "Certyclick" },
    { id: "5", businessName: "Martino Parisi" },
  ];
  const result = resolveCustomers(customers, "user-1");
  assert.equal(result.csa.customerId, "2");
  assert.equal(result.enercoin.customerId, "1");
});

test("reconciliation skips exact entries and blocks different existing hours", () => {
  const plan = createAugustPlan(2026, presets);
  const exact = { ...plan[0].payload };
  const conflict = { ...plan[1].payload, start: "10:00", end: "18:00" };
  const result = reconcilePlan(plan, [exact, conflict]);
  assert.equal(result.alreadyPresent.length, 1);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.pending.length, plan.length - 1);
});

test("reconciliation treats a duplicate exact entry as a conflict", () => {
  const plan = createAugustPlan(2026, presets);
  const exact = { ...plan[0].payload };
  const result = reconcilePlan(plan, [exact, { ...exact, id: "duplicate" }]);
  assert.equal(result.alreadyPresent.length, 1);
  assert.equal(result.conflicts.length, 1);
});
