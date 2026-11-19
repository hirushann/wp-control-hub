// node --test lib/hub.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adminIssues, backup, PLUGIN_VERSION, checkPassword, createSession, type Env, hashPassword, passwordOk, sessionUser, sign, verify, type Report, type Site } from "./hub.ts";

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
  const token = await createSession(env, "root");
  assert.equal((await sessionUser(env, token))?.role, "super");
  assert.equal(await sessionUser({ ADMIN_PASSWORD: "changed" } as typeof env, token), null, "secret change logs out");
  assert.equal(await sessionUser(env, await createSession(env, "root", Date.now() - 8 * 86_400_000)), null, "expired");
  assert.equal(await sessionUser(env, token.replace(/.$/, "x")), null, "tampered");
  assert.equal(await sessionUser(env, token.replace(/^root/, "u2")), null, "can't swap the user id");
  assert.equal(await sessionUser(env, null), null);
  // non-root sessions re-read the user row: deleted user = no session
  const gone = { ...env, DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as unknown as typeof env;
  assert.equal(await sessionUser(gone, await createSession(gone, "u1")), null);
});

test("password hashing", async () => {
  const h = await hashPassword("correct horse");
  assert.match(h, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(await checkPassword("correct horse", h));
  assert.ok(!(await checkPassword("correct hors", h)));
  assert.notEqual(h, await hashPassword("correct horse"), "salted");
});

test("backup without Google Drive access records a failure and sends nothing to the site", async () => {
  const inserted: unknown[][] = [];
  const env = {
    GDRIVE_FOLDER_ID: "f",
    DB: { prepare: () => ({ bind: (...a: unknown[]) => ({ run: async () => inserted.push(a) }) }) },
  } as unknown as Env;
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 });
  }) as typeof fetch;
  try {
    await backup(env, { id: "s1", url: "https://a.com", secret: "x", allowed_admins: "", created_at: 0, org_id: null }, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, ["https://oauth2.googleapis.com/token"]); // never contacted the site
  assert.equal(inserted.length, 1);
  const [siteId, type, ok, data] = inserted[0];
  assert.equal(siteId, "s1");
  assert.equal(type, "backup");
  assert.equal(ok, 0);
  assert.match(String(data), /Token has been expired or revoked\. \(updates skipped\)/);
});

test("PLUGIN_VERSION matches the plugin header (bump both together)", () => {
  const php = readFileSync(new URL("../wp-plugin/wp-control-hub/wp-control-hub.php", import.meta.url), "utf8");
  assert.equal(php.match(/^ \* Version: (.+)$/m)?.[1].trim(), PLUGIN_VERSION);
});

test("plugin edits wp-config.php debug defines safely", () => {
  // runs the plugin's real wpch_config_set() on sample configs, then php -l's each result
  const harness = `
    $src = file_get_contents($argv[1]);
    preg_match('/function wpch_config_set.*?\\n}\\n/s', $src, $m);
    function wp_generate_password($n) { return 'tmp'; }
    eval($m[0]);
    function wpch_config_path() { return $GLOBALS['f']; }
    $samples = [
      "<?php\\ndefine( 'DB_NAME', 'x' );\\ndefine('WP_DEBUG', false);\\n/* That's all, stop editing! */\\nrequire_once ABSPATH . 'wp-settings.php';\\n",
      "<?php\\nif ( ! defined( \\"WP_DEBUG\\" ) ) {\\n\\tdefine( \\"WP_DEBUG\\", true );\\n}\\nrequire_once(ABSPATH . 'wp-settings.php');\\n",
      "<?php\\ndefine('DB_NAME', 'x');\\nrequire_once ABSPATH . 'wp-settings.php';\\n",
    ];
    foreach ($samples as $i => $s) {
      $GLOBALS['f'] = tempnam(sys_get_temp_dir(), 'cfg'); file_put_contents($GLOBALS['f'], $s);
      wpch_config_set(['WP_DEBUG' => true, 'WP_DEBUG_LOG' => true, 'WP_DEBUG_DISPLAY' => false]);
      $out = file_get_contents($GLOBALS['f']);
      exec('php -l ' . escapeshellarg($GLOBALS['f']), $o, $rc);
      echo json_encode(['rc' => $rc, 'debug' => substr_count($out, "define( 'WP_DEBUG', true );"), 'display' => substr_count($out, "define( 'WP_DEBUG_DISPLAY', false );"), 'db' => substr_count($out, 'DB_NAME'), 'beforeSettings' => strpos($out, "WP_DEBUG_LOG") < strpos($out, 'wp-settings.php')]), "\\n";
      unlink($GLOBALS['f']);
    }`;
  const plugin = new URL("../wp-plugin/wp-control-hub/wp-control-hub.php", import.meta.url).pathname;
  const lines = execFileSync("php", ["-r", harness, plugin]).toString().trim().split("\n").map((l) => JSON.parse(l));
  for (const r of lines) assert.deepEqual(r, { rc: 0, debug: 1, display: 1, db: r.db, beforeSettings: true });
  assert.equal(lines.length, 3);
});

