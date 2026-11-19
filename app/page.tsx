import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { addSite, updateAllConnectors } from "./actions";
import { SubmitButton } from "./buttons";
import { ago, Badge, Card, host, Icon, inputClass, Kpi, Shell, Skeleton, type Tone } from "./ui";
import { adminIssues, connectorVersion, type Env, getSites, lastBackups, latestReports, PLUGIN_VERSION, siteAttention } from "@/lib/hub";

export default function Home() {
  return (
    <Shell>
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sites</h1>
          <p className="mt-1 text-sm text-zinc-500">Daily checks and backups run at 02:00 UTC. Malware scans run every second day.</p>
        </div>
        <form action={addSite} className="flex w-full gap-2 lg:w-auto">
          <label className="sr-only" htmlFor="url">Site URL</label>
          <input id="url" name="url" type="url" required placeholder="https://client-site.com" className={`${inputClass} lg:w-80`} />
          <SubmitButton variant="primary">Add site</SubmitButton>
        </form>
      </div>
      <Suspense fallback={<Skeleton rows={4} />}>
        <Sites />
      </Suspense>
    </Shell>
  );
}

const toneLabel = { ok: "Healthy", warn: "Review", bad: "Action needed" } as const;

async function Sites() {
  await connection();
  const env = getCloudflareContext().env as Env;
  const [sites, latest, backups] = await Promise.all([getSites(env), latestReports(env), lastBackups(env)]);
  const max = Number(env.MAX_ADMINS);
  // eslint-disable-next-line react-hooks/purity -- server component, rendered per request
  const now = Date.now();

  if (!sites.length) {
    return (
      <Card>
        <div className="py-12 text-center">
          <span aria-hidden className="mx-auto grid size-12 place-items-center rounded-2xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400"><Icon name="shield" className="size-6" /></span>
          <p className="mt-4 font-semibold">No sites yet</p>
          <ol className="mx-auto mt-3 max-w-sm space-y-1 text-left text-sm text-zinc-500">
            <li>1. Add a site’s URL above.</li>
            <li>2. Install the connector plugin on that WordPress site (<a href="/wp-control-hub.zip" className="font-medium text-indigo-600 underline dark:text-indigo-400">download</a>).</li>
            <li>3. Paste the connection key from the site’s page into Settings → Control Hub.</li>
          </ol>
        </div>
      </Card>
    );
  }

  const rows = sites.map((s) => {
    const r = (t: string) => latest.get(`${s.id}:${t}`);
    const status = r("status"), scan = r("scan");
    const st = status?.ok ? JSON.parse(status.data) : null;
    const findings = scan?.ok ? JSON.parse(scan.data).findings.length : 0;
    const pending = st?.updates.length ?? 0;
    const issues = adminIssues(s, status, max);
    // a job whose latest run failed (an older failure fixed by a later success doesn't count)
    const failedJobs = ["status", "scan", "update", "backup", "restore", "connector"].filter((t) => r(t) && !r(t)!.ok).length;
    const lastBackupAt = backups.get(s.id);
    const attention = siteAttention({ info: st?.info, findings, pending, adminWarnings: issues.length, lastBackupAt, failedJobs, now });
    return { s, st, scan, status, findings, pending, lastBackupAt, attention, connector: connectorVersion(status), name: st?.info?.name as string | undefined };
  });
  const count = (f: (x: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const outdated = count((x) => !!x.connector && x.connector !== PLUGIN_VERSION);
  const manual = count((x) => !!x.status?.ok && !x.connector);
  const healthy = count((x) => x.attention.tone === "ok");
  const malware = count((x) => x.findings > 0);
  const pendingTotal = rows.reduce((n, x) => n + x.pending, 0);
  const backedUp = count((x) => !!x.lastBackupAt && now - x.lastBackupAt < 2 * 86_400_000);
  // worst first, then by name
  const order = { bad: 0, warn: 1, ok: 2 };
  rows.sort((a, b) => order[a.attention.tone] - order[b.attention.tone] || (a.name ?? host(a.s.url)).localeCompare(b.name ?? host(b.s.url)));

  return (
    <div className="space-y-6">
      {(outdated > 0 || manual > 0) && (
        <div className="flex flex-col gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-950 sm:flex-row sm:items-center sm:justify-between dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-100">
          <p>
            <span className="font-semibold">Connector {PLUGIN_VERSION} is available.</span>
            {outdated > 0 && ` ${outdated} site${outdated > 1 ? "s" : ""} can update from here.`}
            {manual > 0 && <> {manual} site{manual > 1 ? "s run" : " runs"} a version older than 0.3.0: install <a href="/wp-control-hub.zip" className="font-medium underline">the zip</a> by hand once.</>}
          </p>
          {outdated > 0 && (
            <form action={updateAllConnectors}>
              <SubmitButton variant="primary">Update {outdated} site{outdated > 1 ? "s" : ""}</SubmitButton>
            </form>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon="globe" label="Sites" tone={healthy === rows.length ? "ok" : "muted"} value={sites.length} sub={`${healthy} healthy · ${rows.length - healthy} to review`} />
        <Kpi icon="shield" label="Malware alerts" tone={malware ? "bad" : "ok"} value={malware ? `${malware} site${malware > 1 ? "s" : ""}` : "None"} sub={malware ? "Suspicious files found" : "All recent scans clean"} />
        <Kpi icon="refresh" label="Pending updates" tone={pendingTotal ? "warn" : "ok"} value={pendingTotal} sub={pendingTotal ? `Across ${count((x) => x.pending > 0)} site${count((x) => x.pending > 0) === 1 ? "" : "s"}` : "Everything current"} />
        <Kpi icon="archive" label="Backed up in 48h" tone={backedUp === rows.length ? "ok" : "warn"} value={`${backedUp} / ${rows.length}`} sub={backedUp === rows.length ? "All sites covered" : `${rows.length - backedUp} need a backup`} />
      </div>

      <section className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-[15px] font-semibold tracking-tight">All sites</h2>
          <span className="text-xs text-zinc-500">{rows.length} site{rows.length === 1 ? "" : "s"}</span>
        </div>

        {/* table on wide screens */}
        <table className="hidden w-full text-left text-sm md:table">
          <thead className="bg-zinc-50/70 text-xs text-zinc-500 dark:bg-zinc-800/40">
            <tr>
              {["Site", "Health", "Security", "Updates", "Last backup", "WordPress"].map((h) => <th key={h} className="px-5 py-2.5 font-medium">{h}</th>)}
              <th className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((x) => (
              <tr key={x.s.id} className="group relative hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <td className="px-5 py-3.5">
                  <SiteName x={x} />
                </td>
                <td className="px-5 py-3.5"><HealthBadge tone={x.attention.tone} items={x.attention.items} /></td>
                <td className="px-5 py-3.5">{!x.scan ? <Muted>Not scanned</Muted> : !x.scan.ok ? <Badge tone="bad">Scan failed</Badge> : x.findings ? <Badge tone="bad">{x.findings} finding{x.findings > 1 ? "s" : ""}</Badge> : <Badge tone="ok">Clean</Badge>}</td>
                <td className="px-5 py-3.5">{!x.st ? <Muted>Unknown</Muted> : x.pending ? <Badge tone="warn">{x.pending} pending</Badge> : <Badge tone="ok">Up to date</Badge>}</td>
                <td className="px-5 py-3.5">{x.lastBackupAt ? <span className={now - x.lastBackupAt > 2 * 86_400_000 ? "text-amber-700 dark:text-amber-400" : ""}>{ago(x.lastBackupAt)}</span> : <Muted>Never</Muted>}</td>
                <td className="px-5 py-3.5 tabular-nums text-zinc-600 dark:text-zinc-400">{x.st?.wp ?? "–"}</td>
                <td className="px-5 py-3.5 text-right"><ReportLink id={x.s.id} name={x.name ?? host(x.s.url)} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* cards on phones */}
        <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
          {rows.map((x) => (
            <li key={x.s.id} className="relative space-y-3 px-5 py-4">
              <SiteName x={x} />
              <div className="flex flex-wrap gap-2">
                <HealthBadge tone={x.attention.tone} items={x.attention.items} />
                {x.findings > 0 && <Badge tone="bad">{x.findings} finding{x.findings > 1 ? "s" : ""}</Badge>}
                {x.pending > 0 && <Badge tone="warn">{x.pending} pending</Badge>}
                <Badge tone="muted">Backup {ago(x.lastBackupAt)}</Badge>
              </div>
              <ReportLink id={x.s.id} name={x.name ?? host(x.s.url)} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SiteName({ x }: { x: { s: { id: string; url: string }; name?: string } }) {
  const label = x.name ?? host(x.s.url);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold uppercase text-white">{label[0]}</span>
      <div className="min-w-0">
        {/* stretched link: the whole row/card is clickable */}
        <Link href={`/sites/${x.s.id}`} className="block truncate font-medium after:absolute after:inset-0 hover:underline">{label}</Link>
        {x.name && <p className="max-w-64 truncate text-xs text-zinc-500">{host(x.s.url)}</p>}
      </div>
    </div>
  );
}

function HealthBadge({ tone, items }: { tone: Tone; items: string[] }) {
  return <Badge tone={tone} title={items.join("\n") || undefined}>{tone === "ok" ? toneLabel.ok : `${toneLabel[tone as "warn" | "bad"]} · ${items.length}`}</Badge>;
}

// sits above the row's stretched link (relative z-10), so it opens the report instead of the site
function ReportLink({ id, name }: { id: string; name: string }) {
  return (
    <Link href={`/sites/${id}/report`} aria-label={`Report for ${name}`}
      className="relative z-10 inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 hover:border-indigo-300 hover:text-indigo-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300">
      <Icon name="report" className="size-3.5" /> Report
    </Link>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-zinc-400 dark:text-zinc-500">{children}</span>;
}
