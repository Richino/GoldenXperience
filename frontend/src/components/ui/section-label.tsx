import type { LucideIcon } from "lucide-react";

export function SectionLabel({
  title,
  icon: Icon,
  variant = "default",
}: {
  title: string;
  icon?: LucideIcon;
  variant?: "default" | "minimal";
}) {
  if (variant === "minimal") {
    return (
      <h2 className="text-sm font-medium tracking-[-0.02em] text-[color:var(--foreground)]">
        {title}
      </h2>
    );
  }

  return (
    <div className="flex items-center gap-2.5">
      {Icon ? (
        <span className="icon-tile-accent grid size-8 place-items-center rounded-xl">
          <Icon className="size-4" strokeWidth={2} />
        </span>
      ) : null}
      <h2 className="text-section-title">{title}</h2>
    </div>
  );
}
