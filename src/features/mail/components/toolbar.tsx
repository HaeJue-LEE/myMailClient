"use client";

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/features/mail/components/icon";
import { SearchBar } from "@/features/mail/components/search-bar";

/**
 * Stays pinned to the top of the scrolling mail pane. The view's buttons go on
 * the left; mail search is always on the right.
 */
export function Toolbar({
  children,
  filters,
  onFilterChange,
}: {
  children: ReactNode;
  /** Extra controls placed just before the search field, e.g. a date limit. */
  filters?: ReactNode;
  /** Lists pass this to filter their loaded threads while the user types. */
  onFilterChange?: (filter: string) => void;
}) {
  return (
    <div
      role="toolbar"
      className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-foreground/10 bg-background px-3"
    >
      {/* Not shrinkable below its buttons, so the search field gives way first. */}
      {/* nowrap: Korean text may break per character, which would understate that minimum. */}
      <div className="flex flex-1 items-center gap-1 whitespace-nowrap">
        {children}
      </div>
      {filters}
      <SearchBar onFilterChange={onFilterChange} />
    </div>
  );
}

export function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  spinning,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Shows ongoing work, e.g. while a refresh is in flight. */
  spinning?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm hover:bg-foreground/5 disabled:pointer-events-none disabled:opacity-40 ${
        danger ? "text-red-600" : ""
      }`}
    >
      <Icon name={icon} className={spinning ? "animate-spin" : undefined} />
      {/* Narrow windows keep icons only; the title still names the action. */}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

export function ToolDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-foreground/10" />;
}
