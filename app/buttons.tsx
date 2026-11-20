"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

const variants = {
  primary: "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-500",
  ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
  secondary: "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
  danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950",
};

// Shows a spinner on the clicked button only (forms with several name="cmd" buttons)
export function SubmitButton({ children, name, value, confirm: message, variant = "secondary" }: {
  children: React.ReactNode; name?: string; value?: string; confirm?: string; variant?: keyof typeof variants;
}) {
  const { pending, data } = useFormStatus();
  const busy = pending && (!name || data?.get(name) === value);
  return (
    <button
      name={name}
      value={value}
      disabled={pending}
      aria-busy={busy}
      onClick={(e) => message && !confirm(message) && e.preventDefault()}
      className={`inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]}`}
    >
      {busy && <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

// "Back up" opens a dialog to pick database, files or both, then runs the backup command
export function BackupDialog({ siteId, action }: { siteId: string; action: (form: FormData) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const option = "flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 p-3 has-checked:border-indigo-600 has-checked:bg-indigo-50/60 dark:border-zinc-700 dark:has-checked:border-indigo-400 dark:has-checked:bg-indigo-500/10";
  return (
    <>
      <button type="button" onClick={() => ref.current?.showModal()}
        className={`inline-flex h-9 items-center justify-center whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-white ${variants.secondary}`}>
        Back up
      </button>
      <dialog ref={ref} aria-labelledby="backup-title"
        className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
        <form action={async (form) => { await action(form); ref.current?.close(); }} className="space-y-4 p-5">
          <input type="hidden" name="id" value={siteId} />
          <input type="hidden" name="cmd" value="backup" />
          <div>
            <h2 id="backup-title" className="font-semibold">Back up this site</h2>
            <p className="mt-1 text-sm text-zinc-500">The backup is uploaded to Google Drive.</p>
          </div>
          <fieldset className="space-y-2">
            <legend className="sr-only">What to back up</legend>
            {([["both", "Database + files", "Everything needed to restore the whole site"], ["db", "Database only", "Posts, pages, settings, users; small and fast"], ["files", "Files only", "Themes, plugins, uploads, WordPress core"]] as const).map(([v, label, hint]) => (
              <label key={v} className={option}>
                <input type="radio" name="scope" value={v} defaultChecked={v === "both"} className="mt-1 accent-indigo-600" />
                <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-zinc-500">{hint}</span></span>
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => ref.current?.close()} className={`inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium ${variants.secondary}`}>Cancel</button>
            <SubmitButton variant="primary">Start backup</SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" || path.startsWith("/sites") : path.startsWith(href);
  return (
    <Link href={href} aria-current={active ? "page" : undefined}
      className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${active ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white" : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"}`}>
      {children}
    </Link>
  );
}

// On/off switch that submits its form; the server action flips the setting
export function Switch({ on, label, confirm: message }: { on: boolean; label: string; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={pending}
      onClick={(e) => message && !confirm(message) && e.preventDefault()}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60 ${on ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700"} ${pending ? "animate-pulse" : ""}`}>
      <span aria-hidden className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5.5" : "translate-x-0.5"}`} />
    </button>
  );
}

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium ${variants.primary}`}>
      Save as PDF
    </button>
  );
}

// Re-renders the page every few seconds while jobs run, without a full reload: a reload used to cut off a bulk send
// in flight and wipe ticked boxes. Paused while sites are ticked for a bulk action.
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => { if (!document.querySelector('input[form="bulk"]:checked')) router.refresh(); }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

// Dashboard bar: act on the ticked sites (checkboxes in the rows point at form="bulk"), or on all shown when none are ticked
export function BulkBar({ action, org, total }: { action: (form: FormData) => Promise<void>; org: string; total: number }) {
  const [picked, setPicked] = useState(0);
  useEffect(() => {
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[form="bulk"][name="site"]')];
    // the table and the phone cards each have a box per site, so count unique sites
    const count = () => setPicked(new Set(boxes().filter((b) => b.checked).map((b) => b.value)).size);
    document.addEventListener("change", count);
    return () => document.removeEventListener("change", count);
  }, []);
  const toggleAll = (on: boolean) => {
    document.querySelectorAll<HTMLInputElement>('input[form="bulk"][name="site"]:not(:disabled)').forEach((b) => { b.checked = on; });
    document.dispatchEvent(new Event("change"));
  };
  return (
    <form id="bulk" action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="org" value={org} />
      <label className="mr-1 inline-flex items-center gap-2 text-xs text-zinc-500">
        <input type="checkbox" checked={picked > 0} onChange={(e) => toggleAll(e.target.checked)} className="size-4 accent-indigo-600" aria-label="Select all sites" />
        {picked ? `${picked} selected` : `All ${total} connected`}
      </label>
      <SubmitButton name="cmd" value="status">Check for updates</SubmitButton>
      <SubmitButton name="cmd" value="scan">Scan for malware</SubmitButton>
    </form>
  );
}
