import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { addOrg, currentUser, deleteOrg, renameOrg } from "@/app/actions";
import { SubmitButton } from "@/app/buttons";
import { Card, inputClass, Shell, Skeleton } from "@/app/ui";
import { type Env, getOrgs } from "@/lib/hub";

export const metadata = { title: "Organizations · WP Control Hub" };

export default function OrganizationsPage({ searchParams }: PageProps<"/organizations">) {
  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
        <p className="mt-1 text-sm text-zinc-500">Group sites by company or client. Reports for a site show its organization as the sender.</p>
      </div>
      <Suspense fallback={<Skeleton rows={3} />}>
        <Organizations searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}

async function Organizations({ searchParams }: { searchParams: PageProps<"/organizations">["searchParams"] }) {
  const me = await currentUser();
  if (me?.role !== "super") notFound();
  const [{ error }, orgs] = await Promise.all([searchParams, getOrgs(getCloudflareContext().env as Env)]);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="All organizations" className="lg:col-span-2" action={<span className="text-xs text-zinc-500">{orgs.length}</span>}>
        {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">{String(error)}</p>}
        {orgs.length ? (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {orgs.map((o) => (
              <li key={o.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-zinc-900 text-sm font-semibold uppercase text-white dark:bg-white dark:text-zinc-900">{o.name.slice(0, 2)}</span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{o.name}</p>
                    <Link href={`/?org=${o.id}`} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">{o.sites} site{o.sites === 1 ? "" : "s"}</Link>
                  </div>
                </div>
                <div className="flex gap-2">
                  <form action={renameOrg} className="flex gap-2">
                    <input type="hidden" name="org_id" value={o.id} />
                    <label htmlFor={`name-${o.id}`} className="sr-only">New name for {o.name}</label>
                    <input id={`name-${o.id}`} name="name" required maxLength={80} defaultValue={o.name} className={`${inputClass} sm:w-48`} />
                    <SubmitButton>Rename</SubmitButton>
                  </form>
                  <form action={deleteOrg}>
                    <input type="hidden" name="org_id" value={o.id} />
                    <SubmitButton variant="danger" confirm={`Delete ${o.name}? Its ${o.sites} site${o.sites === 1 ? "" : "s"} stay in the hub without an organization.`}>Delete</SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-zinc-500">No organizations yet. Add your first one on the right.</p>}
      </Card>

      <Card title="Add organization">
        <form action={addOrg} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="org-name" className="block text-sm font-medium">Name</label>
            <input id="org-name" name="name" required maxLength={80} placeholder="e.g. Webcraftify" className={inputClass} />
          </div>
          <div className="grid"><SubmitButton variant="primary">Add organization</SubmitButton></div>
        </form>
      </Card>
    </div>
  );
}
