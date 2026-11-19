"use server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { backup, type BackupScope, canSee, isRestricted, connectorVersion, authenticate, createSession, type Env, getSite, getSites, hashPassword, latestReports, PLUGIN_VERSION, ROOT_USERNAME, sessionUser, restore, SESSION_COOKIE, SESSION_TTL, sendCommand, type Setting, SETTINGS, siteSetting, updateConnector, userCommand } from "@/lib/hub";

const env = () => getCloudflareContext().env as Env;

// shortcut: no rate limit on login; add a Cloudflare WAF rate-limit rule on POST /login
export async function login(form: FormData) {
  const user = await authenticate(env(), String(form.get("username") ?? "").trim().toLowerCase(), String(form.get("password") ?? ""));
  if (!user) redirect("/login?error=1");
  (await cookies()).set(SESSION_COOKIE, await createSession(env(), user.id), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL,
  });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value; // cookies first: marks the page dynamic before env is read
  return sessionUser(env(), token);
}

// worker.ts already blocks anonymous requests; this is the extra check for hub-user management
async function requireSuper() {
  const me = await currentUser();
  if (me?.role !== "super") throw new Error("Only super admins can manage hub users");
  return me;
}

const teamError = (msg: string) => redirect(`/team?error=${encodeURIComponent(msg)}`);