test("report summary for a period", async () => {
  const { summarize, updateName } = await import("./hub.ts");
  const r = (id: number, type: string, ok: number, data: unknown) => ({ id, site_id: "s", type, ok, data: JSON.stringify(data), created_at: id * 1000 });
  const s = summarize([
    r(6, "update", 1, { updated: ["acf/acf.php"], failed: [], rolled_back: false }),
    r(5, "update", 1, { updated: ["x/x.php"], failed: [], rolled_back: true, reason: "Home page HTTP 500" }),
    r(4, "update", 1, { updated: ["elementor/elementor.php"], failed: ["acf/acf.php", "elementor-pro/elementor-pro.php"], errors: { "elementor-pro/elementor-pro.php": "No download" } }),
    r(3, "backup", 1, { key: "a", size: 100, scope: "db" }),
    r(2, "backup", 0, { error: "boom" }),
    r(1, "user", 1, { action: "add", login: "jo", role: "editor" }),
  ]);
  assert.deepEqual(s.installed.map((i) => i.name), ["Acf", "Elementor"]); // rolled-back x not counted
  assert.deepEqual(s.failedUpdates, [{ id: "elementor-pro/elementor-pro.php", name: "Elementor Pro", reason: "No download" }]); // acf later succeeded
  assert.deepEqual(s.rollbacks, [{ at: 5000, reason: "Home page HTTP 500" }]);
  assert.equal(s.backups.length, 1);
  assert.equal(s.backupBytes, 100);
  assert.equal(s.failedJobs, 1);
  assert.deepEqual(s.changes.map((c) => c.text), ["Added user jo (editor)"]);
  assert.equal(updateName("core"), "WordPress core");
});

test("site attention items and tone", async () => {
  const { siteAttention } = await import("./hub.ts");
  const now = 10 * 86_400_000;
  assert.deepEqual(siteAttention({ findings: 0, pending: 0, adminWarnings: 0, lastBackupAt: now - 1000, now, info: { https: true, indexing: true } }), { items: [], tone: "ok" });
  const a = siteAttention({ findings: 2, pending: 1, adminWarnings: 0, now, info: { https: true, indexing: false, debug: true } });
  assert.deepEqual(a.items, ["2 suspicious files", "Never backed up", "1 update pending", "Debug mode is on", "Hidden from search engines"]);
  assert.equal(a.tone, "bad");
  assert.equal(siteAttention({ findings: 0, pending: 0, adminWarnings: 0, lastBackupAt: now - 3 * 86_400_000, now }).tone, "warn");
});

test("site access: super and unrestricted managers see all, restricted managers only their organization", async () => {
  const { canSee } = await import("./hub.ts");
  const site = (org_id: string | null) => ({ org_id });
  const mgr = (org_id: string | null) => ({ id: "u", username: "u", role: "manager" as const, org_id });
  assert.ok(canSee({ id: "root", username: "admin", role: "super", org_id: null }, site("a")));
  assert.ok(canSee(mgr(null), site("a")) && canSee(mgr(null), site(null)));
  assert.ok(canSee(mgr("a"), site("a")));
  assert.ok(!canSee(mgr("a"), site("b")), "other organization");
  assert.ok(!canSee(mgr("a"), site(null)), "unassigned site");
  assert.ok(!canSee(null, site(null)), "signed out");
});
