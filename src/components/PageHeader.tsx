export default function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="h-16 border-b border-zinc-200 dark:border-zinc-800 px-6 flex items-center justify-between shrink-0">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-xs text-zinc-500">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
