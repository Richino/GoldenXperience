import { Bell } from "lucide-react";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  className = "",
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={`mb-6 md:mb-8 ${className}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-2 text-xs font-medium text-[color:var(--muted)]">
              {eyebrow}
            </p>
          )}
          <h1 className="text-display">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[color:var(--muted)]">
              {description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          <button
            aria-label="Notifications"
            className="pressable relative hidden size-10 place-items-center rounded-full bg-[color:var(--surface)] text-[color:var(--muted-strong)] hover:text-[color:var(--foreground)] lg:grid"
            type="button"
          >
            <Bell className="size-[18px]" />
            <span className="absolute right-2 top-2 size-2 rounded-full bg-[color:var(--danger)]" />
          </button>
        </div>
      </div>
    </header>
  );
}
