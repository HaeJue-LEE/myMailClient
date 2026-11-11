"use client";

import {
  type ClipboardEvent,
  type DragEvent,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { escapeHtml } from "@/features/mail/reply";
import { sanitizeForEditor } from "@/features/mail/sanitize";

export type RichEditorHandle = {
  /** The current content as HTML. */
  html: () => string;
  /** The current content as plain text, for the text/plain alternative. */
  text: () => string;
  focus: () => void;
  element: () => HTMLDivElement | null;
};

/** Accepts http(s) and mailto only; bare addresses get a scheme. */
export function normalizeLink(input: string) {
  const value = input.trim();
  if (!value) return null;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // javascript:, file:, …
  return `https://${value}`;
}

type Command = {
  label: string;
  command: string;
  text: string;
  className?: string;
};

const COMMANDS: Command[] = [
  { label: "굵게 (Ctrl+B)", command: "bold", text: "B", className: "font-bold" },
  { label: "기울임 (Ctrl+I)", command: "italic", text: "I", className: "italic" },
  { label: "밑줄 (Ctrl+U)", command: "underline", text: "U", className: "underline" },
  { label: "취소선", command: "strikeThrough", text: "S", className: "line-through" },
  { label: "글머리 기호 목록", command: "insertUnorderedList", text: "• 목록" },
  { label: "번호 목록", command: "insertOrderedList", text: "1. 목록" },
];

const TOOL =
  "rounded px-2 py-1 text-sm hover:bg-foreground/10 aria-pressed:bg-foreground/15";

/**
 * A formatted-text editor for the mail body. `initialHtml` is placed as is,
 * so it must be built from sanitized parts only; anything pasted or dropped
 * later is sanitized here.
 */
export function RichEditor({
  ref,
  initialHtml,
  autoFocus,
  label,
  onChange,
}: {
  ref?: Ref<RichEditorHandle>;
  initialHtml: string;
  autoFocus?: boolean;
  label: string;
  onChange?: () => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());

  useImperativeHandle(
    ref,
    () => ({
      html: () => editor.current?.innerHTML ?? "",
      text: () => editor.current?.innerText ?? "",
      focus: () => editor.current?.focus(),
      element: () => editor.current,
    }),
    [],
  );

  // The content is set once; afterwards the DOM, not React, owns it.
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element) return;
    element.innerHTML = initialHtml;
    if (autoFocus) {
      element.focus();
      const range = document.createRange();
      range.setStart(element, 0);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshActive = () =>
    setActive(
      new Set(
        COMMANDS.filter(({ command }) => document.queryCommandState(command)).map(
          ({ command }) => command,
        ),
      ),
    );

  const run = (command: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(command, false, value);
    refreshActive();
    onChange?.();
  };

  const insertSanitized = (html: string, text: string) => {
    if (html) document.execCommand("insertHTML", false, sanitizeForEditor(html));
    else if (text) document.execCommand("insertText", false, text);
    onChange?.();
  };

  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    insertSanitized(
      event.clipboardData.getData("text/html"),
      event.clipboardData.getData("text/plain"),
    );
  };

  const onDrop = (event: DragEvent) => {
    // Files go to the form, which attaches them.
    if (event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    insertSanitized(
      event.dataTransfer.getData("text/html"),
      event.dataTransfer.getData("text/plain"),
    );
  };

  const startLink = () => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    savedRange.current =
      range && editor.current?.contains(range.commonAncestorContainer) ? range : null;
    setLinkUrl("");
    setLinkError(false);
    setLinking(true);
  };

  const applyLink = () => {
    const url = normalizeLink(linkUrl);
    if (!url) {
      setLinkError(true);
      return;
    }
    editor.current?.focus();
    const selection = window.getSelection();
    if (savedRange.current) {
      selection?.removeAllRanges();
      selection?.addRange(savedRange.current);
    }
    if (selection?.isCollapsed) {
      // No text selected: insert the address itself as the link text.
      document.execCommand(
        "insertHTML",
        false,
        `<a href="${escapeHtml(url)}">${escapeHtml(linkUrl.trim())}</a>`,
      );
    } else {
      document.execCommand("createLink", false, url);
    }
    setLinking(false);
    onChange?.();
  };

  return (
    <div className="flex flex-1 flex-col rounded-md border border-foreground/20 focus-within:border-foreground/60">
      <div
        role="toolbar"
        aria-label="서식"
        className="flex flex-wrap items-center gap-0.5 border-b border-foreground/10 px-1.5 py-1"
        // Keep the editor's selection while clicking toolbar buttons.
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) event.preventDefault();
        }}
      >
        {COMMANDS.map(({ label: name, command, text, className }) => (
          <button
            key={command}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={active.has(command)}
            onClick={() => run(command)}
            className={`${TOOL} ${className ?? ""}`}
          >
            {text}
          </button>
        ))}
        <span aria-hidden className="mx-1 h-5 w-px bg-foreground/10" />
        <button type="button" title="링크" onClick={startLink} className={TOOL}>
          링크
        </button>
        <button
          type="button"
          title="서식 지우기"
          onClick={() => {
            run("removeFormat");
            run("unlink");
          }}
          className={TOOL}
        >
          서식 지우기
        </button>
        {linking && (
          <span className="ml-2 flex items-center gap-1">
            <input
              autoFocus
              value={linkUrl}
              onChange={(event) => {
                setLinkUrl(event.target.value);
                setLinkError(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink();
                } else if (event.key === "Escape") {
                  setLinking(false);
                }
              }}
              placeholder="https://… 또는 메일 주소"
              aria-label="링크 주소"
              aria-invalid={linkError || undefined}
              className="h-7 w-56 rounded border border-foreground/20 bg-transparent px-2 text-sm outline-none aria-[invalid=true]:border-red-600"
            />
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={applyLink}
              className={TOOL}
            >
              넣기
            </button>
          </span>
        )}
      </div>
      <div
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label={label}
        onInput={onChange}
        onPaste={onPaste}
        onDrop={onDrop}
        onKeyUp={refreshActive}
        onMouseUp={refreshActive}
        // `contain: paint` keeps quoted content (even position:fixed) inside this box.
        className="min-h-72 flex-1 overflow-auto px-3 py-2 text-sm outline-none [contain:paint] isolate [&_a]:text-blue-600 [&_a]:underline [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
      />
    </div>
  );
}
