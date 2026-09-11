const API_BASE = "https://api.gestionaleore.it";

export class GestionaleOreError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.name = "GestionaleOreError";
    this.status = status;
    this.data = data;
  }
}

export class GestionaleOreClient {
  constructor({ token, companyId = "", userId = "", fetchImpl = globalThis.fetch } = {}) {
    this.token = token;
    this.companyId = companyId;
    this.userId = userId;
    this.fetchImpl = fetchImpl;
  }

  static async signIn(username, password, { long = true, fetchImpl = globalThis.fetch } = {}) {
    const response = await fetchImpl(`${API_BASE}/auth/signin`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username, password, long }),
    });
    const data = await parseResponse(response);
    if (!response.ok) throw apiError(response, data, "Accesso non riuscito");
    return data;
  }

  static async verifyTwoFa(preAuthToken, code, { fetchImpl = globalThis.fetch } = {}) {
    const response = await fetchImpl(`${API_BASE}/auth/verify-2fa`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        preAuthToken,
        code,
        deviceInfo: "Gestionale Ore Helper macOS",
      }),
    });
    const data = await parseResponse(response);
    if (!response.ok) throw apiError(response, data, "Verifica a due fattori non riuscita");
    return data;
  }

  async request(method, path, { body, query } = {}) {
    const url = new URL(path.replace(/^\//, ""), `${API_BASE}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        if (Array.isArray(value)) value.forEach((item, index) => url.searchParams.append(`${key}[${index}]`, String(item)));
        else url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    const headers = {
      accept: "application/json",
      Authorization: `Bearer ${this.token}`,
      goversion: "25003 helper-macos",
      companyId: this.companyId,
      userId: this.userId,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await parseResponse(response);
    if (!response.ok) throw apiError(response, data, `Richiesta ${method} ${url.pathname} non riuscita`);
    return data;
  }

  checkJwt() {
    return this.request("POST", "auth/check-jwt", { body: {} });
  }

  createHour(payload) {
    return this.request("POST", "hours", { body: payload });
  }

  async list(path, query = {}) {
    const data = await this.request("GET", path, { query });
    return normalizeList(data);
  }

  async listAll(path, query = {}) {
    const items = [];
    for (let page = 0; page < 100; page += 1) {
      const data = await this.request("GET", path, { query: { ...query, page } });
      const current = normalizeList(data);
      const total = listTotal(data);
      items.push(...current);
      if (current.length === 0 || total === undefined || items.length >= total) break;
    }
    return items;
  }
}

function apiError(response, data, fallback) {
  const message = data?.message ?? data?.error ?? data?.errors?.[0]?.message ?? fallback;
  return new GestionaleOreError(message, { status: response.status, data });
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function normalizeList(data) {
  const value = data?.data ?? data;
  if (Array.isArray(value) && Array.isArray(value[0])) return value[0];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function listTotal(data) {
  const value = data?.data ?? data;
  if (Array.isArray(value) && Array.isArray(value[0]) && Number.isFinite(Number(value[1]))) return Number(value[1]);
  if (Number.isFinite(Number(value?.total))) return Number(value.total);
  if (Number.isFinite(Number(value?.count))) return Number(value.count);
  return undefined;
}

export function labelOf(item) {
  if (!item) return "";
  const direct = item.label ?? item.businessName ?? item.description ?? item.name;
  if (direct) return String(direct).trim();
  const person = [item.firstName ?? item.name, item.lastName ?? item.surname].filter(Boolean).join(" ");
  if (person) return person;
  return [item.code, item.email, item.username, item.id].filter(Boolean).join(" · ");
}

export function parseDuration(value) {
  const match = /^\s*(\d{1,2}):([0-5]\d)\s*$/.exec(value ?? "");
  if (!match) throw new Error("Durata non valida: usa il formato H:MM, per esempio 2:00");
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes <= 0 || minutes > 24 * 60) throw new Error("La durata deve essere compresa tra 0:01 e 24:00");
  return minutes;
}

export function computeWindow(now = new Date(), durationMinutes = 120, roundMinutes = 5) {
  const end = new Date(now);
  end.setSeconds(0, 0);
  end.setMinutes(Math.floor(end.getMinutes() / roundMinutes) * roundMinutes);
  const start = new Date(end.getTime() - durationMinutes * 60_000);
  if (formatDay(start) !== formatDay(end)) {
    throw new Error("L'intervallo attraversa la mezzanotte: registralo manualmente");
  }
  return {
    day: formatDay(end),
    start: formatTime(start),
    end: formatTime(end),
    pause: "00:00",
    qty: formatDuration(durationMinutes),
  };
}

export function buildHourPayload({ preset, description, window }) {
  if (!preset?.userId) throw new Error("Il preset non contiene userId");
  if (!description?.trim()) throw new Error("Descrivi l'attività svolta");
  const payload = {
    userId: preset.userId,
    absence: false,
    customerId: preset.customerId,
    projectId: preset.projectId,
    subProjectId: preset.subProjectId,
    activityId: preset.activityId,
    activityFreeText: preset.activityId ? undefined : description.trim(),
    maintenanceId: preset.maintenanceId,
    hourTags: preset.hourTags,
    note: description.trim(),
    billingStatus: preset.billingStatus ?? "notInvoiced",
    overtime: false,
    approved: "pending",
    ...window,
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

export function validateConfig(config) {
  if (!config?.username) throw new Error("Configurazione mancante: esegui prima `npm run setup`");
  if (!config?.companyId) throw new Error("Configurazione incompleta: manca companyId");
  if (!Array.isArray(config.presets) || config.presets.length === 0) {
    throw new Error("Non ci sono preset configurati: esegui `npm run setup`");
  }
  for (const preset of config.presets) {
    if (!preset.name || !preset.userId) throw new Error("Ogni preset deve avere name e userId");
  }
  return config;
}

export function dedupeKey(payload) {
  return [payload.day, payload.start, payload.end, payload.userId, payload.customerId, payload.projectId].filter(Boolean).join("|");
}

function formatDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
