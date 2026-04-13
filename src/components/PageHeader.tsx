"use client";

import { Menu } from "lucide-react";
import { useMobileNav } from "./MobileNavProvider";

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
  const { toggle } = useMobileNav();

  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800 px-4 md:px-6 py-2 md:py-0 md:h-16 flex items-center justify-between gap-3 shrink-0 flex-wrap">
      <div className="flex items-center gap-3 min-w-0">
        {/* Hamburger — only on mobile, opens the sidebar drawer. At md+
            the sidebar is always-visible chrome and this is hidden. */}
        <button
          type="button"
          onClick={toggle}
          aria-label="Open navigation menu"
          className="md:hidden h-9 w-9 inline-flex items-center justify-center rounded-md text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight truncate">
            {title}
          </h1>
          {description && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
              {description}
            </p>
          )}
        </div>
        {inline && (
          <div className="flex items-center gap-2 min-w-0">{inline}</div>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">{actions}</div>
      )}
    </header>
  );
}
