// relative imports only: worker.ts (cron) bundles this file outside Next
export type Env = CloudflareEnv & { ADMIN_PASSWORD: string; GDRIVE_CLIENT_ID: string; GDRIVE_CLIENT_SECRET: string; GDRIVE_REFRESH_TOKEN: string };
export type Site = { id: string; url: string; secret: string; allowed_admins: string; created_at: number; org_id: string | null };
export type Org = { id: string; name: string; created_at: number; sites: number };
export type Report = { id: number; site_id: string; type: string; ok: number; data: string; created_at: number };

export const REPORT_TYPES = ["status", "scan", "backup", "update", "restore", "connector", "user", "settings"];
// connector plugin version this hub serves at /wp-control-hub.zip; must match the plugin header (checked in hub.test.ts)
export const PLUGIN_VERSION = "0.5.3";
export type BackupScope = "both" | "db" | "files";
const enc = new TextEncoder();

// HMAC-SHA256 hex of "<ts>.<body>" — must match wpch_sign() in the plugin
export async function sign(secret: string, ts: string, body: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verify(secret: string, ts: string, body: string, sig: string) {
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  return safeEqual(await sign(secret, ts, body), sig);
}

/* Dashboard login. Hub users live in D1 (role "super" manages hub users, "manager" runs the sites).
   Built-in break-glass super admin: username "admin" + the ADMIN_PASSWORD secret.
   Session = "<uid>.<expiry>.<hmac>" keyed by ADMIN_PASSWORD, so changing that secret logs everyone out;
   the user row is re-read on every request, so a deleted user is out immediately. Checked in worker.ts. */
export const SESSION_COOKIE = "wpch_session";
export const SESSION_TTL = 7 * 86_400;
export const ROOT_USERNAME = "admin";
export type Role = "super" | "manager";
// orgs: managers see only these organizations' sites; [] = all organizations (always [] for super admins)
export type HubUser = { id: string; username: string; role: Role; orgs: string[] };
const ROOT: HubUser = { id: "root", username: ROOT_USERNAME, role: "super", orgs: [] };
// user_orgs rows come back as one comma-joined column
const USER_COLS = "id, username, role, (SELECT group_concat(org_id) FROM user_orgs WHERE user_id = users.id) orgs";
const toUser = <T extends { orgs: string | null }>(r: T) => ({ ...r, orgs: r.orgs ? r.orgs.split(",") : [] });

export async function passwordOk(env: Env, pw: string) {
  // compare HMACs so timing doesn't leak the password length/prefix
  return !!env.ADMIN_PASSWORD && safeEqual(await sign(env.ADMIN_PASSWORD, "pw", pw), await sign(env.ADMIN_PASSWORD, "pw", env.ADMIN_PASSWORD));
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const PBKDF2_ITER = 100_000; // Workers' WebCrypto maximum

async function pbkdf2(pw: string, salt: Uint8Array<ArrayBuffer>, iter: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}

// "pbkdf2$<iter>$<salt hex>$<hash hex>"
export async function hashPassword(pw: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${await pbkdf2(pw, salt, PBKDF2_ITER)}`;
}

export async function checkPassword(pw: string, stored: string) {
  const [alg, iter, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2" || !hash) return false;
  return safeEqual(await pbkdf2(pw, Uint8Array.from(salt.match(/../g)!.map((h) => parseInt(h, 16))), Number(iter)), hash);
}

export async function authenticate(env: Env, username: string, pw: string): Promise<HubUser | null> {
  if (username === ROOT_USERNAME) return (await passwordOk(env, pw)) ? ROOT : null;
  const row = await env.DB.prepare(`SELECT ${USER_COLS}, pw FROM users WHERE username = ?`).bind(username).first<HubUser & { orgs: string | null; pw: string }>();
  if (!row || !(await checkPassword(pw, row.pw))) return null;
  const { id, role, orgs } = toUser(row);
  return { id, username: row.username, role, orgs };
}

export async function createSession(env: Env, uid: string, now = Date.now()) {
  const exp = String(Math.floor(now / 1000) + SESSION_TTL);
  return `${uid}.${exp}.${await sign(env.ADMIN_PASSWORD, exp, `session:${uid}`)}`;
}

export async function sessionUser(env: Env, token?: string | null): Promise<HubUser | null> {
  const [uid, exp, mac] = (token ?? "").split(".");
  if (!env.ADMIN_PASSWORD || !uid || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return null;
  if (!safeEqual(await sign(env.ADMIN_PASSWORD, exp, `session:${uid}`), mac ?? "")) return null;
  if (uid === ROOT.id) return ROOT;
  const row = await env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(uid).first<HubUser & { orgs: string | null }>();
  return row && toUser(row);
}

export async function hubUsers(env: Env) {
  const { results } = await env.DB.prepare(`SELECT ${USER_COLS}, created_at FROM users ORDER BY username`).all<HubUser & { orgs: string | null; created_at: number }>();
  return results.map(toUser);
}

// hub = this dashboard's own origin, so there's no URL to configure
export const connectionKey = (hub: string, site: Site) =>
  btoa(JSON.stringify({ hub, id: site.id, secret: site.secret }));

export async function insertReport(env: Env, siteId: string, type: string, ok: boolean, data: unknown) {
  await env.DB.prepare("INSERT INTO reports (site_id, type, ok, data, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(siteId, type, ok ? 1 : 0, JSON.stringify(data), Date.now())
    .run();
}

// Fire a job at the plugin. The plugin answers 202 and reports back to /api/report when done.
export async function sendCommand(env: Env, site: Site, cmd: string, args: Record<string, unknown> = {}) {
  const body = JSON.stringify({ cmd, args });
  const ts = String(Math.floor(Date.now() / 1000));
  try {
    const res = await fetch(`${site.url.replace(/\/+$/, "")}/?rest_route=/wpch/v1/command`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wpch-ts": ts, "x-wpch-sig": await sign(site.secret, ts, body) },
      body,
    });
    if (!res.ok) {
      await insertReport(env, site.id, cmd, false, { error: describeFailure(res.status, await res.text()) });
      return false;
    }
    return true;
  } catch (e) {
    await insertReport(env, site.id, cmd, false, { error: `Site unreachable: ${e instanceof Error ? e.message : e}` });
    return false;
  }
}

// plugin installed but its connection key never pasted (or no check has reached it yet); latest status report of any outcome
export const notConnected = (latestStatus?: Report) =>
  !latestStatus || (!latestStatus.ok && /plugin not connected/i.test(JSON.parse(latestStatus.data).error ?? ""));

const HINTS: Record<number, string> = {
  401: "a firewall or security plugin blocked the hub",
  403: "a firewall or security plugin blocked the hub",
  404: "the Control Hub plugin isn't installed or active on this site",
  429: "the site's host is rate-limiting requests",
  503: "the site shows a maintenance, coming-soon or “closed” page, or is overloaded",
};

// Readable reason for a non-2xx answer: the connector's own JSON message if there is one, else a hint plus the page's visible text.
export function describeFailure(status: number, body: string) {
  try {
    const msg = JSON.parse(body)?.message;
    if (typeof msg === "string" && msg) return msg;
  } catch {}
  const text = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const hint = HINTS[status] ?? (status >= 500 ? "the site's server had an error" : "the site refused the request");
  return `HTTP ${status}: ${hint}${text ? ` (page says: “${text.slice(0, 120)}${text.length > 120 ? "…" : ""}”)` : ""}.`;
}

/* Backups live in one Google Drive folder. The hub holds the OAuth refresh token; sites only ever get a
   one-off resumable upload URL (no auth needed to PUT to it) and download restores through /api/backup. */
export async function driveToken(env: Env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GDRIVE_CLIENT_ID ?? "", client_secret: env.GDRIVE_CLIENT_SECRET ?? "",
      refresh_token: env.GDRIVE_REFRESH_TOKEN ?? "", grant_type: "refresh_token",
    }),
  });
  const j = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`Google Drive login failed: ${j.error_description ?? j.error ?? res.status}`);
  return j.access_token;
}

async function driveUploadUrl(env: Env, name: string) {
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
    method: "POST",
    headers: { authorization: `Bearer ${await driveToken(env)}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": "application/zip" },
    body: JSON.stringify({ name, parents: [env.GDRIVE_FOLDER_ID] }),
  });
  const url = res.headers.get("location");
  if (!res.ok || !url) throw new Error(`Google Drive upload setup failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  return url;
}

// update=true: plugin backs up, uploads, runs updates, health-checks, auto-rolls back on failure
// only: update ids to install (plugin file, theme slug, "core"); omitted = all pending
// scope: what to back up; updates always take a full backup so they can roll back
export async function backup(env: Env, site: Site, update: boolean, only?: string[], scope: BackupScope = "both") {
  if (update) scope = "both";
  const name = `${host(site.url)}_${new Date().toISOString().replace(/[:.]/g, "-")}${scope === "both" ? "" : `_${scope}`}.zip`;
  let put_url: string;
  try {
    put_url = await driveUploadUrl(env, name);
  } catch (e) {
    // no backup → no update either; say why in Activity instead of failing silently
    return insertReport(env, site.id, "backup", false, { error: `${e instanceof Error ? e.message : e}${update ? " (updates skipped)" : ""}` });
  }
  await queue(env, site, "backup", { name, put_url, update, scope, ...(only && { only }) },
    update ? "Backup & update" : scope === "db" ? "Database backup" : scope === "files" ? "Files backup" : "Backup", update ? "update" : "backup");
}

// send a command and log that it started, so pages show it running until the site reports back.
// kind = the report type that means it finished
export async function queue(env: Env, site: Site, cmd: string, args: Record<string, unknown> | undefined, job: string, kind = cmd) {
  if (await sendCommand(env, site, cmd, args)) await insertReport(env, site.id, "queued", true, { job, kind });
}

const JOB_TIMEOUT = 30 * 60_000; // no reply by then: assume the site never ran it

const finishes = (kind: string | undefined, r: Report) =>
  !kind ? r.type !== "queued" // markers from before kinds were recorded
  : r.type === kind
    // "Backup & update" ends at the backup report when the backup failed or there was nothing to update
    || (kind === "update" && r.type === "backup" && (!r.ok || !JSON.parse(r.data).update));

// started jobs with no result yet, oldest first; reports in any order
export function runningJobs(reports: Report[], now: number) {
  return reports
    .filter((q) => q.type === "queued" && now - q.created_at < JOB_TIMEOUT)
    .map((q) => ({ ...q, ...(JSON.parse(q.data) as { job: string; kind?: string }) }))
    .filter((q) => !reports.some((r) => r.site_id === q.site_id && r.id > q.id && finishes(q.kind, r)))
    .sort((a, b) => a.id - b.id);
}

export async function recentReports(env: Env, now: number) {
  const { results } = await env.DB.prepare("SELECT * FROM reports WHERE created_at > ?").bind(now - JOB_TIMEOUT).all<Report>();
  return results;
}

// site downloads the hub's own /wp-control-hub.zip and installs it over itself
export async function updateConnector(env: Env, site: Site) {
  await queue(env, site, "connector", undefined, "Connector update");
}

// add: WordPress emails the new user a set-password link, so no password passes through the hub
export const SETTINGS = { maintenance: "Maintenance mode", debug: "Debug mode", debug_log: "Debug log" } as const;
export type Setting = keyof typeof SETTINGS;

export async function siteSetting(env: Env, site: Site, setting: Setting, on: boolean) {
  await queue(env, site, "settings", { [setting]: on }, `Turning ${SETTINGS[setting].toLowerCase()} ${on ? "on" : "off"}`);
}

export async function userCommand(env: Env, site: Site, args: { action: "add"; login: string; email: string; role: string } | { action: "delete"; login: string }) {
  await queue(env, site, "user", args, `${args.action === "add" ? "Adding" : "Deleting"} user ${args.login}`);
}

// version the site last reported; undefined = plugin older than 0.3.0 (can't self-update, needs one manual install)
export const connectorVersion = (status?: Report) => (status?.ok ? (JSON.parse(status.data).connector as string | undefined) : undefined);

// key = Drive file id; only ids this site reported as its own backups
export async function siteOwnsBackup(env: Env, siteId: string, key: string) {
  return !!(await env.DB.prepare("SELECT 1 FROM reports WHERE site_id = ? AND type = 'backup' AND ok = 1 AND json_extract(data, '$.key') = ?")
    .bind(siteId, key).first());
}

export async function restore(env: Env, site: Site, key: string) {
  if (!(await siteOwnsBackup(env, site.id, key))) throw new Error("Backup does not belong to this site");
  await queue(env, site, "restore", { key }, "Restore");
}

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");

export const JOBS = { status: "Checking for updates", scan: "Malware scan" } as const;

export async function runDaily(env: Env, now = Date.now()) {
  const { results: sites } = await env.DB.prepare("SELECT * FROM sites").all<Site>();
  const scanDay = Math.floor(now / 86_400_000) % 2 === 0; // every 2nd day
  // shortcut: one fetch per command per site; Workers paid plan allows 1000 subrequests (~300 sites), shard the loop beyond that
  await Promise.allSettled(
    sites.map(async (site) => {
      await queue(env, site, "status", undefined, JOBS.status);
      await backup(env, site, true);
      if (scanDay) await queue(env, site, "scan", undefined, JOBS.scan);
    }),
  );
}

// The one access rule for sites: super admins and unrestricted managers see all, the rest only their organizations'.
export const canSee = (user: HubUser | null, site: Pick<Site, "org_id">) =>
  !!user && (user.role === "super" || user.orgs.length === 0 || (!!site.org_id && user.orgs.includes(site.org_id)));
export const isRestricted = (user: HubUser | null) => user?.role === "manager" && user.orgs.length > 0;

export async function getOrgs(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT o.*, (SELECT COUNT(*) FROM sites s WHERE s.org_id = o.id) sites FROM orgs o ORDER BY o.name COLLATE NOCASE",
  ).all<Org>();
  return results;
}

export async function getSites(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM sites ORDER BY url").all<Site>();
  return results;
}

export async function getSite(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<Site>();
}

// latest report of each type, keyed "<site_id>:<type>"
export async function latestReports(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT r.* FROM reports r JOIN (SELECT MAX(id) id FROM reports GROUP BY site_id, type) l ON r.id = l.id`,
  ).all<Report>();
  return new Map(results.map((r) => [`${r.site_id}:${r.type}`, r]));
}

