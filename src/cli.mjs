#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GestionaleOreClient,
  GestionaleOreError,
  buildHourPayload,
  computeWindow,
  dedupeKey,
  labelOf,
  parseDuration,
  validateConfig,
} from "./core.mjs";
import { createAugustPlan, formatMinutes, planSummary, reconcilePlan, resolveCustomers } from "./backfill.mjs";
import { askText, chooseMany, chooseOne, confirm, keychainDelete, keychainGet, keychainSet, notify } from "./macos.mjs";

const execFileAsync = promisify(execFile);
const APP_ID = "it.scalingparrots.gestionale-ore-helper";
const KEYCHAIN_TOKEN = `${APP_ID}.token`;
const APP_HOME = process.env.GESTIONALE_ORE_HOME ?? path.join(os.homedir(), ".config", "gestionale-ore-helper");
const CONFIG_PATH = path.join(APP_HOME, "config.json");
const STATE_PATH = path.join(APP_HOME, "state.json");
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_ID}.plist`);

const command = process.argv[2] ?? "help";
const dryRun = process.argv.includes("--dry-run");
const apply = process.argv.includes("--apply");

try {
  switch (command) {
    case "setup":
      await setup();
      break;
    case "login":
      await refreshLogin();
      break;
    case "prompt":
      await promptAndSubmit({ dryRun });
      break;
    case "doctor":
      await doctor();
      break;
    case "backfill-august":
      await backfillAugust({ year: Number(argumentValue("--year") ?? 2026), apply });
      break;
    case "install-agent":
      await installAgent();
      break;
    case "uninstall-agent":
      await uninstallAgent();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Comando sconosciuto: ${command}`);
  }
} catch (error) {
  const message = readableError(error);
  console.error(`Errore: ${message}`);
  if (command === "prompt" || command === "backfill-august") await notify("Gestionale Ore", `Operazione non completata: ${message}`).catch(() => {});
  process.exitCode = 1;
}

async function setup() {
  requireMac();
  const existing = await readJson(CONFIG_PATH, {});
  const authenticated = await interactiveLogin(existing.username);
  if (!authenticated) return;
  const { username, auth } = authenticated;

  const bootstrap = new GestionaleOreClient({ token: auth.accessToken });
  const session = await bootstrap.checkJwt();
  const user = session?.user ?? session?.data?.user;
  const settings = session?.settings ?? session?.data?.settings ?? {};
  if (!user?.id) throw new Error("Non riesco a ricavare l'utente dalla sessione");
  const companyId = user.company?.registrationEmail;
  const requestUserId = user.username || user.email || username;
  const client = new GestionaleOreClient({
    token: auth.accessToken,
    companyId,
    userId: requestUserId,
  });

  const presets = await configurePresets(client, user, settings);
  if (!presets?.length) return;
  const config = {
    version: 1,
    username,
    companyId,
    requestUserId,
    intervalMinutes: existing.intervalMinutes ?? 120,
    promptHours: existing.promptHours ?? [10, 12, 14, 16, 18],
    workdays: existing.workdays ?? [1, 2, 3, 4, 5],
    settings: {
      hoursEntryMode: settings.hoursEntryMode,
      hoursQtyEntryMode: settings.hoursQtyEntryMode,
      activitiesFixed: settings.activitiesFixed,
    },
    presets: presets.reduce(mergePreset, existing.presets ?? []),
  };

  await fs.mkdir(APP_HOME, { recursive: true, mode: 0o700 });
  await writeJsonSecure(CONFIG_PATH, config);
  await keychainSet(KEYCHAIN_TOKEN, username, auth.accessToken);
  console.log(`Configurazione salvata in ${CONFIG_PATH}`);
  const summary = presets.length === 1 ? presets[0].name : `${presets.length} clienti aggiunti`;
  await notify("Gestionale Ore", `Configurazione pronta: ${summary}`);
}

async function refreshLogin() {
  requireMac();
  const config = await readJson(CONFIG_PATH, {});
  const authenticated = await interactiveLogin(config.username);
  if (!authenticated) return;
  await keychainSet(KEYCHAIN_TOKEN, authenticated.username, authenticated.auth.accessToken);
  if (config.username && config.username !== authenticated.username) {
    config.username = authenticated.username;
    await writeJsonSecure(CONFIG_PATH, config);
  }
  console.log("Sessione aggiornata nel Portachiavi macOS.");
  await notify("Gestionale Ore", "Sessione aggiornata");
}

