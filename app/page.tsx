import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { addSite } from "./actions";
import { SubmitButton } from "./buttons";
import { Card, host, inputClass, Shell, Skeleton, Stat, Status } from "./ui";
import { adminIssues, type Env, getSites, latestReports } from "@/lib/hub";

export default function Home() {
  return (
    <Shell>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sites</h1>
          <p className="mt-1 text-sm text-zinc-500">Daily checks and backups run at 02:00 UTC. Malware scans run every second day.</p>
        </div>
        <form action={addSite} className="flex w-full gap-2 sm:w-auto">
          <label className="sr-only" htmlFor="url">Site URL</label>
          <input id="url" name="url" type="url" required placeholder="https://client-site.com" className={`${inputClass} sm:w-72`} />
          <SubmitButton variant="primary">Add site</SubmitButton>
        </form>
      </div>
      <Suspense fallback={<Skeleton rows={4} />}>
        <Sites />
      </Suspense>
    </Shell>
  );
}

async function Sites() {
  await connection();
  const env = getCloudflareContext().env as Env;
  const [sites, latest] = await Promise.all([getSites(env), latestReports(env)]);
  const max = Number(env.MAX_ADMINS);

  if (!sites.length) {
    return (
      <Card>
        <div className="py-10 text-center">
          <p className="font-medium">No sites yet</p>
          <ol className="mx-auto mt-3 max-w-sm space-y-1 text-left text-sm text-zinc-500">
            <li>1. Add a site’s URL above.</li>
            <li>2. Install the Control Hub plugin on that WordPress site.</li>
            <li>3. Paste the connection key from the site’s page into Settings → Control Hub.</li>
          </ol>
        </div>
      </Card>
    );
  }

  const rows = sites.map((s) => {
    const r = (t: string) => latest.get(`${s.id}:${t}`);
    const status = r("status"), scan = r("scan"), update = r("update"), backup = r("backup");
    return {
      s, status, scan, update, backup,
      findings: scan?.ok ? JSON.parse(scan.data).findings.length : 0,
      issues: adminIssues(s, status, max),
      pending: status?.ok ? JSON.parse(status.data).updates.length : 0,
      rolledBack: update?.ok ? JSON.parse(update.data).rolled_back : false,
      failed: [status, scan, update, backup, r("restore")].some((x) => x && !x.ok),
    };
  });
  const count = (f: (x: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const malware = count((x) => x.findings > 0), admins = count((x) => x.issues.length > 0), failed = count((x) => x.failed);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Sites" value={sites.length} />
        <Stat label="Malware alerts" value={malware} tone={malware ? "bad" : undefined} />
        <Stat label="Admin warnings" value={admins} tone={admins ? "warn" : undefined} />
        <Stat label="Pending updates" value={rows.reduce((n, x) => n + x.pending, 0)} />
        <Stat label="Sites with failed jobs" value={failed} tone={failed ? "bad" : undefined} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-zinc-100 text-xs text-zinc-500 dark:border-zinc-800">
            <tr>
              {["Site", "Malware", "Admins", "Updates", "Backup", "Last update run"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((x) => (
              <tr key={x.s.id} className="group relative hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <td className="px-4 py-3">
                  {/* stretched link: whole row is clickable */}
                  <Link href={`/sites/${x.s.id}`} className="font-medium after:absolute after:inset-0 group-hover:underline">
                    {host(x.s.url)}
                  </Link>
                </td>
                <td className="px-4 py-3"><Status r={x.scan} tone={x.findings ? "bad" : "ok"}>{x.findings ? `${x.findings} finding${x.findings > 1 ? "s" : ""}` : "Clean"}</Status></td>
                <td className="px-4 py-3"><Status r={x.status} tone={x.issues.length ? "warn" : "ok"}>{x.issues.length ? `${x.issues.length} warning${x.issues.length > 1 ? "s" : ""}` : "OK"}</Status></td>
                <td className="px-4 py-3"><Status r={x.status} tone={x.pending ? "warn" : "ok"}>{x.pending ? `${x.pending} pending` : "Up to date"}</Status></td>
                <td className="px-4 py-3"><Status r={x.backup}>Uploaded</Status></td>
                <td className="px-4 py-3"><Status r={x.update} tone={x.rolledBack ? "warn" : "ok"}>{x.rolledBack ? "Rolled back" : "Updated"}</Status></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
