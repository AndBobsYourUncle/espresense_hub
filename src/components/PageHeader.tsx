export default function PageHeader({
  title,
  description,
  actions,
  inline,
}: {
  title: string;
  description?: string;
  /** Right-side controls. */
  actions?: React.ReactNode;
  /** Inline controls rendered immediately after the title block, on the left. */
  inline?: React.ReactNode;
}) {
  return (
    <header className="h-16 border-b border-zinc-200 dark:border-zinc-800 px-6 flex items-center justify-between gap-4 shrink-0">
      <div className="flex items-center gap-4 min-w-0">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="text-xs text-zinc-500 truncate">{description}</p>
          )}
        </div>
        {inline && <div className="flex items-center gap-2">{inline}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
