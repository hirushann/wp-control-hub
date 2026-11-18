"use client";
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
