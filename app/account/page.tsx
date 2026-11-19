import { Suspense } from "react";
import { changeOwnPassword, currentUser } from "@/app/actions";
import { SubmitButton } from "@/app/buttons";
import { Card, inputClass, Shell, Skeleton } from "@/app/ui";
import { ROOT_USERNAME } from "@/lib/hub";

export const metadata = { title: "Account · WP Control Hub" };

export default function AccountPage({ searchParams }: PageProps<"/account">) {
  return (
    <Shell>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Your account</h1>
      <Suspense fallback={<Skeleton rows={2} />}>
        <Account searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}

async function Account({ searchParams }: { searchParams: PageProps<"/account">["searchParams"] }) {
  const [me, { error, saved }] = await Promise.all([currentUser(), searchParams]);
  if (!me) return null;

  return (
    <Card title="Change password" className="max-w-md">
      <p className="mb-4 text-sm text-zinc-500">Signed in as <span className="font-medium text-zinc-900 dark:text-zinc-100">{me.username}</span> ({me.role === "super" ? "Super admin" : "Manager"}).</p>
      {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">{String(error)}</p>}
      {saved && <p role="status" className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">Password changed.</p>}
      {me.username === ROOT_USERNAME ? (
        <p className="text-sm text-zinc-500">The built-in admin’s password is the <code>ADMIN_PASSWORD</code> secret. Change it in Cloudflare → Workers → wp-control-hub → Settings → Variables and Secrets (this signs everyone out).</p>
      ) : (
        <form action={changeOwnPassword} className="space-y-3">
          <input type="hidden" name="username" value={me.username} autoComplete="username" />
          <div className="space-y-1.5">
            <label htmlFor="current" className="block text-sm font-medium">Current password</label>
            <input id="current" name="current" type="password" required autoComplete="current-password" className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium">New password <span className="font-normal text-zinc-500">(10+ characters)</span></label>
            <input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="confirm" className="block text-sm font-medium">Repeat new password</label>
            <input id="confirm" name="confirm" type="password" required minLength={10} autoComplete="new-password" className={inputClass} />
          </div>
          <div className="grid"><SubmitButton variant="primary">Change password</SubmitButton></div>
        </form>
      )}
    </Card>
  );
}
