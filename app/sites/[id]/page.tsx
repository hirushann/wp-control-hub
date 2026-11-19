import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { manageUser, restoreBackup, runCommand, saveAllowedAdmins, toggleSetting } from "@/app/actions";
import { BackupDialog, SubmitButton } from "@/app/buttons";
import { ago, Badge, Card, host, inputClass, Shell, Skeleton } from "@/app/ui";
import { adminIssues, connectionKey, type Env, getSite, PLUGIN_VERSION, type Setting, SETTINGS, siteBackups, siteReports } from "@/lib/hub";

export default function SitePage({ params }: PageProps<"/sites/[id]">) {
  return (
    <Shell>
      <Suspense fallback={<Skeleton rows={5} />}>
        <SiteDetail params={params} />
      </Suspense>
    </Shell>
  );
}

const muted = "text-sm text-zinc-500";
const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
const scopeLabel: Record<string, string> = { db: "database only", files: "files only" };
const fmtDate = (t: number) => new Date(t).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

async function SiteDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const env = getCloudflareContext().env as Env;
  const site = await getSite(env, id);
  if (!site) notFound();
  const [reports, backups, h] = await Promise.all([siteReports(env, id), siteBackups(env, id), headers()]);
  // last successful run; failures still show in Activity
  const last = (t: string) => reports.find((r) => r.type === t && r.ok);
  const status = last("status"), scan = last("scan");
  const statusData = status ? JSON.parse(status.data) : null;
  const info = statusData?.info;
  const findings: { file: string; reason: string }[] = scan ? JSON.parse(scan.data).findings : [];
  const issues = adminIssues(site, status, Number(env.MAX_ADMINS));
  const updates: { id?: string; type: string; name: string; from: string; to: string }[] = statusData?.updates ?? [];
  // a backup was sent and the site hasn't reported back yet (backups of big sites take several minutes)
  // eslint-disable-next-line react-hooks/purity -- server component, rendered per request
  const running = reports[0]?.type === "queued" && Date.now() - reports[0].created_at < 30 * 60_000;

  return (
    <>
      {running && <meta httpEquiv="refresh" content="15" />}
      <nav className={`mb-4 ${muted}`} aria-label="Breadcrumb">
        <Link href="/" className="hover:text-zinc-900 dark:hover:text-zinc-100">Sites</Link> <span aria-hidden>/</span> {host(site.url)}
      </nav>

      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{host(site.url)}</h1>
          <p className={`mt-1 ${muted}`}>
            <a href={site.url} target="_blank" rel="noreferrer" className="hover:underline">Visit site ↗</a>
            {statusData?.login_url && <> · <a href={statusData.login_url} target="_blank" rel="noreferrer" className="hover:underline">Admin login ↗</a></>}
            {statusData && <> · WordPress {statusData.wp} · PHP {statusData.php}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form action={runCommand} className="contents">
            <input type="hidden" name="id" value={site.id} />
            <SubmitButton name="cmd" value="status">Check for updates</SubmitButton>
            <SubmitButton name="cmd" value="scan">Scan for malware</SubmitButton>
          </form>
          <span aria-hidden className="mx-1 hidden h-6 w-px bg-zinc-200 sm:block dark:bg-zinc-800" />
          <BackupDialog siteId={site.id} action={runCommand} />
          <form action={runCommand}>
            <input type="hidden" name="id" value={site.id} />
            <SubmitButton name="cmd" value="update" variant="primary" confirm="Back up, then install all updates? It rolls back automatically if the site breaks.">
              Back up &amp; update all
            </SubmitButton>
          </form>
        </div>
      </div>

      {running && (
        <p role="status" className="mb-6 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:bg-blue-500/10 dark:text-blue-300">
          {JSON.parse(reports[0].data).job} running on the site. This can take several minutes; the page refreshes until it finishes.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Malware scan" action={scan && <span className="text-xs text-zinc-500">{ago(scan.created_at)}</span>}>
            {!scan ? <p className={muted}>Not scanned yet.</p> : findings.length ? (
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {findings.map((f) => (
                  <li key={f.file + f.reason} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                    <code className="break-all font-mono text-xs">{f.file}</code>
                    <Badge tone="bad">{f.reason}</Badge>
                  </li>
                ))}
              </ul>
            ) : <Badge tone="ok">No issues found</Badge>}
          </Card>

          <Card title="Backups on Google Drive" action={<span className="text-xs text-zinc-500">{backups.length} kept</span>}>
            <p className={`mb-3 ${muted}`}>Restoring replaces the site’s files and database. To undo a bad update, restore the backup marked “pre-update”.</p>
            {backups.length ? (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {backups.map((b) => (
                  <li key={b.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium">{fmtDate(b.created_at)}</span>
                      <span className="tabular-nums text-zinc-500">{(b.size / 1e6).toFixed(1)} MB</span>
                      {b.update && <Badge tone="muted">pre-update</Badge>}
                      {b.scope && scopeLabel[b.scope] && <Badge tone="muted">{scopeLabel[b.scope]}</Badge>}
                    </div>
                    <form action={restoreBackup}>
                      <input type="hidden" name="id" value={site.id} />
                      <input type="hidden" name="key" value={b.key} />
                      <SubmitButton variant="danger" confirm={`Restore ${b.scope === "db" ? "the database of " : b.scope === "files" ? "the files of " : ""}${host(site.url)} to ${fmtDate(b.created_at)}? This overwrites the live site.`}>Restore</SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
            ) : <p className={muted}>No backups yet.</p>}
          </Card>

          <Card title="Activity">
            {reports.length ? (
              <ol className="space-y-3">
                {reports.map((r) => {
                  const d = JSON.parse(r.data);
                  const rolledBack = r.type === "update" && r.ok && d.rolled_back;
                  const detail = !r.ok ? d.error
                    : r.type === "queued" ? `${d.job} started`
                    : r.type === "update" ? (rolledBack ? `Rolled back: ${d.reason}` : `${d.updated.length} updated${d.failed?.length ? `, ${d.failed.length} failed` : ""}`)
                      + (d.failed?.length ? ` · ${d.failed.map((f: string) => `${f.split("/")[0]}: ${d.errors?.[f] ?? "no reason recorded (connector older than 0.5.1)"}`).join(" · ")}` : "")
                    : r.type === "scan" ? `${d.findings.length} findings`
                    : r.type === "backup" ? `${(d.size / 1e6).toFixed(1)} MB uploaded${scopeLabel[d.scope] ? ` (${scopeLabel[d.scope]})` : ""}`
                    : r.type === "connector" ? `Connector updated to ${d.version}`
                    : r.type === "settings" ? Object.entries(d).map(([k, v]) => `${SETTINGS[k as Setting] ?? k} ${v ? "on" : "off"}`).join(", ")
                    : r.type === "user" ? (d.action === "add" ? `Added ${d.login} as ${d.role}` : `Deleted ${d.login}`) : "";
                  return (
                    <li key={r.id} className="flex gap-3 text-sm">
                      <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${!r.ok ? "bg-red-500" : rolledBack ? "bg-amber-500" : r.type === "queued" ? "bg-blue-500" : "bg-emerald-500"}`} />
                      <div className="min-w-0">
                        <p><span className="font-medium capitalize">{r.type === "queued" ? "Started" : r.type}</span> <span className="text-zinc-500">· {fmtDate(r.created_at)}</span>{!r.ok && <span className="sr-only"> failed</span>}</p>
                        {detail && <p className={`break-words ${!r.ok ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>{String(detail).slice(0, 600)}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : <p className={muted}>Nothing yet. Connect the plugin, then run “Check for updates”.</p>}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Site overview">
            {!info ? <p className={muted}>{statusData ? "Install connector 0.3.0 and run “Check for updates” to see details." : "Unknown until the first check."}</p> : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                {([
                  ["Site name", info.name],
                  ["WordPress", statusData.wp],
                  ["PHP", `${statusData.php} · ${info.memory_limit} memory`],
                  ["Theme", info.theme],
                  ["Plugins", `${info.plugins_active} active of ${info.plugins_total}`],
                  ["Users", info.users],
                  ["Database", bytes(info.db_size)],
                  ["Disk free", info.disk_free == null ? "unknown" : bytes(info.disk_free)],
                  ["Last backup", backups[0] ? ago(backups[0].created_at) : <Badge tone="warn">never</Badge>],
                  ["HTTPS", info.https ? "Yes" : <Badge tone="bad">No</Badge>],
                  ["Search engines", info.indexing ? "Allowed" : <Badge tone="warn">Discouraged</Badge>],
                  ["Maintenance", info.maintenance === undefined ? "–" : <Toggle siteId={site.id} setting="maintenance" on={info.maintenance}
                    confirm={info.maintenance ? undefined : "Put the site in maintenance mode? Visitors see a “back soon” page; logged-in admins still see the site."} />],
                  ["Debug mode", info.maintenance === undefined ? (info.debug ? <Badge tone="warn">On</Badge> : "Off") : <Toggle siteId={site.id} setting="debug" on={info.debug} />],
                  ["Debug log", info.debug_log === undefined ? "–" : <Toggle siteId={site.id} setting="debug_log" on={info.debug_log} />],
                  ["Server", info.server || "unknown"],
                ] as [string, React.ReactNode][]).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-zinc-500">{k}</dt>
                    <dd className="min-w-0 truncate text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          <Card title="Users" action={status && <span className="text-xs text-zinc-500">{ago(status.created_at)}</span>}>
            {issues.length > 0 && (
              <ul className="mb-3 space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-300">
                {issues.map((i) => <li key={i}>⚠ {i}</li>)}
              </ul>
            )}
            {statusData ? (
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {/* users list comes from connector 0.4.0+; older ones only report admins */}
                {(statusData.users ?? statusData.admins.map((a: { login: string; email: string }) => ({ ...a, role: "administrator" }))).map((u: { login: string; email: string; role: string }) => (
                  <li key={u.login} className="flex items-center justify-between gap-2 py-2 first:pt-0">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{u.login} <span className="text-xs font-normal text-zinc-500">{u.role}</span></p>
                      <p className="truncate text-xs text-zinc-500">{u.email}</p>
                    </div>
                    {statusData.users && (
                      <form action={manageUser}>
                        <input type="hidden" name="id" value={site.id} />
                        <input type="hidden" name="action" value="delete" />
                        <input type="hidden" name="login" value={u.login} />
                        <SubmitButton variant="danger" confirm={`Delete WordPress user ${u.login} from ${host(site.url)}? Their posts move to another administrator.`}>Delete</SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className={muted}>No status yet.</p>}
            {statusData?.users ? (
              <form action={manageUser} className="mt-4 space-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                <input type="hidden" name="id" value={site.id} />
                <input type="hidden" name="action" value="add" />
                <p className="text-xs font-medium text-zinc-500">Add user (they get an email to set their password)</p>
                <label htmlFor="new_login" className="sr-only">Username</label>
                <input id="new_login" name="login" required placeholder="Username" autoComplete="off" className={inputClass} />
                <label htmlFor="new_email" className="sr-only">Email</label>
                <input id="new_email" name="email" type="email" required placeholder="Email" autoComplete="off" className={inputClass} />
                <div className="flex gap-2">
                  <label htmlFor="new_role" className="sr-only">Role</label>
                  <select id="new_role" name="role" defaultValue="editor" className={inputClass}>
                    {["administrator", "editor", "author", "contributor", "subscriber"].map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
                  </select>
                  <SubmitButton variant="primary">Add</SubmitButton>
                </div>
                <p className={muted}>Subscribers and customers aren’t listed.</p>
              </form>
            ) : statusData && <p className={`mt-3 ${muted}`}>Update the connector to 0.4.0 to add or delete users.</p>}
            <form action={saveAllowedAdmins} className="mt-4 space-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
              <input type="hidden" name="id" value={site.id} />
              <label htmlFor="allowed_admins" className="block text-xs font-medium text-zinc-500">Allowed admin usernames (comma separated)</label>
              <div className="flex gap-2">
                <input id="allowed_admins" name="allowed_admins" defaultValue={site.allowed_admins} placeholder="admin, agency" className={inputClass} />
                <SubmitButton>Save</SubmitButton>
              </div>
            </form>
          </Card>

          <Card title="Pending updates">
            {!statusData ? <p className={muted}>Unknown until the first check.</p> : updates.length ? (
              <form action={runCommand}>
                <input type="hidden" name="id" value={site.id} />
                <input type="hidden" name="pick" value="1" />
                <ul className="space-y-2 text-sm">
                  {updates.map((u) => (
                    <li key={u.type + u.name}>
                      <label className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          {/* id comes from plugin 0.1.2+; older plugins can only update everything */}
                          {u.id && <input type="checkbox" name="only" value={u.id} defaultChecked className="size-4 shrink-0 accent-zinc-900 dark:accent-white" />}
                          <span className="truncate"><span className="font-medium">{u.name}</span> <span className="text-xs text-zinc-500">{u.type}</span></span>
                        </span>
                        <span className="shrink-0 font-mono text-xs text-zinc-500">{u.from} → {u.to}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {updates.every((u) => u.id) ? (
                  <div className="mt-4 grid border-t border-zinc-100 pt-4 dark:border-zinc-800">
                    <SubmitButton name="cmd" value="update" variant="primary" confirm="Back up, then install the ticked updates? It rolls back automatically if the site breaks.">
                      Back up &amp; update selected
                    </SubmitButton>
                  </div>
                ) : <p className={`mt-3 ${muted}`}>Install plugin 0.1.2 on this site to pick individual updates.</p>}
              </form>
            ) : <Badge tone="ok">Everything up to date</Badge>}
          </Card>

          <Card title="Plugin connection">
            <div className="mb-3 flex items-center justify-between gap-2 text-sm">
              <span>Connector {statusData?.connector ?? (statusData ? "older than 0.3.0" : "unknown")}</span>
              {statusData?.connector && statusData.connector !== PLUGIN_VERSION && (
                <form action={runCommand}>
                  <input type="hidden" name="id" value={site.id} />
                  <SubmitButton name="cmd" value="connector" variant="primary">Update to {PLUGIN_VERSION}</SubmitButton>
                </form>
              )}
              {statusData?.connector === PLUGIN_VERSION && <Badge tone="ok">Latest</Badge>}
            </div>
            {statusData && !statusData.connector && (
              <p className={`mb-3 ${muted}`}>
                This version can’t update itself. Install it once by hand: <a href="/wp-control-hub.zip" className="font-medium underline">download {PLUGIN_VERSION}</a>, then Plugins → Add New → Upload → Replace current.
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-sm font-medium">Show connection key</summary>
              <p className={`mt-2 ${muted}`}>Paste into WordPress → Settings → Control Hub. Treat it like a password.</p>
              <textarea readOnly aria-label="Connection key" value={connectionKey(`https://${h.get("host")}`, site)}
                className="mt-2 h-24 w-full rounded-lg border border-zinc-300 bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950" />
            </details>
          </Card>
        </div>
      </div>
    </>
  );
}

// on/off switch for a site setting; only rendered for connector 0.5.0+ (which reports info.maintenance)
function Toggle({ siteId, setting, on, confirm }: { siteId: string; setting: Setting; on: boolean; confirm?: string }) {
  return (
    <form action={toggleSetting} className="inline-flex items-center justify-end gap-2">
      <input type="hidden" name="id" value={siteId} />
      <input type="hidden" name="setting" value={setting} />
      <input type="hidden" name="on" value={on ? "0" : "1"} />
      {on ? <Badge tone="warn">On</Badge> : <span>Off</span>}
      <SubmitButton confirm={confirm}>Turn {on ? "off" : "on"}</SubmitButton>
    </form>
  );
}