async function interactiveLogin(defaultUsername = "") {
  const username = await askText("Gestionale Ore", "Email o username", defaultUsername ?? "");
  if (!username) return undefined;
  const password = await askText("Gestionale Ore", "Password (usata solo per questo login, non verrà salvata)", "", true);
  if (!password) return undefined;
  let auth = await GestionaleOreClient.signIn(username, password);
  if (auth.twoFaRequired) {
    const code = await askText("Gestionale Ore", "Codice di verifica a due fattori", "");
    if (!code) return undefined;
    auth = await GestionaleOreClient.verifyTwoFa(auth.preAuthToken, code);
  }
  if (!auth.accessToken) throw new Error("Il login non ha restituito un access token");
  return { username, auth };
}

async function configurePreset(client, user, settings) {
  const mode = settings.hoursEntryMode ?? "customer";
  const showCustomer = mode === "customer" || mode === "dynamic" || settings.timesheetSelectCustomer;
  const showProject = mode !== "customer";
  const showSubProject = !["customer", "project"].includes(mode);
  const preset = { name: "Lavoro", userId: user.id, billingStatus: "notInvoiced" };

  if (showCustomer) {
    const customers = await client.listAll("customers/select", { active: true });
    const picked = await pickEntity("Seleziona il cliente", customers);
    if (!picked) return undefined;
    preset.customerId = picked.id;
    preset.name = labelOf(picked);
  }
  if (showProject) {
    const projects = await client.listAll("projects/assigned", { active: true, customerId: preset.customerId });
    const picked = await pickEntity("Seleziona la commessa", projects, mode === "dynamic");
    if (!picked && mode !== "dynamic") return undefined;
    if (picked) {
      preset.projectId = picked.id;
      preset.customerId ??= picked.customerId;
      preset.name = labelOf(picked);
    }
  }
  if (showSubProject && preset.projectId) {
    const subprojects = await client.listAll(`projects/assigned/${preset.projectId}`, { active: true });
    const picked = await pickEntity("Seleziona la sotto-commessa", subprojects, mode !== "subproject");
    if (!picked && mode === "subproject") return undefined;
    if (picked) preset.subProjectId = picked.id;
  }
  if (settings.activitiesFixed) {
    const activities = await client.listAll("activities/select", { active: true });
    const picked = await pickEntity("Seleziona l'attività", activities);
    if (!picked) return undefined;
    preset.activityId = picked.id;
    preset.name = `${preset.name} · ${labelOf(picked)}`;
  }
  const customName = await askText("Gestionale Ore", "Nome breve del preset", preset.name);
  if (!customName) return undefined;
  preset.name = customName.trim();
  return preset;
}

async function configurePresets(client, user, settings) {
  const mode = settings.hoursEntryMode ?? "customer";
  if (mode !== "customer" || settings.activitiesFixed) {
    const preset = await configurePreset(client, user, settings);
    return preset ? [preset] : undefined;
  }

  const customers = await client.listAll("customers/select", { active: true });
  const picked = await pickEntities(
    "Seleziona uno o più clienti (⌘-clic o Maiusc-clic)",
    customers,
  );
  if (!picked?.length) return undefined;

  const presets = picked.map(customer => ({
    name: labelOf(customer),
    userId: user.id,
    billingStatus: "notInvoiced",
    customerId: customer.id,
  }));

  if (presets.length === 1) {
    const customName = await askText("Gestionale Ore", "Nome breve del preset", presets[0].name);
    if (!customName) return undefined;
    presets[0].name = customName.trim();
  }
  return presets;
}

async function pickEntity(message, items, allowNone = false) {
  if (!items.length) {
    if (allowNone) return undefined;
    throw new Error(`${message}: nessun elemento disponibile`);
  }
  const rows = items.map((item, index) => `${String(index + 1).padStart(2, "0")} · ${labelOf(item)}`);
  if (allowNone) rows.unshift("00 · Nessuno");
  const picked = await chooseOne("Gestionale Ore", message, rows, rows[0]);
  if (!picked || picked.startsWith("00 ·")) return undefined;
  return items[Number(picked.slice(0, 2)) - 1];
}

async function pickEntities(message, items) {
  if (!items.length) throw new Error(`${message}: nessun elemento disponibile`);
  const rows = items.map((item, index) => `${String(index + 1).padStart(2, "0")} · ${labelOf(item)}`);
  const picked = await chooseMany("Gestionale Ore", message, rows);
  if (!picked) return undefined;
  const byRow = new Map(rows.map((row, index) => [row, items[index]]));
  return picked.map(row => byRow.get(row)).filter(Boolean);
}

