import { buildHourPayload } from "./core.mjs";

const MINUTES_PER_DAY = 8 * 60;

export const AUGUST_ALLOCATION = {
  csa: 64 * 60,
  tobetok: 20 * 60,
  certyclick: 10 * 60,
  martino: 10 * 60,
  enercoin: 64 * 60,
};

export const CUSTOMER_ALIASES = {
  csa: ["CSA/Football Exchange", "Football Exchange", "CSA"],
  tobetok: ["Tobetok"],
  certyclick: ["Certyclick"],
  martino: ["Martino Parisi"],
  enercoin: ["EnerCoin", "Enercoin"],
};

export function augustWeekdays(year) {
  const days = [];
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(year, 7, day, 12, 0, 0, 0);
    if (date.getMonth() !== 7) break;
    if (date.getDay() >= 1 && date.getDay() <= 5) days.push(formatDay(date));
  }
  return days;
}

export function createAugustPlan(year, presetsByKey) {
  const days = augustWeekdays(year);
  if (days.length !== 21) {
    throw new Error(`Agosto ${year} ha ${days.length} giorni feriali; questo piano richiede esattamente 21 giorni`);
  }
  for (const key of Object.keys(AUGUST_ALLOCATION)) {
    if (!presetsByKey[key]?.userId) throw new Error(`Preset non risolto: ${key}`);
  }

  const plan = [];
  const addFullDay = (day, key) => plan.push(entry(day, "09:00", "18:00", "01:00", "08:00", key, presetsByKey[key], year));

  days.slice(0, 8).forEach(day => addFullDay(day, "csa"));
  days.slice(8, 10).forEach(day => addFullDay(day, "tobetok"));
  addFullDay(days[10], "certyclick");
  addFullDay(days[11], "martino");

  const splitDay = days[12];
  plan.push(entry(splitDay, "09:00", "13:00", "00:00", "04:00", "tobetok", presetsByKey.tobetok, year));
  plan.push(entry(splitDay, "14:00", "16:00", "00:00", "02:00", "certyclick", presetsByKey.certyclick, year));
  plan.push(entry(splitDay, "16:00", "18:00", "00:00", "02:00", "martino", presetsByKey.martino, year));

  days.slice(13).forEach(day => addFullDay(day, "enercoin"));
  assertPlan(plan, days);
  return plan;
}

function entry(day, start, end, pause, qty, key, preset, year) {
  const description = `Attività ${preset.name} — backfill agosto ${year}`;
  return {
    key,
    presetName: preset.name,
    minutes: parseTime(qty),
    payload: buildHourPayload({
      preset,
      description,
      window: { day, start, end, pause, qty },
    }),
  };
}

export function resolveCustomers(customers, userId) {
  const result = {};
  for (const [key, aliases] of Object.entries(CUSTOMER_ALIASES)) {
    const matches = customers
      .map(customer => ({ customer, score: matchScore(customerLabel(customer), aliases) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!matches.length) {
      throw new Error(`Cliente non trovato per ${aliases[0]}. Disponibili: ${customers.map(customerLabel).join(", ")}`);
    }
    if (matches[1] && matches[1].score === matches[0].score) {
      throw new Error(`Cliente ambiguo per ${aliases[0]}: ${matches.filter(m => m.score === matches[0].score).map(m => customerLabel(m.customer)).join(", ")}`);
    }
    const customer = matches[0].customer;
    result[key] = {
      name: customerLabel(customer),
      userId,
      customerId: customer.id,
      billingStatus: "notInvoiced",
    };
  }
  return result;
}

export function reconcilePlan(plan, existingHours) {
  const plannedDays = new Set(plan.map(item => item.payload.day));
  const exact = new Set();
  const conflicts = [];
  for (const existing of existingHours) {
    if (!plannedDays.has(existing.day)) continue;
    const index = plan.findIndex(item => sameHour(item.payload, existing));
    if (index >= 0 && !exact.has(index)) exact.add(index);
    else conflicts.push(existing);
  }
  return {
    alreadyPresent: plan.filter((_, index) => exact.has(index)),
    pending: plan.filter((_, index) => !exact.has(index)),
    conflicts,
  };
}

export function planSummary(plan) {
  const byProject = {};
  const byDay = {};
  for (const item of plan) {
    byProject[item.presetName] = (byProject[item.presetName] ?? 0) + item.minutes;
    byDay[item.payload.day] = (byDay[item.payload.day] ?? 0) + item.minutes;
  }
  return { byProject, byDay, totalMinutes: plan.reduce((sum, item) => sum + item.minutes, 0) };
}

export function formatMinutes(minutes) {
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

function assertPlan(plan, days) {
  const summary = planSummary(plan);
  if (summary.totalMinutes !== 168 * 60) throw new Error("Il piano non totalizza 168 ore");
  for (const day of days) {
    if (summary.byDay[day] !== MINUTES_PER_DAY) throw new Error(`${day} non totalizza 8 ore`);
  }
  for (const [key, expected] of Object.entries(AUGUST_ALLOCATION)) {
    const actual = plan.filter(item => item.key === key).reduce((sum, item) => sum + item.minutes, 0);
    if (actual !== expected) throw new Error(`Allocazione errata per ${key}: ${actual} minuti anziché ${expected}`);
  }
}

function sameHour(planned, existing) {
  return planned.day === existing.day
    && planned.start === shortTime(existing.start)
    && planned.end === shortTime(existing.end)
    && planned.qty === shortTime(existing.qty)
    && planned.userId === existing.userId
    && planned.customerId === existing.customerId;
}

function shortTime(value) {
  if (typeof value !== "string") return value;
  return value.slice(0, 5);
}

function customerLabel(customer) {
  return String(customer.businessName ?? customer.label ?? customer.description ?? customer.name ?? customer.id).trim();
}

function matchScore(label, aliases) {
  const normalized = normalize(label);
  let best = 0;
  for (const alias of aliases) {
    const candidate = normalize(alias);
    if (normalized === candidate) best = Math.max(best, 1000 + candidate.length);
    else if (normalized.includes(candidate) || candidate.includes(normalized)) best = Math.max(best, 100 + Math.min(normalized.length, candidate.length));
  }
  return best;
}

function normalize(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
