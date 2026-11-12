const ICON_PATHS = {
  back: "M15 18l-6-6 6-6",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  restore: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  markUnread: "M3 6h18v12H3zM3 6l9 7 9-7",
  markRead: "M3 10l9-6 9 6v10H3zM3 10l9 6 9-6",
  unreadDot: "M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
  search: "M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M16 16l5 5",
  close: "M6 6l12 12M18 6L6 18",
  calendar: "M4 5h16v15H4zM4 10h16M8 3v4M16 3v4",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  contacts: "M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.5a4 4 0 0 1 0 7.5M19 14a6 6 0 0 1 3 5v2",
  /** An envelope, distinct from `edit` where both appear on one row. */
  compose: "M3 6h18v12H3zM3 6l9 7 9-7",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  attach: "M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15.5 7",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  reply: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v5",
  replyAll: "M7 14L2 9l5-5M12 14L7 9l5-5M7 9h7a6 6 0 0 1 6 6v5",
  forward: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0-6 6v5",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  server: "M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01",
  grip: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  popOut:"M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  personAdd: "M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 4 1.5M19 14v6M16 17h6",
  // Compose editor toolbar.
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
  alignLeft: "M4 6h16M4 10h10M4 14h16M4 18h10",
  alignCenter: "M4 6h16M7 10h10M4 14h16M7 18h10",
  alignRight: "M4 6h16M10 10h10M4 14h16M10 18h10",
  alignJustify: "M4 6h16M4 10h16M4 14h16M4 18h16",
  listBullet: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  listNumber: "M10 6h10M10 12h10M10 18h10M4 4h1v4M4 8h2M4 14.5a1 1 0 1 1 2 0c0 .8-2 2-2 3.5h2",
  indent: "M4 6h16M11 10h9M11 14h9M4 18h16M4 9l3 3-3 3",
  outdent: "M4 6h16M11 10h9M11 14h9M4 18h16M7 9l-3 3 3 3",
  quote: "M5 17h3l2-4V7H4v6h3zM14 17h3l2-4V7h-6v6h3z",
  code: "M8 6l-6 6 6 6M16 6l6 6-6 6",
  horizontalRule: "M3 12h18M8 7h8M8 17h8",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  unlink: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7M3 3l18 18",
  table: "M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16",
  emoji: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01",
  highlight: "M9 11l-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4",
  eraser: "M7 21h12M4.5 15.5l9.9-9.9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8z",
  chevronDown: "M6 9l6 6 6-6",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`size-4 shrink-0 ${className ?? ""}`}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
