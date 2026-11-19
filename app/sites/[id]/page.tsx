import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { currentUser, manageUser, restoreBackup, runCommand, saveAllowedAdmins, setSiteOrg, toggleSetting } from "@/app/actions";
import { BackupDialog, SubmitButton, Switch } from "@/app/buttons";
import { ago, Badge, bytes, Card, fmtDate, host, Icon, inputClass, Kpi, Shell, Skeleton } from "@/app/ui";
import { adminIssues, canSee, connectionKey, type Env, getOrgs, getSite, PLUGIN_VERSION, type Setting, SETTINGS, siteAttention, siteBackups, siteReports } from "@/lib/hub";

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
const scopeLabel: Record<string, string> = { db: "database only", files: "files only" };
const DAY = 86_400_000;

async function SiteDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const env = getCloudflareContext().env as Env;
  const [site, me] = await Promise.all([getSite(env, id), currentUser()]);
  if (!site || !canSee(me, site)) notFound();
  const [reports, backups, h, orgs] = await Promise.all([siteReports(env, id), siteBackups(env, id), headers(), getOrgs(env)]);
  const canMove = !(me?.role === "manager" && me.org_id);
  const org = orgs.find((o) => o.id === site.org_id);
  // last successful run; failures still show in Activity
  const last = (t: string) => reports.find((r) => r.type === t && r.ok);
  const status = last("status"), scan = last("scan");
  const statusData = status ? JSON.parse(status.data) : null;
  const info = statusData?.info;
  const findings: { file: string; reason: string }[] = scan ? JSON.parse(scan.data).findings : [];
  const issues = adminIssues(site, status, Number(env.MAX_ADMINS));
  const updates: { id?: string; type: string; name: string; from: string; to: string }[] = statusData?.updates ?? [];
  // eslint-disable-next-line react-hooks/purity -- server component, rendered per request
  const now = Date.now();
  // a backup was sent and the site hasn't reported back yet (backups of big sites take several minutes)
  const running = reports[0]?.type === "queued" && now - reports[0].created_at < 30 * 60_000;
  const backupAge = backups[0] ? now - backups[0].created_at : Infinity;

  const { items: attention, tone } = siteAttention({
    info, findings: findings.length, pending: updates.length, adminWarnings: issues.length, lastBackupAt: backups[0]?.created_at, now,
  });

  return (
    <>
      {running && <meta httpEquiv="refresh" content="15" />}
      <nav className={`mb-5 ${muted}`} aria-label="Breadcrumb">
        <Link href="/" className="hover:text-zinc-900 dark:hover:text-zinc-100">Sites</Link> <span aria-hidden className="mx-1">/</span>
        {org && <><Link href={`/?org=${org.id}`} className="hover:text-zinc-900 dark:hover:text-zinc-100">{org.name}</Link> <span aria-hidden className="mx-1">/</span></>} <span className="text-zinc-700 dark:text-zinc-300">{info?.name ?? host(site.url)}</span>
      </nav>

      {/* Site header */}
      <section className="mb-6 rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-semibold uppercase text-white shadow-sm">
              {(info?.name ?? host(site.url))[0]}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{info?.name ?? host(site.url)}</h1>
                {statusData && (attention.length
                  ? <Badge tone={tone}>{attention.length} to review</Badge>
                  : <Badge tone="ok">Healthy</Badge>)}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500">
                <a href={site.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 max-w-full items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100"><span className="truncate">{host(site.url)}</span> <Icon name="external" className="size-3.5 shrink-0" /></a>
                {statusData?.login_url && <a href={statusData.login_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">Admin login <Icon name="external" className="size-3.5" /></a>}
                {statusData && <span>WordPress {statusData.wp} · PHP {statusData.php}</span>}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 xl:flex-nowrap">
            <form action={runCommand} className="contents">
              <input type="hidden" name="id" value={site.id} />
              <SubmitButton name="cmd" value="status">Check for updates</SubmitButton>
              <SubmitButton name="cmd" value="scan">Scan for malware</SubmitButton>
            </form>
            <BackupDialog siteId={site.id} action={runCommand} />
            <Link href={`/sites/${site.id}/report`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
              <Icon name="report" /> Report
            </Link>
            <form action={runCommand}>
              <input type="hidden" name="id" value={site.id} />
              <SubmitButton name="cmd" value="update" variant="primary" confirm="Back up, then install all updates? It rolls back automatically if the site breaks.">
                Back up &amp; update all
              </SubmitButton>
            </form>
          </div>
        </div>
        {attention.length > 0 && (
          <ul className="mt-5 flex flex-wrap gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800" aria-label="Needs attention">
            {attention.map((a) => <li key={a} className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{a}</li>)}
          </ul>
        )}
      </section>

      {running && (
        <p role="status" className="mb-6 flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-indigo-500" />
          {JSON.parse(reports[0].data).job} running on the site. This can take several minutes; the page refreshes until it finishes.
        </p>
      )}

      {/* Key numbers */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon="shield" label="Security" tone={!scan ? "muted" : findings.length ? "bad" : "ok"}
          value={!scan ? "Not scanned" : findings.length ? `${findings.length} finding${findings.length > 1 ? "s" : ""}` : "Clean"}
          sub={scan ? `Scanned ${ago(scan.created_at)}` : "Run a malware scan"} />
        <Kpi icon="refresh" label="Updates" tone={!statusData ? "muted" : updates.length ? "warn" : "ok"}
          value={!statusData ? "Unknown" : updates.length ? `${updates.length} pending` : "Up to date"}
          sub={status ? `Checked ${ago(status.created_at)}` : "Run a check"} />
        <Kpi icon="archive" label="Last backup" tone={!backups.length ? "warn" : backupAge > 2 * DAY ? "warn" : "ok"}
          value={backups[0] ? ago(backups[0].created_at) : "Never"}
          sub={backups[0] ? `${bytes(backups[0].size)} · ${backups.length} on Google Drive` : "Back up before making changes"} />
        <Kpi icon="users" label="Admin accounts" tone={!statusData ? "muted" : issues.length ? "warn" : "ok"}
          value={statusData ? `${statusData.admins.length} admin${statusData.admins.length === 1 ? "" : "s"}` : "Unknown"}
          sub={issues.length ? `${issues.length} warning${issues.length > 1 ? "s" : ""}` : statusData ? "As expected" : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Pending updates" action={updates.length > 0 && <Badge tone="warn">{updates.length}</Badge>}>
            {!statusData ? <p className={muted}>Unknown until the first check.</p> : updates.length ? (
              <form action={runCommand}>
                <input type="hidden" name="id" value={site.id} />
                <input type="hidden" name="pick" value="1" />
                <ul className="-mx-2 text-sm">
                  {updates.map((u) => (
                    <li key={u.type + u.name}>
                      <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                        <span className="flex min-w-0 items-center gap-3">
                          {/* id comes from plugin 0.1.2+; older plugins can only update everything */}
                          {u.id && <input type="checkbox" name="only" value={u.id} defaultChecked className="size-4 shrink-0 accent-indigo-600" />}
                          <span className="truncate font-medium">{u.name}</span>
                          <Badge tone="muted">{u.type}</Badge>
                        </span>
                        <span className="shrink-0 font-mono text-xs text-zinc-500">{u.from} → <span className="text-zinc-900 dark:text-zinc-100">{u.to}</span></span>
                      </label>
                    </li>
                  ))}
                </ul>
                {updates.every((u) => u.id) ? (
                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                    <p className="text-xs text-zinc-500">A full backup is taken first; the site rolls back automatically if it breaks.</p>
                    <SubmitButton name="cmd" value="update" variant="primary" confirm="Back up, then install the ticked updates? It rolls back automatically if the site breaks.">
                      Update selected
                    </SubmitButton>
                  </div>
                ) : <p className={`mt-3 ${muted}`}>Install plugin 0.1.2 on this site to pick individual updates.</p>}
              </form>
            ) : <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400"><Badge tone="ok">Up to date</Badge> WordPress, plugins and themes are current.</p>}
          </Card>

          <Card title="Malware scan" action={scan && <span className="text-xs text-zinc-500">{ago(scan.created_at)}</span>}>
            {!scan ? <p className={muted}>Not scanned yet.</p> : findings.length ? (
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {findings.map((f) => (
                  <li key={f.file + f.reason} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <code className="min-w-0 break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">{f.file}</code>
                    <Badge tone="bad">{f.reason}</Badge>
                  </li>
                ))}
              </ul>
            ) : <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400"><Badge tone="ok">Clean</Badge> No suspicious files found.</p>}
          </Card>

          <Card title="Backups" action={<span className="text-xs text-zinc-500">{backups.length} on Google Drive</span>}>
            {backups.length ? (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {backups.map((b) => (
                  <li key={b.key} className="flex items-center justify-between gap-3 py-3 text-sm first:pt-0 last:pb-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium">{fmtDate(b.created_at)}</span>
                      <span className="tabular-nums text-zinc-500">{bytes(b.size)}</span>
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
            <p className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">Restoring replaces the site’s files and database. To undo a bad update, restore the backup marked “pre-update”.</p>
          </Card>

          <Card title="Activity" action={reports.length > 0 && <span className="text-xs text-zinc-500">Last {reports.length}</span>}>
            {reports.length ? (
              // scrolls inside the card; tabIndex so keyboard users can scroll it too
              <div tabIndex={0} role="region" aria-label="Activity log" className="-mr-3 max-h-96 overflow-y-auto overscroll-contain pr-3 focus-visible:outline-2 focus-visible:outline-indigo-600">
              <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-px before:bg-zinc-200 dark:before:bg-zinc-800">
                {reports.map((r) => {
                  const d = JSON.parse(r.data);
                  const rolledBack = r.type === "update" && r.ok && d.rolled_back;
                  const detail = !r.ok ? d.error
                    : r.type === "queued" ? `${d.job} started`
                    : r.type === "update" ? (rolledBack ? `Rolled back: ${d.reason}` : `${d.updated.length} updated${d.failed?.length ? `, ${d.failed.length} failed` : ""}`)
                      + (d.failed?.length ? ` · ${d.failed.map((f: string) => `${f.split("/")[0]}: ${d.errors?.[f] ?? "no reason recorded (connector older than 0.5.1)"}`).join(" · ")}` : "")
                    : r.type === "scan" ? `${d.findings.length} findings`
                    : r.type === "backup" ? `${bytes(d.size)} uploaded${scopeLabel[d.scope] ? ` (${scopeLabel[d.scope]})` : ""}`
                    : r.type === "connector" ? `Connector updated to ${d.version}`
                    : r.type === "settings" ? Object.entries(d).map(([k, v]) => `${SETTINGS[k as Setting] ?? k} ${v ? "on" : "off"}`).join(", ")
                    : r.type === "user" ? (d.action === "add" ? `Added ${d.login} as ${d.role}` : `Deleted ${d.login}`) : "";
                  return (
                    <li key={r.id} className="relative flex gap-3 pl-0 text-sm">
                      <span aria-hidden className={`relative mt-1.5 size-[7px] shrink-0 rounded-full ring-4 ring-white dark:ring-zinc-900 ${!r.ok ? "bg-red-500" : rolledBack ? "bg-amber-500" : r.type === "queued" ? "bg-indigo-500" : "bg-emerald-500"}`} />
                      <div className="min-w-0">
                        <p><span className="font-medium capitalize">{r.type === "queued" ? "Started" : r.type}</span> <span className="text-zinc-500">· {fmtDate(r.created_at)}</span>{!r.ok && <span className="sr-only"> failed</span>}</p>
                        {detail && <p className={`break-words ${!r.ok ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>{String(detail).slice(0, 600)}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
              </div>
            ) : <p className={muted}>Nothing yet. Connect the plugin, then run “Check for updates”.</p>}
          </Card>
        </div>

        <div className="space-y-6">
          {orgs.length > 0 && canMove && (
            <Card title="Organization">
              <form action={setSiteOrg} className="flex gap-2">
                <input type="hidden" name="id" value={site.id} />
                <label htmlFor="site_org" className="sr-only">Organization</label>
                <select id="site_org" name="org_id" defaultValue={site.org_id ?? ""} className={inputClass}>
                  <option value="">No organization</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <SubmitButton>Save</SubmitButton>
              </form>
            </Card>
          )}

          <Card title="Site controls">
            {info?.maintenance === undefined ? <p className={muted}>{statusData ? "Update the connector and run “Check for updates” to control these." : "Unknown until the first check."}</p> : (
              <ul className="space-y-4">
                <Control siteId={site.id} setting="maintenance" on={info.maintenance} hint="Visitors see a “back soon” page; logged-in admins still see the site."
                  confirm={info.maintenance ? undefined : "Put the site in maintenance mode? Visitors see a “back soon” page; logged-in admins still see the site."} />
                <Control siteId={site.id} setting="debug" on={info.debug} hint="WordPress debugging. Errors are never shown to visitors." />
                {info.debug_log !== undefined && <Control siteId={site.id} setting="debug_log" on={info.debug_log} hint="Write errors to wp-content/debug.log (needs debug mode)." />}
              </ul>
            )}
          </Card>

          <Card title="Site overview">
            {!info ? <p className={muted}>{statusData ? "Install connector 0.3.0 and run “Check for updates” to see details." : "Unknown until the first check."}</p> : (
              <dl className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {([
                  ["WordPress", statusData.wp],
                  ["PHP", `${statusData.php} · ${info.memory_limit} memory`],
                  ["Theme", info.theme],
                  ["Plugins", `${info.plugins_active} active of ${info.plugins_total}`],
                  ["Users", info.users],
                  ["Database", bytes(info.db_size)],
                  ["Disk free", info.disk_free == null ? "unknown" : bytes(info.disk_free)],
                  ["HTTPS", info.https ? "Yes" : <Badge tone="bad">No</Badge>],
                  ["Search engines", info.indexing ? "Allowed" : <Badge tone="warn">Discouraged</Badge>],
                  ["Server", info.server || "unknown"],
                ] as [string, React.ReactNode][]).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
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
                  <li key={u.login} className="flex items-center justify-between gap-2 py-2.5 first:pt-0">
                    <div className="flex min-w-0 items-center gap-3">
                      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-zinc-100 text-xs font-semibold uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{u.login.slice(0, 2)}</span>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{u.login} <span className="text-xs font-normal text-zinc-500">{u.role}</span></p>
                        <p className="truncate text-xs text-zinc-500">{u.email}</p>
                      </div>
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
              <details className="group mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                <summary className="cursor-pointer text-sm font-medium text-indigo-600 dark:text-indigo-400">+ Add user</summary>
                <form action={manageUser} className="mt-3 space-y-2">
                  <input type="hidden" name="id" value={site.id} />
                  <input type="hidden" name="action" value="add" />
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
                  <p className="text-xs text-zinc-500">They get an email to set their own password. Subscribers and customers aren’t listed.</p>
                </form>
              </details>
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

          <Card title="Connector plugin">
            <div className="mb-3 flex items-center justify-between gap-2 text-sm">
              <span>Version <span className="font-medium">{statusData?.connector ?? (statusData ? "older than 0.3.0" : "unknown")}</span></span>
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
              <summary className="cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-400">Show connection key</summary>
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

// setting row with an on/off switch; only rendered for connector 0.5.0+ (which reports info.maintenance)
function Control({ siteId, setting, on, hint, confirm }: { siteId: string; setting: Setting; on: boolean; hint: string; confirm?: string }) {
  return (
    <li className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{SETTINGS[setting]}</p>
        <p className="text-xs text-zinc-500">{hint}</p>
      </div>
      <form action={toggleSetting}>
        <input type="hidden" name="id" value={siteId} />
        <input type="hidden" name="setting" value={setting} />
        <input type="hidden" name="on" value={on ? "0" : "1"} />
        <Switch on={on} label={SETTINGS[setting]} confirm={confirm} />
      </form>
    </li>
  );
}