async function promptAndSubmit({ dryRun = false } = {}) {
  requireMac();
  const config = validateConfig(await readJson(CONFIG_PATH));
  const presetName = await chooseOne("Gestionale Ore", "Su cosa hai lavorato?", config.presets.map(p => p.name), config.presets[0].name);
  if (!presetName) return;
  const preset = config.presets.find(p => p.name === presetName);
  const description = await askText("Gestionale Ore", "Cosa hai fatto nelle ultime ore?", "");
  if (!description?.trim()) return;
  const duration = await chooseOne("Gestionale Ore", "Quanto tempo vuoi registrare?", ["2:00", "1:30", "1:00", "0:30"], durationLabel(config.intervalMinutes));
  if (!duration) return;
  const window = computeWindow(new Date(), parseDuration(duration));
  const payload = buildHourPayload({ preset, description, window });
  const summary = `${preset.name}\n${payload.day} · ${payload.start}–${payload.end} (${payload.qty})\n${payload.note}`;
  if (!(await confirm("Gestionale Ore", summary, dryRun ? "Simula" : "Registra"))) return;

  const state = await readJson(STATE_PATH, {});
  const key = dedupeKey(payload);
  if (!dryRun && state.lastSubmission?.key === key) {
    throw new Error("Questo intervallo risulta già registrato; nessun duplicato è stato inviato");
  }
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    await notify("Gestionale Ore", "Simulazione completata: nessun dato inviato");
    return;
  }

  const client = await authenticatedClient(config);
  let result;
  try {
    result = await client.createHour(payload);
  } catch (error) {
    if (error instanceof GestionaleOreError && [401, 403].includes(error.status)) {
      throw new Error("La sessione è scaduta: esegui `npm run login` per rinnovarla");
    }
    throw error;
  }
  await fs.mkdir(APP_HOME, { recursive: true, mode: 0o700 });
  await writeJsonSecure(STATE_PATH, { lastSubmission: { key, at: new Date().toISOString(), responseId: result?.id } });
  await notify("Gestionale Ore", `${payload.qty} registrate su ${preset.name}`);
}

async function authenticatedClient(config) {
  const token = await keychainGet(KEYCHAIN_TOKEN, config.username);
  if (!token) throw new Error("Sessione non trovata nel Portachiavi: esegui `npm run login`");
  return new GestionaleOreClient({ token, companyId: config.companyId, userId: config.requestUserId });
}

async function doctor() {
  requireMac();
  const config = validateConfig(await readJson(CONFIG_PATH));
  const client = await authenticatedClient(config);
  let session;
  try {
    session = await client.checkJwt();
  } catch (error) {
    if (error instanceof GestionaleOreError && [401, 403].includes(error.status)) {
      throw new Error("La sessione è scaduta: esegui `npm run login`");
    }
    throw error;
  }
  console.log(`Connessione OK · ${session?.user?.email ?? session?.data?.user?.email ?? config.username}`);
  console.log(`Preset: ${config.presets.map(p => p.name).join(", ")}`);
  console.log(`Orari: lun–ven alle ${config.promptHours.map(h => String(h).padStart(2, "0") + ":00").join(", ")}`);
}

async function backfillAugust({ year, apply = false }) {
  requireMac();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("Anno non valido");
  const config = validateConfig(await readJson(CONFIG_PATH));
  const client = await authenticatedClient(config);
  let session;
  try {
    session = await client.checkJwt();
  } catch (error) {
    if (error instanceof GestionaleOreError && [401, 403].includes(error.status)) {
      throw new Error("La sessione è scaduta: esegui `npm run login`, poi ripeti la simulazione");
    }
    throw error;
  }
  const sessionUser = session?.user ?? session?.data?.user;
  const userId = sessionUser?.id ?? config.presets[0]?.userId;
  if (!userId) throw new Error("Non riesco a determinare l'utente del backfill");

  const customers = await client.listAll("customers/select", { active: true });
  const presets = resolveCustomers(customers, userId);
  const plan = createAugustPlan(year, presets);
  const from = `${year}-08-01`;
  const to = `${year}-08-31`;
  const existing = await client.listAll("hours", {
    userId: [userId],
    day: JSON.stringify({ from, to }),
  });
  const reconciliation = reconcilePlan(plan, existing);
  printBackfillPlan(plan, reconciliation, year);

  if (reconciliation.conflicts.length) {
    throw new Error(`${reconciliation.conflicts.length} registrazioni esistenti non coincidono col piano; nessun dato è stato inviato`);
  }
  if (!apply) {
    console.log("\nSIMULAZIONE: nessun dato inviato.");
    console.log(`Per applicare: node src/cli.mjs backfill-august --year=${year} --apply --confirm=AGOSTO-${year}`);
    return;
  }
  if (argumentValue("--confirm") !== `AGOSTO-${year}`) {
    throw new Error(`Per l'invio reale aggiungi --confirm=AGOSTO-${year}`);
  }
  if (!reconciliation.pending.length) {
    console.log("Tutte le registrazioni del piano sono già presenti.");
    return;
  }
  const accepted = await confirm(
    "Backfill Gestionale Ore",
    `Stai per creare ${reconciliation.pending.length} registrazioni per agosto ${year}, per un totale di ${formatMinutes(planSummary(reconciliation.pending).totalMinutes)}.`,
    "Registra tutto",
  );
  if (!accepted) return;

  let completed = 0;
  for (const item of reconciliation.pending) {
    await client.createHour(item.payload);
    completed += 1;
    console.log(`Creato ${item.payload.day} ${item.payload.start}-${item.payload.end} · ${item.presetName}`);
  }
  await notify("Gestionale Ore", `Backfill agosto ${year} completato: ${completed} registrazioni create`);
}

