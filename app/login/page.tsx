import { Suspense } from "react";
import { login } from "../actions";
import { SubmitButton } from "../buttons";
import { inputClass, Logo } from "../ui";

export const metadata = { title: "Sign in · WP Control Hub" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="grid flex-1 place-items-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sign in to WP Control Hub</h1>
            <p className="mt-1 text-sm text-zinc-500">Manage backups, updates and security for all your sites.</p>
          </div>
        </div>
        <form action={login} className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <Suspense>
            <LoginError searchParams={searchParams} />
          </Suspense>
          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium">Password</label>
            <input id="password" name="password" type="password" required autoFocus autoComplete="current-password" className={inputClass} />
          </div>
          <div className="grid">
            <SubmitButton variant="primary">Sign in</SubmitButton>
          </div>
        </form>
      </div>
    </main>
  );
}

async function LoginError({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const { error } = await searchParams;
  if (!error) return null;
  return <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">Wrong password. Try again.</p>;
}
