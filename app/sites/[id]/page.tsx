import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { restoreBackup, runCommand, saveAllowedAdmins } from "@/app/actions";
import { SubmitButton } from "@/app/buttons";
import { ago, Badge, Card, host, inputClass, Shell, Skeleton } from "@/app/ui";
import { adminIssues, connectionKey, type Env, getSite, siteBackups, siteReports } from "@/lib/hub";

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
  const findings: { file: string; reason: string }[] = scan ? JSON.parse(scan.data).findings : [];
  const issues = adminIssues(site, status, Number(env.MAX_ADMINS));
  const updates: { id?: string; type: string; name: string; from: string; to: string }[] = statusData?.updates ?? [];
  // a backup was sent and the site hasn't reported back yet (backups of big sites take several minutes)
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
        <form action={runCommand} className="flex flex-wrap gap-2">
          <input type="hidden" name="id" value={site.id} />
          <SubmitButton name="cmd" value="status">Check users &amp; updates</SubmitButton>
          <SubmitButton name="cmd" value="scan">Scan for malware</SubmitButton>
          <SubmitButton name="cmd" value="backup">Back up now</SubmitButton>
          <SubmitButton name="cmd" value="update" variant="primary" confirm="Back up, then install all updates? It rolls back automatically if the site breaks.">
            Back up &amp; update
          </SubmitButton>
        </form>
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
                    </div>
                    <form action={restoreBackup}>
                      <input type="hidden" name="id" value={site.id} />
                      <input type="hidden" name="key" value={b.key} />
                      <SubmitButton variant="danger" confirm={`Restore ${host(site.url)} to ${fmtDate(b.created_at)}? This overwrites the live site.`}>Restore</SubmitButton>
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
                    : r.type === "scan" ? `${d.findings.length} findings`
                    : r.type === "backup" ? `${(d.size / 1e6).toFixed(1)} MB uploaded` : "";
                  return (
                    <li key={r.id} className="flex gap-3 text-sm">
                      <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${!r.ok ? "bg-red-500" : rolledBack ? "bg-amber-500" : r.type === "queued" ? "bg-blue-500" : "bg-emerald-500"}`} />
                      <div className="min-w-0">
                        <p><span className="font-medium capitalize">{r.type === "queued" ? "Started" : r.type}</span> <span className="text-zinc-500">· {fmtDate(r.created_at)}</span>{!r.ok && <span className="sr-only"> failed</span>}</p>
                        {detail && <p className={`break-words ${!r.ok ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>{String(detail).slice(0, 240)}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : <p className={muted}>Nothing yet. Connect the plugin, then run “Check users &amp; updates”.</p>}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Admin accounts" action={status && <span className="text-xs text-zinc-500">{ago(status.created_at)}</span>}>
            {issues.length > 0 && (
              <ul className="mb-3 space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-300">
                {issues.map((i) => <li key={i}>⚠ {i}</li>)}
              </ul>
            )}
            {statusData ? (
              <ul className="space-y-1.5 text-sm">
                {statusData.admins.map((a: { login: string; email: string }) => (
                  <li key={a.login} className="flex justify-between gap-2">
                    <span className="font-medium">{a.login}</span><span className="truncate text-zinc-500">{a.email}</span>
                  </li>
                ))}
              </ul>
            ) : <p className={muted}>No status yet.</p>}
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
