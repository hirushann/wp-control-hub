// relative imports only: worker.ts (cron) bundles this file outside Next
export type Env = CloudflareEnv & { ADMIN_PASSWORD: string; GDRIVE_CLIENT_ID: string; GDRIVE_CLIENT_SECRET: string; GDRIVE_REFRESH_TOKEN: string };
export type Site = { id: string; url: string; secret: string; allowed_admins: string; created_at: number };
export type Report = { id: number; site_id: string; type: string; ok: number; data: string; created_at: number };

export const REPORT_TYPES = ["status", "scan", "backup", "update", "restore", "connector", "user", "settings"];
// connector plugin version this hub serves at /wp-control-hub.zip; must match the plugin header (checked in hub.test.ts)
export const PLUGIN_VERSION = "0.5.0";
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
export type HubUser = { id: string; username: string; role: Role };
const ROOT: HubUser = { id: "root", username: ROOT_USERNAME, role: "super" };

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
  const row = await env.DB.prepare("SELECT id, username, role, pw FROM users WHERE username = ?").bind(username).first<HubUser & { pw: string }>();
  if (!row || !(await checkPassword(pw, row.pw))) return null;
  return { id: row.id, username: row.username, role: row.role };
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
  return env.DB.prepare("SELECT id, username, role FROM users WHERE id = ?").bind(uid).first<HubUser>();
}

export async function hubUsers(env: Env) {
  const { results } = await env.DB.prepare("SELECT id, username, role, created_at FROM users ORDER BY username").all<HubUser & { created_at: number }>();
  return results;
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
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`);
    return true;
  } catch (e) {
    await insertReport(env, site.id, cmd, false, { error: `Site unreachable: ${e}` });
    return false;
  }
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
  // long job: log that it started so the dashboard shows something until the site reports back
  if (await sendCommand(env, site, "backup", { name, put_url, update, scope, ...(only && { only }) }))
    await insertReport(env, site.id, "queued", true, { job: update ? "Backup & update" : scope === "db" ? "Database backup" : scope === "files" ? "Files backup" : "Backup" });
}

// site downloads the hub's own /wp-control-hub.zip and installs it over itself
export async function updateConnector(env: Env, site: Site) {
  if (await sendCommand(env, site, "connector")) await insertReport(env, site.id, "queued", true, { job: "Connector update" });
}

// add: WordPress emails the new user a set-password link, so no password passes through the hub
export async function siteSetting(env: Env, site: Site, setting: "debug" | "maintenance", on: boolean) {
  if (await sendCommand(env, site, "settings", { [setting]: on }))
    await insertReport(env, site.id, "queued", true, { job: `Turning ${setting === "debug" ? "debug mode" : "maintenance mode"} ${on ? "on" : "off"}` });
}

export async function userCommand(env: Env, site: Site, args: { action: "add"; login: string; email: string; role: string } | { action: "delete"; login: string }) {
  if (await sendCommand(env, site, "user", args))
    await insertReport(env, site.id, "queued", true, { job: `${args.action === "add" ? "Adding" : "Deleting"} user ${args.login}` });
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
  await sendCommand(env, site, "restore", { key });
}

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");

export async function runDaily(env: Env, now = Date.now()) {
  const { results: sites } = await env.DB.prepare("SELECT * FROM sites").all<Site>();
  const scanDay = Math.floor(now / 86_400_000) % 2 === 0; // every 2nd day
  // shortcut: one fetch per command per site; Workers paid plan allows 1000 subrequests (~300 sites), shard the loop beyond that
  await Promise.allSettled(
    sites.map(async (site) => {
      await sendCommand(env, site, "status");
      await backup(env, site, true);
      if (scanDay) await sendCommand(env, site, "scan");
    }),
  );
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
