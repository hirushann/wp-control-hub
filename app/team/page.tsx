import { notFound } from "next/navigation";
import { Suspense } from "react";
import { addHubUser, currentUser, deleteHubUser, setHubPassword, setHubUserOrg } from "@/app/actions";
import { SubmitButton } from "@/app/buttons";
import { Badge, Card, inputClass, Shell, Skeleton } from "@/app/ui";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type Env, getOrgs, hubUsers, ROOT_USERNAME } from "@/lib/hub";

export const metadata = { title: "Team · WP Control Hub" };

export default function TeamPage({ searchParams }: PageProps<"/team">) {
  return (
    <Shell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-sm text-zinc-500">Who can sign in to this hub. Managers run backups, updates, scans and WordPress users on the sites they can see: one or more organizations’, or all. Super admins see everything and manage users and organizations.</p>
      </div>
      <Suspense fallback={<Skeleton rows={3} />}>
        <Team searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}

const roleLabel = { super: "Super admin", manager: "Manager" } as const;

async function Team({ searchParams }: { searchParams: PageProps<"/team">["searchParams"] }) {
  const me = await currentUser();
  if (me?.role !== "super") notFound();
  const env = getCloudflareContext().env as Env;
  const [{ error, saved }, users, orgs] = await Promise.all([searchParams, hubUsers(env), getOrgs(env)]);
  const chip = "inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 text-xs has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50 has-[:checked]:text-indigo-700 dark:border-zinc-700 dark:has-[:checked]:bg-indigo-500/10 dark:has-[:checked]:text-indigo-300";
  const orgPicker = (legend: string, value: string[]) => (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">{legend}</legend>
      {orgs.map((o) => <label key={o.id} className={chip}><input type="checkbox" name="org_id" value={o.id} defaultChecked={value.includes(o.id)} className="accent-indigo-600" />{o.name}</label>)}
      <label className={chip}><input type="checkbox" name="org_id" value="" defaultChecked={!value.length} className="accent-indigo-600" />All organizations</label>
    </fieldset>
  );
  const orgList = (ids: string[]) => ids.map((id) => orgs.find((o) => o.id === id)?.name ?? "Unknown organization").join(", ");

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Hub users" className="lg:col-span-2">
        {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">{String(error)}</p>}
        {saved && <p role="status" className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">{saved === "org" ? "Access updated." : "Password changed."}</p>}
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          <li className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
            <span className="font-medium">{ROOT_USERNAME} <span className="text-xs font-normal text-zinc-500">built-in, password is the ADMIN_PASSWORD secret</span></span>
            <Badge tone="muted">Super admin</Badge>
          </li>
          {users.map((u) => (
            <li key={u.id} className="flex flex-col gap-3 py-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <span className="flex items-center gap-2 font-medium">{u.username} <Badge tone="muted">{roleLabel[u.role]}</Badge>{u.id === me.id && <span className="text-xs font-normal text-zinc-500">you</span>}</span>
                <span className="text-xs text-zinc-500">
                  {u.role === "super" ? "All sites and settings" : u.orgs.length ? `${orgList(u.orgs)} sites only` : "All organizations’ sites"}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {u.role === "manager" && orgs.length > 0 && (
                  <form action={setHubUserOrg} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="uid" value={u.id} />
                    {orgPicker(`Organizations ${u.username} can see`, u.orgs)}
                    <SubmitButton>Save</SubmitButton>
                  </form>
                )}
                <form action={setHubPassword} className="flex gap-2">
                  <input type="hidden" name="uid" value={u.id} />
                  <label htmlFor={`pw-${u.id}`} className="sr-only">New password for {u.username}</label>
                  <input id={`pw-${u.id}`} name="password" type="password" required minLength={10} autoComplete="new-password" placeholder="New password" className={`${inputClass} sm:w-40`} />
                  <SubmitButton>Set</SubmitButton>
                </form>
                {u.id !== me.id && (
                  <form action={deleteHubUser}>
                    <input type="hidden" name="uid" value={u.id} />
                    <SubmitButton variant="danger" confirm={`Remove ${u.username} from the hub? They are signed out immediately.`}>Remove</SubmitButton>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Add hub user">
        <form action={addHubUser} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="username" className="block text-sm font-medium">Username</label>
            <input id="username" name="username" required pattern="[A-Za-z0-9._\-]{3,32}" autoComplete="off" autoCapitalize="none" className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium">Password <span className="font-normal text-zinc-500">(10+ characters)</span></label>
            <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="role" className="block text-sm font-medium">Role</label>
            <select id="role" name="role" defaultValue="manager" className={inputClass}>
              <option value="manager">Manager: manages WordPress sites</option>
              <option value="super">Super admin: everything, incl. users and organizations</option>
            </select>
          </div>
          {orgs.length > 0 && (
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">Sites they can see <span className="font-normal text-zinc-500">(managers)</span></span>
              {orgPicker("Organizations they can see", [orgs[0].id])}
            </div>
          )}
          <div className="grid"><SubmitButton variant="primary">Add user</SubmitButton></div>
        </form>
      </Card>
    </div>
  );
}
