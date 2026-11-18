"use server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { backup, createSession, type Env, getSite, passwordOk, restore, SESSION_COOKIE, SESSION_TTL, sendCommand } from "@/lib/hub";

const env = () => getCloudflareContext().env as Env;

// shortcut: no rate limit on login; add a Cloudflare WAF rate-limit rule on POST /login
export async function login(form: FormData) {
  if (!(await passwordOk(env(), String(form.get("password") ?? "")))) redirect("/login?error=1");
  (await cookies()).set(SESSION_COOKIE, await createSession(env()), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL,
  });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

async function siteFrom(form: FormData) {
  const site = await getSite(env(), String(form.get("id")));
  if (!site) throw new Error("Site not found");
  return site;
}

export async function addSite(form: FormData) {
  const url = new URL(String(form.get("url"))); // throws on garbage
  if (url.protocol !== "https:") throw new Error("Site URL must be https");
  const id = crypto.randomUUID();
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env().DB.prepare("INSERT INTO sites (id, url, secret, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, url.origin + url.pathname.replace(/\/+$/, ""), secret, Date.now())
    .run();
  redirect(`/sites/${id}`);
}

export async function runCommand(form: FormData) {
  const site = await siteFrom(form);
  const cmd = String(form.get("cmd"));
  // "pick" = submitted from the Pending updates checklist: install only the ticked items
  const only = form.has("pick") ? form.getAll("only").map(String) : undefined;
  if (only && !only.length) return;
  if (cmd === "backup" || cmd === "update") await backup(env(), site, cmd === "update", only);
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