export async function siteReports(env: Env, siteId: string, limit = 50) {
  const { results } = await env.DB.prepare("SELECT * FROM reports WHERE site_id = ? ORDER BY id DESC LIMIT ?")
    .bind(siteId, limit)
    .all<Report>();
  return results;
}

// shortcut: capped at 2000 rows; a daily cron makes ~5 rows/day, so 90 days fits easily
export async function siteReportsSince(env: Env, siteId: string, since: number) {
  const { results } = await env.DB.prepare("SELECT * FROM reports WHERE site_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 2000")
    .bind(siteId, since)
    .all<Report>();
  return results;
}

export async function siteBackups(env: Env, siteId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM reports WHERE site_id = ? AND type = 'backup' AND ok = 1 ORDER BY id DESC LIMIT 60",
  )
    .bind(siteId)
    .all<Report>();
  return results.map((r) => ({ ...r, ...(JSON.parse(r.data) as { key: string; name?: string; size: number; update?: boolean; scope?: BackupScope }) }));
}

type Admin = { login: string; email: string };

// "few admin accounts only, otherwise mention"
export function adminIssues(site: Site, status: Report | undefined, maxAdmins: number) {
  if (!status?.ok) return [];
  const admins: Admin[] = JSON.parse(status.data).admins ?? [];
  const allowed = site.allowed_admins.split(",").map((s) => s.trim()).filter(Boolean);
  const issues: string[] = [];
  if (admins.length > maxAdmins) issues.push(`${admins.length} admins (max ${maxAdmins})`);
  for (const a of admins) if (allowed.length && !allowed.includes(a.login)) issues.push(`Unexpected admin: ${a.login} <${a.email}>`);
  return issues;
}

