import { AwsClient } from "aws4fetch";

// relative imports only: worker.ts (cron) bundles this file outside Next
export type Env = CloudflareEnv & { OVH_S3_ACCESS_KEY: string; OVH_S3_SECRET_KEY: string; ADMIN_PASSWORD: string };
export type Site = { id: string; url: string; secret: string; allowed_admins: string; created_at: number };
export type Report = { id: number; site_id: string; type: string; ok: number; data: string; created_at: number };

export const REPORT_TYPES = ["status", "scan", "backup", "update", "restore"];
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

/* Dashboard login: one shared ADMIN_PASSWORD secret. Session = "<expiry>.<hmac>", keyed by the
   password, so changing the password logs everyone out. Checked in worker.ts before any page or action. */
export const SESSION_COOKIE = "wpch_session";
export const SESSION_TTL = 7 * 86_400;

export async function passwordOk(env: Env, pw: string) {
  // compare HMACs so timing doesn't leak the password length/prefix
  return !!env.ADMIN_PASSWORD && safeEqual(await sign(env.ADMIN_PASSWORD, "pw", pw), await sign(env.ADMIN_PASSWORD, "pw", env.ADMIN_PASSWORD));
}

export async function createSession(env: Env, now = Date.now()) {
  const exp = String(Math.floor(now / 1000) + SESSION_TTL);
  return `${exp}.${await sign(env.ADMIN_PASSWORD, exp, "session")}`;
}

export async function sessionValid(env: Env, token?: string | null) {
  const [exp, mac] = (token ?? "").split(".");
  if (!env.ADMIN_PASSWORD || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(await sign(env.ADMIN_PASSWORD, exp, "session"), mac ?? "");
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
  } catch (e) {
    await insertReport(env, site.id, cmd, false, { error: `Site unreachable: ${e}` });
  }
}

// Presigned OVH S3 URL so the plugin never holds bucket credentials
async function presign(env: Env, key: string, method: "PUT" | "GET") {
  const s3 = new AwsClient({
    accessKeyId: env.OVH_S3_ACCESS_KEY,
    secretAccessKey: env.OVH_S3_SECRET_KEY,
    service: "s3",
    region: env.OVH_S3_REGION,
  });
  const url = new URL(`${env.OVH_S3_ENDPOINT}/${env.OVH_S3_BUCKET}/${key}`);
  url.searchParams.set("X-Amz-Expires", "43200"); // 12h: wp-cron may start the job late
  return (await s3.sign(url, { method, aws: { signQuery: true } })).url;
}

// update=true: plugin backs up, uploads, runs all updates, health-checks, auto-rolls back on failure
// only: update ids to install (plugin file, theme slug, "core"); omitted = all pending
export async function backup(env: Env, site: Site, update: boolean, only?: string[]) {
  const key = `${site.id}/${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  await sendCommand(env, site, "backup", { key, put_url: await presign(env, key, "PUT"), update, ...(only && { only }) });
}

export async function restore(env: Env, site: Site, key: string) {
  if (!key.startsWith(`${site.id}/`)) throw new Error("Backup does not belong to this site");
  await sendCommand(env, site, "restore", { key, get_url: await presign(env, key, "GET") });
}

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
  return results.map((r) => ({ ...r, ...(JSON.parse(r.data) as { key: string; size: number; update?: boolean }) }));
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
