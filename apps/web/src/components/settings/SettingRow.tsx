import type { ReactNode } from "react";

export function SettingsSection({
  title,
  badge,
  children
}: {
  title: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-surface-border bg-surface/40 p-4 sm:p-5">
      <div className="mb-2 flex items-center gap-2">
        {badge ? (
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs font-medium text-accent">
            {badge}
          </span>
        ) : null}
        <h2 className="text-xs font-medium text-foreground-muted">{title}</h2>
      </div>
      <div className="divide-y divide-surface-border/50">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  children,
  stacked = false
}: {
  label: string;
  description: string;
  children: ReactNode;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="py-3 sm:py-3.5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">{description}</p>
        </div>
        <div className="mt-2.5 w-full">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-12 items-center justify-between gap-3 py-2.5 sm:gap-4">
      <div className="min-w-0 pr-1 sm:pr-2">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