// "elementor-pro/elementor-pro.php" → "Elementor Pro", "core" → "WordPress core"
// Why each update didn't stick on its most recent attempt (reports newest first). A later success clears it.
export function updateFailures(reports: Report[]) {
  const seen = new Set<string>();
  const out = new Map<string, { reason: string; at: number }>();
  for (const r of reports) {
    if (r.type !== "update" || !r.ok) continue; // a crashed run has no per-update detail
    const d = JSON.parse(r.data);
    for (const id of d.failed ?? []) if (!seen.has(id)) { seen.add(id); out.set(id, { reason: d.errors?.[id] || "No reason recorded", at: r.created_at }); }
    for (const id of d.updated ?? []) if (!seen.has(id)) { seen.add(id); if (d.rolled_back) out.set(id, { reason: `Installed, then undone because ${d.reason}`, at: r.created_at }); }
  }
  return out;
}

export const updateName = (id: string) =>
  id === "core" ? "WordPress core" : id.split("/")[0].split(/[-_]/).map((w) => w && w[0].toUpperCase() + w.slice(1)).join(" ");

// Client report numbers for one site over a period (reports newest first, as siteReportsSince returns them)
export function summarize(reports: Report[]) {
  const ok = (t: string) => reports.filter((r) => r.type === t && r.ok).map((r) => ({ ...r, d: JSON.parse(r.data) }));
  const backups = ok("backup"), updates = ok("update"), scans = ok("scan");
  const installed = new Map<string, number>(); // id → when, latest first
  const failed = new Map<string, string>();
  for (const u of updates) {
    if (u.d.rolled_back) continue;
    for (const id of u.d.updated ?? []) if (!installed.has(id)) installed.set(id, u.created_at);
    for (const id of u.d.failed ?? []) if (!installed.has(id) && !failed.has(id)) failed.set(id, u.d.errors?.[id] ?? "");
  }
  return {
    backups: backups.map((b) => ({ at: b.created_at, size: b.d.size as number, scope: (b.d.scope ?? "both") as BackupScope })),
    backupBytes: backups.reduce((n, b) => n + (b.d.size ?? 0), 0),
    installed: [...installed].map(([id, at]) => ({ id, name: updateName(id), at })),
    failedUpdates: [...failed].filter(([id]) => !installed.has(id)).map(([id, reason]) => ({ id, name: updateName(id), reason })),
    rollbacks: updates.filter((u) => u.d.rolled_back).map((u) => ({ at: u.created_at, reason: u.d.reason as string })),
    scans: scans.length,
    latestFindings: (scans[0]?.d.findings ?? []) as { file: string; reason: string }[],
    lastScanAt: scans[0]?.created_at,
    failedJobs: reports.filter((r) => !r.ok).length,
    changes: [...ok("user"), ...ok("settings")].map((r) => ({
      at: r.created_at,
      text: r.type === "user" ? (r.d.action === "add" ? `Added user ${r.d.login} (${r.d.role})` : `Removed user ${r.d.login}`)
        : Object.entries(r.d).map(([k, v]) => `${SETTINGS[k as Setting] ?? k} turned ${v ? "on" : "off"}`).join(", "),
    })),
  };
}