export async function addHubUser(form: FormData) {
  await requireSuper();
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const role = String(form.get("role"));
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) teamError("Username: 3–32 characters, letters, numbers, dot, dash or underscore.");
  if (username === ROOT_USERNAME) teamError(`“${ROOT_USERNAME}” is reserved for the built-in super admin.`);
  if (password.length < 10) teamError("Password must be at least 10 characters.");
  if (role !== "super" && role !== "manager") teamError("Pick a role.");
  const orgs = role === "manager" ? await orgsFrom(form) : [];
  const id = crypto.randomUUID();
  try {
    await env().DB.batch([
      env().DB.prepare("INSERT INTO users (id, username, role, pw, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, username, role, await hashPassword(password), Date.now()),
      ...orgs.map((o) => env().DB.prepare("INSERT INTO user_orgs (user_id, org_id) VALUES (?, ?)").bind(id, o)),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) teamError(`Username “${username}” is taken.`);
    throw e;
  }
  redirect("/team");
}

export async function setHubUserOrg(form: FormData) {
  await requireSuper();
  const uid = String(form.get("uid"));
  const orgs = await orgsFrom(form);
  if (!(await env().DB.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'manager'").bind(uid).first())) teamError("User not found.");
  await env().DB.batch([
    env().DB.prepare("DELETE FROM user_orgs WHERE user_id = ?").bind(uid),
    ...orgs.map((o) => env().DB.prepare("INSERT INTO user_orgs (user_id, org_id) VALUES (?, ?)").bind(uid, o)),
  ]);
  redirect("/team?saved=org");
}

// ticked organizations, [] = all ("" ticked); nothing ticked is refused so "no access" can't silently become "all"
async function orgsFrom(form: FormData) {
  const ids = form.getAll("org_id").map(String);
  if (!(await env().DB.prepare("SELECT 1 FROM orgs LIMIT 1").first())) return [];
  if (ids.includes("")) return [];
  if (!ids.length) teamError("Tick at least one organization, or All organizations.");
  const { results } = await env().DB.prepare(`SELECT id FROM orgs WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string }>();
  if (results.length !== new Set(ids).size) throw new Error("Organization not found");
  return results.map((r) => r.id);
}

export async function deleteHubUser(form: FormData) {
  const me = await requireSuper();
  const id = String(form.get("uid"));
  if (id === me.id) teamError("You can’t delete your own account.");
  await env().DB.batch([
    env().DB.prepare("DELETE FROM user_orgs WHERE user_id = ?").bind(id),
    env().DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  redirect("/team");
}

export async function setHubPassword(form: FormData) {
  await requireSuper();
  const password = String(form.get("password") ?? "");
  if (password.length < 10) teamError("Password must be at least 10 characters.");
  await env().DB.prepare("UPDATE users SET pw = ? WHERE id = ?").bind(await hashPassword(password), String(form.get("uid"))).run();
  redirect("/team?saved=1");
}

export async function changeOwnPassword(form: FormData) {
  const me = await currentUser();
  const fail = (msg: string) => redirect(`/account?error=${encodeURIComponent(msg)}`);
  if (!me || me.username === ROOT_USERNAME) fail("The built-in admin password is the ADMIN_PASSWORD secret; change it in Cloudflare.");
  const password = String(form.get("password") ?? "");
  if (!(await authenticate(env(), me!.username, String(form.get("current") ?? "")))) fail("Current password is wrong.");
  if (password.length < 10) fail("New password must be at least 10 characters.");
  if (password !== String(form.get("confirm") ?? "")) fail("The two new passwords don’t match.");
  await env().DB.prepare("UPDATE users SET pw = ? WHERE id = ?").bind(await hashPassword(password), me!.id).run();
  redirect("/account?saved=1");
}

// every site action goes through here, so a manager can't act on another organization's site by posting its id
async function siteFrom(form: FormData) {
  const [site, me] = await Promise.all([getSite(env(), String(form.get("id"))), currentUser()]);
  if (!site || !canSee(me, site)) throw new Error("Site not found");
  return site;
}

// "" = no organization; anything else must be an existing org id
async function orgFrom(form: FormData) {
  const id = String(form.get("org_id") ?? "");
  if (!id) return null;
  if (!(await env().DB.prepare("SELECT 1 FROM orgs WHERE id = ?").bind(id).first())) throw new Error("Organization not found");
  return id;
}

export async function addSite(form: FormData) {
  const me = await currentUser();
  const url = new URL(String(form.get("url"))); // throws on garbage
  if (url.protocol !== "https:") throw new Error("Site URL must be https");
  let org = await orgFrom(form);
  // a restricted manager's sites always land in one of their own organizations
  if (isRestricted(me) && !me!.orgs.includes(org!)) {
    if (me!.orgs.length > 1) throw new Error("Pick one of your organizations");
    org = me!.orgs[0];
  }
  const id = crypto.randomUUID();
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env().DB.prepare("INSERT INTO sites (id, url, secret, created_at, org_id) VALUES (?, ?, ?, ?, ?)")
    .bind(id, url.origin + url.pathname.replace(/\/+$/, ""), secret, Date.now(), org)
    .run();
  redirect(`/sites/${id}`);
}

export async function setSiteOrg(form: FormData) {
  const me = await currentUser();
  if (isRestricted(me)) throw new Error("Only super admins can move sites between organizations");
  const site = await siteFrom(form);
  await env().DB.prepare("UPDATE sites SET org_id = ? WHERE id = ?").bind(await orgFrom(form), site.id).run();
  refresh();
}

const orgError = (msg: string) => redirect(`/organizations?error=${encodeURIComponent(msg)}`);
const orgName = (form: FormData) => {
  const name = String(form.get("name") ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) orgError("Name must be 1–80 characters.");
  return name;
};

// organizations are structure, so only super admins change them; anyone can file a site under one
export async function addOrg(form: FormData) {
  await requireSuper();
  const name = orgName(form);
  try {
    await env().DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").bind(crypto.randomUUID(), name, Date.now()).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) orgError(`“${name}” already exists.`);
    throw e;
  }
  redirect("/organizations");
}

export async function renameOrg(form: FormData) {
  await requireSuper();
  const name = orgName(form);
  try {
    await env().DB.prepare("UPDATE orgs SET name = ? WHERE id = ?").bind(name, String(form.get("org_id"))).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) orgError(`“${name}” already exists.`);
    throw e;
  }
  redirect("/organizations");
}

// sites stay; they just lose their organization
export async function deleteOrg(form: FormData) {
  await requireSuper();
  const id = String(form.get("org_id"));
  // for a manager whose only organization this is, deleting would turn their scope into "all"; make the super admin decide first
  const managers = await env().DB.prepare(
    "SELECT COUNT(*) n FROM user_orgs u WHERE org_id = ? AND NOT EXISTS (SELECT 1 FROM user_orgs x WHERE x.user_id = u.user_id AND x.org_id != u.org_id)",
  ).bind(id).first<number>("n");
  if (managers) orgError(`${managers} manager${managers > 1 ? "s are" : " is"} assigned only to this organization. Reassign or remove them on the Team page first.`);
  await env().DB.batch([
    env().DB.prepare("UPDATE sites SET org_id = NULL WHERE org_id = ?").bind(id),
    env().DB.prepare("DELETE FROM user_orgs WHERE org_id = ?").bind(id),
    env().DB.prepare("DELETE FROM orgs WHERE id = ?").bind(id),
  ]);
  redirect("/organizations");
}

export async function runCommand(form: FormData) {
  const site = await siteFrom(form);
  const cmd = String(form.get("cmd"));
  // "pick" = submitted from the Pending updates checklist: install only the ticked items
  const only = form.has("pick") ? form.getAll("only").map(String) : undefined;
  if (only && !only.length) return;
  const scope = String(form.get("scope") ?? "both");
  if (cmd === "backup" || cmd === "update") await backup(env(), site, cmd === "update", only, (["db", "files"].includes(scope) ? scope : "both") as BackupScope);
  else if (cmd === "connector") await updateConnector(env(), site);
  else if (cmd === "status" || cmd === "scan") await sendCommand(env(), site, cmd);
  refresh();
}

export async function restoreBackup(form: FormData) {
  await restore(env(), await siteFrom(form), String(form.get("key")));
  refresh();
}

export async function saveAllowedAdmins(form: FormData) {
  const site = await siteFrom(form);
  await env().DB.prepare("UPDATE sites SET allowed_admins = ? WHERE id = ?")
    .bind(String(form.get("allowed_admins") ?? "").trim(), site.id)
    .run();
  refresh();
}

export async function toggleSetting(form: FormData) {
  const site = await siteFrom(form);
  const setting = String(form.get("setting"));
  if (!Object.hasOwn(SETTINGS, setting)) throw new Error("Unknown setting");
  await siteSetting(env(), site, setting as Setting, form.get("on") === "1");
  refresh();
}

export async function manageUser(form: FormData) {
  const site = await siteFrom(form);
  const login = String(form.get("login") ?? "").trim();
  if (!login) return;
  if (form.get("action") === "delete") await userCommand(env(), site, { action: "delete", login });
  else await userCommand(env(), site, { action: "add", login, email: String(form.get("email") ?? "").trim(), role: String(form.get("role") ?? "") });
  refresh();
}

// sites on 0.3.0+ that report an older connector; older plugins can't self-update
export async function updateAllConnectors() {
  const [sites, latest, me] = await Promise.all([getSites(env()), latestReports(env()), currentUser()]);
  await Promise.allSettled(sites.filter((s) => canSee(me, s)).filter((s) => {
    const v = connectorVersion(latest.get(`${s.id}:status`));
    return v && v !== PLUGIN_VERSION;
  }).map((s) => updateConnector(env(), s)));
  refresh();
}
