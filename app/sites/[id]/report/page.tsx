import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PrintButton } from "@/app/buttons";
import { Badge, bytes, fmtDay, host, Logo, Shell, Skeleton } from "@/app/ui";
import { adminIssues, type Env, getSite, siteBackups, siteReports, siteReportsSince, summarize } from "@/lib/hub";

export const metadata = { title: "Site report · WP Control Hub" };

export default function ReportPage({ params, searchParams }: PageProps<"/sites/[id]/report">) {
  return (
    <Shell>
      <Suspense fallback={<Skeleton rows={6} />}>
        <SiteReport params={params} searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}

const PERIODS = [7, 30, 90];
const scopeLabel = { both: "Database + files", db: "Database", files: "Files" } as const;

async function SiteReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: PageProps<"/sites/[id]/report">["searchParams"] }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const days = PERIODS.includes(Number(sp.days)) ? Number(sp.days) : 30;
  const env = getCloudflareContext().env as Env;
  const site = await getSite(env, id);
  if (!site) notFound();
  // eslint-disable-next-line react-hooks/purity -- server component, rendered per request
  const now = Date.now();
  const since = now - days * 86_400_000;
  const [period, recent, allBackups] = await Promise.all([siteReportsSince(env, id, since), siteReports(env, id, 200), siteBackups(env, id)]);
  const s = summarize(period);
  const status = recent.find((r) => r.type === "status" && r.ok);
  const st = status ? JSON.parse(status.data) : null;
  const info = st?.info;
  const issues = adminIssues(site, status, Number(env.MAX_ADMINS));
  const name = info?.name ?? host(site.url);

  const checks: [string, boolean, string][] = info ? [
    ["HTTPS enabled", info.https, info.https ? "Secure connection" : "Site is served without HTTPS"],
    ["Software up to date", !st.updates.length, st.updates.length ? `${st.updates.length} update${st.updates.length > 1 ? "s" : ""} waiting` : "WordPress, plugins and themes current"],
    ["No suspicious files", !s.latestFindings.length, s.lastScanAt ? (s.latestFindings.length ? `${s.latestFindings.length} found in the last scan` : "Last scan was clean") : "No scan in this period"],
    ["Recent backup", !!allBackups[0] && now - allBackups[0].created_at < 2 * 86_400_000, allBackups[0] ? `Last backup ${fmtDay(allBackups[0].created_at)}` : "No backups yet"],
    ["Admin accounts as expected", !issues.length, issues.length ? issues.join("; ") : `${st.admins.length} administrator${st.admins.length === 1 ? "" : "s"}`],
    ["Visible to search engines", info.indexing, info.indexing ? "Indexing allowed" : "Search engines are discouraged"],
  ] : [];
  const passed = checks.filter((c) => c[1]).length;

  return (
    <>
      {/* screen-only toolbar */}
      <div className="mb-6 flex flex-col gap-3 print:hidden sm:flex-row sm:items-center sm:justify-between">
        <Link href={`/sites/${site.id}`} className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Back to {name}</Link>
        <div className="flex items-center gap-2">
          <nav aria-label="Report period" className="flex rounded-lg border border-zinc-200 bg-white p-0.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            {PERIODS.map((p) => (
              <Link key={p} href={`?days=${p}`} aria-current={p === days ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 font-medium ${p === days ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"}`}>
                {p} days
              </Link>
            ))}
          </nav>
          <PrintButton />
        </div>
      </div>

      {/* the document: always light so the PDF looks the same as the screen */}
      <article className="mx-auto max-w-4xl rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-900 shadow-sm sm:p-10 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-col gap-6 border-b border-zinc-200 pb-8 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600">Website care report</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{name}</h1>
            <p className="mt-1 text-sm text-zinc-500">{host(site.url)}</p>
          </div>
          <div className="text-sm sm:text-right">
            <p className="font-medium">{fmtDay(since)} – {fmtDay(now)}</p>
            <p className="text-zinc-500">Last {days} days · generated {fmtDay(now)}</p>
            <p className="mt-3 inline-flex items-center gap-2 text-zinc-500 sm:justify-end"><span className="scale-75"><Logo /></span> WP Control Hub</p>
          </div>
        </header>

        {/* headline numbers */}
        <section aria-label="Summary" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 my-8 sm:grid-cols-4">
          {([
            ["Updates installed", s.installed.length, s.failedUpdates.length ? `${s.failedUpdates.length} need attention` : "All applied cleanly"],
            ["Backups made", s.backups.length, s.backups.length ? `${bytes(s.backupBytes)} stored` : "None in this period"],
            ["Security scans", s.scans, s.lastScanAt ? (s.latestFindings.length ? `${s.latestFindings.length} finding${s.latestFindings.length > 1 ? "s" : ""}` : "No threats found") : "None in this period"],
            ["Health checks", info ? `${passed}/${checks.length}` : "–", info ? (passed === checks.length ? "All passed" : `${checks.length - passed} to review`) : "No data yet"],
          ] as const).map(([label, value, sub]) => (
            <div key={label} className="bg-white p-5">
              <p className="text-xs font-medium text-zinc-500">{label}</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
              <p className="mt-1 text-xs text-zinc-500">{sub}</p>
            </div>
          ))}
        </section>

        {info && (
          <Section title="Health checks">
            <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {checks.map(([label, ok, detail]) => (
                <li key={label} className="flex items-start gap-3">
                  <span aria-hidden className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white ${ok ? "bg-emerald-500" : "bg-amber-500"}`}>{ok ? "✓" : "!"}</span>
                  <div>
                    <p className="text-sm font-medium">{label}<span className="sr-only">{ok ? ": passed" : ": needs attention"}</span></p>
                    <p className="text-xs text-zinc-500">{detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Updates">
          {s.installed.length || s.failedUpdates.length || s.rollbacks.length ? (
            <Table head={["Item", "Date", "Result"]} rows={[
              ...s.installed.map((u) => [u.name, fmtDay(u.at), <Badge key="ok" tone="ok">Updated</Badge>]),
              ...s.failedUpdates.map((u) => [<span key="n">{u.name}{u.reason && <span className="block text-xs text-zinc-500">{u.reason}</span>}</span>, "–", <Badge key="f" tone="warn">Not updated</Badge>]),
              ...s.rollbacks.map((r) => [<span key="n">Update batch<span className="block text-xs text-zinc-500">{r.reason}</span></span>, fmtDay(r.at), <Badge key="r" tone="warn">Rolled back safely</Badge>]),
            ]} />
          ) : <Empty>No updates were needed in this period.</Empty>}
        </Section>

        <Section title="Backups">
          {s.backups.length ? (
            <Table head={["Date", "Contents", "Size"]} rows={s.backups.slice(0, 15).map((b) => [fmtDay(b.at), scopeLabel[b.scope] ?? b.scope, bytes(b.size)])}
              foot={s.backups.length > 15 ? `+ ${s.backups.length - 15} more` : undefined} />
          ) : <Empty>No backups in this period.</Empty>}
          <p className="mt-3 text-xs text-zinc-500">Backups are stored off-site on Google Drive and can be restored at any time.</p>
        </Section>

        <Section title="Security">
          {!s.lastScanAt ? <Empty>No malware scan ran in this period.</Empty> : s.latestFindings.length ? (
            <Table head={["File", "Finding"]} rows={s.latestFindings.map((f) => [<code key="f" className="break-all font-mono text-xs">{f.file}</code>, f.reason])} />
          ) : <Empty>{s.scans} scan{s.scans > 1 ? "s" : ""} ran; the latest ({fmtDay(s.lastScanAt)}) found no suspicious files.</Empty>}
        </Section>

        {info && (
          <Section title="Site details">
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              {([
                ["WordPress", st.wp], ["PHP", st.php], ["Theme", info.theme],
                ["Plugins", `${info.plugins_active} active of ${info.plugins_total}`],
                ["Database size", bytes(info.db_size)], ["Users", info.users],
              ] as [string, React.ReactNode][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-zinc-100 py-1.5">
                  <dt className="text-zinc-500">{k}</dt><dd className="text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}

        {s.changes.length > 0 && (
          <Section title="Other changes">
            <ul className="space-y-1.5 text-sm">
              {s.changes.map((c) => <li key={c.at + c.text} className="flex gap-4"><span className="w-28 shrink-0 text-zinc-500">{fmtDay(c.at)}</span>{c.text}</li>)}
            </ul>
          </Section>
        )}

        <footer className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-400">
          Prepared with WP Control Hub · {fmtDay(now)}
        </footer>
      </article>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 break-inside-avoid">
      <h2 className="mb-3 text-base font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-zinc-50 px-4 py-3 text-sm text-zinc-600">{children}</p>;
}

function Table({ head, rows, foot }: { head: string[]; rows: React.ReactNode[][]; foot?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500">
          <tr>{head.map((h, i) => <th key={h} className={`px-4 py-2 font-medium ${i === head.length - 1 ? "text-right" : ""}`}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={`px-4 py-2.5 align-top ${j === r.length - 1 ? "text-right" : ""}`}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {foot && <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">{foot}</p>}
    </div>
  );
}