// What needs a human on one site, most serious first; tone = worst of them. Shared by the dashboard and site page.
export function siteAttention(a: {
  info?: { https?: boolean; indexing?: boolean; maintenance?: boolean; debug?: boolean };
  findings: number; pending: number; adminWarnings: number; lastBackupAt?: number; failedJobs?: number; failedUpdates?: number; now: number;
}) {
  const bad = [
    a.findings && `${a.findings} suspicious file${a.findings > 1 ? "s" : ""}`,
    a.info && a.info.https === false && "HTTPS is off",
    a.failedJobs && `${a.failedJobs} failed job${a.failedJobs > 1 ? "s" : ""}`,
  ];
  const warn = [
    (a.lastBackupAt ? a.now - a.lastBackupAt > 2 * 86_400_000 && "No backup in 2 days" : "Never backed up"),
    a.adminWarnings && `${a.adminWarnings} admin account warning${a.adminWarnings > 1 ? "s" : ""}`,
    a.failedUpdates && `${a.failedUpdates} update${a.failedUpdates > 1 ? "s" : ""} failed`,
    a.pending && `${a.pending} update${a.pending > 1 ? "s" : ""} pending`,
    a.info?.maintenance && "Maintenance mode is on",
    a.info?.debug && "Debug mode is on",
    a.info && a.info.indexing === false && "Hidden from search engines",
  ];
  const b = bad.filter(Boolean) as string[], w = warn.filter(Boolean) as string[];
  return { items: [...b, ...w], tone: (b.length ? "bad" : w.length ? "warn" : "ok") as "bad" | "warn" | "ok" };
}

// newest successful backup per site
export async function lastBackups(env: Env) {
  const { results } = await env.DB.prepare("SELECT site_id, MAX(created_at) at FROM reports WHERE type = 'backup' AND ok = 1 GROUP BY site_id").all<{ site_id: string; at: number }>();
  return new Map(results.map((r) => [r.site_id, r.at]));
}
