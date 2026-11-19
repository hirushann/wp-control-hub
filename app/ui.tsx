import Link from "next/link";
import { currentUser, logout } from "./actions";
import { NavLink, SubmitButton } from "./buttons";
import { PLUGIN_VERSION } from "@/lib/hub";

export function ago(t?: number) {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export const host = (url: string) => url.replace(/^https?:\/\//, "");
export const bytes = (n: number) => (n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
export const fmtDate = (t: number) => new Date(t).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
export const fmtDay = (t: number) => new Date(t).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });

// 24px stroke icons, decorative (always next to a text label)
const ICONS = {
  shield: "M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9Z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  archive: "M3 7h18v4H3zM5 11v8h14v-8M10 15h4",
  users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  report: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5ZM14 3v5h5M9 13h6M9 17h6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
} as const;
export function Icon({ name, className = "size-4" }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Logo() {
  return (
    <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-indigo-600 text-white shadow-sm shadow-indigo-600/30">
      <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/85 backdrop-blur print:hidden dark:border-zinc-800 dark:bg-zinc-950/85">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
              <Logo /> <span className="hidden sm:inline">WP Control Hub</span>
            </Link>
            <MainNav />
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {/* ?v= so browsers don't hand back an older cached zip after a release */}
            <a href={`/wp-control-hub.zip?v=${PLUGIN_VERSION}`} download="wp-control-hub.zip" title={`Download the WordPress plugin (connector ${PLUGIN_VERSION})`}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
              <Icon name="download" /> <span className="hidden md:inline">Plugin {PLUGIN_VERSION}</span><span className="sr-only md:hidden">Download WordPress plugin</span>
            </a>
            <UserNav />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 print:max-w-none print:p-0">{children}</main>
    </>
  );
}

export function Card({ title, action, children, className = "" }: {
  title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {title && (
        <div className="flex min-h-13 items-center justify-between gap-3 border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export type Tone = "ok" | "warn" | "bad" | "muted";
const toneClass: Record<Tone, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/25",
  warn: "bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/25",
  bad: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/25",
  muted: "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700",
};
const dotClass: Record<Tone, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500", muted: "bg-zinc-400" };

export function Badge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${toneClass[tone]}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${dotClass[tone]}`} />
      {children}
    </span>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-zinc-200/70 dark:bg-zinc-800" />)}
    </div>
  );
}

export const inputClass =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/15 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-300 dark:focus:ring-white/10";

export function Kpi({ icon, label, value, sub, tone = "muted" }: { icon: keyof typeof ICONS; label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone }) {
  const iconTone = { ok: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400", warn: "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400", bad: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400", muted: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" }[tone];
  return (
    <div className="flex items-start gap-3.5 rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-zinc-800 dark:bg-zinc-900">
      <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${iconTone}`}><Icon name={icon} className="size-5" /></span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-zinc-500">{label}</p>
        <p className="mt-0.5 truncate text-lg font-semibold tracking-tight">{value}</p>
        {sub && <p className="truncate text-xs text-zinc-500">{sub}</p>}
      </div>
    </div>
  );
}

async function MainNav() {
  const me = await currentUser();
  return (
    <nav aria-label="Main" className="flex items-center gap-1 overflow-x-auto text-sm">
      <NavLink href="/">Sites</NavLink>
      {me?.role === "super" && <NavLink href="/organizations">Organizations</NavLink>}
      {me?.role === "super" && <NavLink href="/team">Team</NavLink>}
    </nav>
  );
}

async function UserNav() {
  const me = await currentUser();
  return (
    <div className="flex items-center gap-3 text-sm">
      {me && (
        <Link href="/account" className="flex items-center gap-2.5 rounded-full py-1 pr-1 pl-1 hover:bg-zinc-100 sm:pr-3 dark:hover:bg-zinc-800">
          <span aria-hidden className="grid size-8 place-items-center rounded-full bg-indigo-50 text-xs font-semibold uppercase text-indigo-700 ring-1 ring-indigo-600/15 dark:bg-indigo-500/15 dark:text-indigo-300">{me.username.slice(0, 2)}</span>
          <span className="hidden leading-tight sm:block">
            <span className="block font-medium">{me.username}</span>
            <span className="block text-xs text-zinc-500">{me.role === "super" ? "Super admin" : "Manager"}</span>
          </span>
          <span className="sr-only sm:hidden">Account</span>
        </Link>
      )}
      <form action={logout}>
        <SubmitButton variant="ghost">Sign out</SubmitButton>
      </form>
    </div>
  );
}