function printBackfillPlan(plan, reconciliation, year) {
  console.log(`Backfill agosto ${year} · ${planSummary(plan).totalMinutes / 60} ore`);
  console.log("\nData       Orario       Ore    Cliente");
  console.log("---------- ------------ ------ -------------------------");
  for (const item of plan) {
    const present = reconciliation.alreadyPresent.includes(item) ? " ✓" : "";
    console.log(`${item.payload.day} ${item.payload.start}-${item.payload.end} ${item.payload.qty.padStart(6)} ${item.presetName}${present}`);
  }
  console.log("\nRipartizione:");
  for (const [name, minutes] of Object.entries(planSummary(plan).byProject)) {
    console.log(`- ${name}: ${formatMinutes(minutes)}`);
  }
  console.log(`\nGià presenti e identiche: ${reconciliation.alreadyPresent.length}`);
  console.log(`Da creare: ${reconciliation.pending.length}`);
  if (reconciliation.conflicts.length) {
    console.log("Conflitti rilevati:");
    for (const hour of reconciliation.conflicts) {
      console.log(`- ${hour.day} ${String(hour.start ?? "").slice(0, 5)}-${String(hour.end ?? "").slice(0, 5)} ${hour.qty ?? ""} · ${hour.customerLabel ?? hour.customerId ?? "voce esistente"}`);
    }
  }
}

async function installAgent() {
  requireMac();
  const config = validateConfig(await readJson(CONFIG_PATH));
  await fs.mkdir(path.dirname(PLIST_PATH), { recursive: true });
  await fs.mkdir(APP_HOME, { recursive: true, mode: 0o700 });
  const cliPath = path.resolve(process.argv[1]);
  const calendarEntries = config.workdays.flatMap(weekday => config.promptHours.map(hour => ({ weekday, hour })));
  const plist = buildPlist({ cliPath, calendarEntries });
  await fs.writeFile(PLIST_PATH, plist, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  await execFileAsync("launchctl", ["bootout", domain, PLIST_PATH]).catch(() => {});
  await execFileAsync("launchctl", ["bootstrap", domain, PLIST_PATH]);
  console.log(`Promemoria installato: ${PLIST_PATH}`);
  await notify("Gestionale Ore", "Promemoria ogni due ore attivato");
}

async function uninstallAgent() {
  requireMac();
  const config = await readJson(CONFIG_PATH, {});
  const domain = `gui/${process.getuid()}`;
  await execFileAsync("launchctl", ["bootout", domain, PLIST_PATH]).catch(() => {});
  await fs.unlink(PLIST_PATH).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (config.username) await keychainDelete(KEYCHAIN_TOKEN, config.username);
  console.log("Promemoria disinstallato. La configurazione è stata conservata.");
}

function buildPlist({ cliPath, calendarEntries }) {
  const calendar = calendarEntries.map(({ weekday, hour }) => `
    <dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${APP_ID}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(cliPath)}</string><string>prompt</string></array>
  <key>StartCalendarInterval</key><array>${calendar}
  </array>
  <key>StandardOutPath</key><string>${xml(path.join(APP_HOME, "helper.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(APP_HOME, "helper-error.log"))}</string>
</dict></plist>\n`;
}

function mergePreset(presets, preset) {
  return [...presets.filter(item => item.name !== preset.name), preset];
}

function durationLabel(minutes = 120) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function argumentValue(name) {
  const prefixed = process.argv.find(value => value.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readableError(error) {
  if (error instanceof GestionaleOreError) return `${error.message}${error.status ? ` (HTTP ${error.status})` : ""}`;
  return error?.message ?? String(error);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    if (error.code === "ENOENT") throw new Error("Configurazione non trovata: esegui prima `npm run setup`");
    throw error;
  }
}

async function writeJsonSecure(file, value) {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
}

function requireMac() {
  if (process.platform !== "darwin") throw new Error("Questo MVP usa i dialog e il Portachiavi di macOS");
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function printHelp() {
  console.log(`Gestionale Ore Helper

  npm run setup          configura account e uno o più preset
  npm run login          rinnova soltanto la sessione JWT
  npm run dry-run        prova il flusso senza inviare dati
  npm run doctor         verifica login e configurazione
  npm run backfill:august simula il backfill di agosto 2026
  npm run install-agent  attiva i prompt lun-ven ogni due ore
  npm run prompt         apre subito il prompt e registra
  npm run uninstall-agent disattiva i prompt pianificati`);
}
