// node --test lib/hub.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { adminIssues, createSession, passwordOk, sessionValid, sign, verify, type Report, type Site } from "./hub.ts";

test("signature matches the plugin's PHP wpch_sign()", async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"cmd":"status","args":{}}';
  const php = execFileSync("php", ["-r", 'echo hash_hmac("sha256", $argv[1] . "." . $argv[2], $argv[3]);', ts, body, "s3cret"]).toString();
  assert.equal(await sign("s3cret", ts, body), php);
  assert.ok(await verify("s3cret", ts, body, php));
  assert.ok(!(await verify("s3cret", ts, body + " ", php)), "tampered body");
  assert.ok(!(await verify("s3cret", String(Number(ts) - 600), body, await sign("s3cret", String(Number(ts) - 600), body))), "stale");
});

test("admin issues", () => {
  const site = { allowed_admins: "alice, bob" } as Site;
  const status = { ok: 1, data: JSON.stringify({ admins: [{ login: "alice", email: "a@x" }, { login: "eve", email: "e@x" }] }) } as Report;
  assert.deepEqual(adminIssues(site, status, 3), ["Unexpected admin: eve <e@x>"]);
  assert.deepEqual(adminIssues({ allowed_admins: "" } as Site, status, 1), ["2 admins (max 1)"]);
});

test("login session", async () => {
  const env = { ADMIN_PASSWORD: "hunter2" } as Parameters<typeof createSession>[0];
  assert.ok(await passwordOk(env, "hunter2"));
  assert.ok(!(await passwordOk(env, "hunter")));
  assert.ok(!(await passwordOk({ ADMIN_PASSWORD: "" } as typeof env, "")), "no password set = no login");
  const token = await createSession(env);
  assert.ok(await sessionValid(env, token));
  assert.ok(!(await sessionValid({ ADMIN_PASSWORD: "changed" } as typeof env, token)), "password change logs out");
  assert.ok(!(await sessionValid(env, await createSession(env, Date.now() - 8 * 86_400_000))), "expired");
  assert.ok(!(await sessionValid(env, token.replace(/.$/, "x"))), "tampered");
  assert.ok(!(await sessionValid(env, null)));
});
