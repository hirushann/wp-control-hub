"use client";
import { useRef } from "react";
import { useFormStatus } from "react-dom";

const variants = {
  primary: "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200",
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
      className={`inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:outline-white ${variants[variant]}`}
    >
      {busy && <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

// "Back up" opens a dialog to pick database, files or both, then runs the backup command
export function BackupDialog({ siteId, action }: { siteId: string; action: (form: FormData) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const option = "flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 p-3 has-checked:border-zinc-900 has-checked:bg-zinc-50 dark:border-zinc-700 dark:has-checked:border-white dark:has-checked:bg-zinc-800";
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
                <input type="radio" name="scope" value={v} defaultChecked={v === "both"} className="mt-1 accent-zinc-900 dark:accent-white" />
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
