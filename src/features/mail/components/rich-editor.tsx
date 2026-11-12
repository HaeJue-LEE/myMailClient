"use client";

import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  EditorToolbar,
  type FormatState,
  STATE_COMMANDS,
} from "@/features/mail/components/editor-toolbar";
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

/** Inline styles for blocks, so mail programs show them as the editor does. */
const BLOCK_STYLES = {
  blockquote: "margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555",
  pre: "background:#f4f4f4;border:1px solid #ddd;border-radius:4px;padding:6px 8px;font-family:Consolas,'Courier New',monospace;white-space:pre-wrap",
} as const;

const EMPTY_FORMAT: FormatState = { on: new Set(), fontName: "", fontSize: "", block: "" };

const TOOL = "rounded px-2 py-1 text-sm hover:bg-foreground/10";

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
  /** The editor's last selection, for controls that take focus (selects, panels, the link field). */
  const savedRange = useRef<Range | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [format, setFormat] = useState<FormatState>(EMPTY_FORMAT);

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

  const refreshFormat = useCallback(() => {
    setFormat({
      on: new Set(STATE_COMMANDS.filter((command) => document.queryCommandState(command))),
      fontName: document
        .queryCommandValue("fontName")
        .split(",")[0]
        .replace(/["']/g, "")
        .trim()
        .toLowerCase(),
      fontSize: document.queryCommandValue("fontSize"),
      block: document.queryCommandValue("formatBlock").toLowerCase(),
    });
  }, []);

  // Remember where the selection is while it is inside the editor.
  useEffect(() => {
    const track = () => {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && editor.current?.contains(range.commonAncestorContainer)) {
        savedRange.current = range.cloneRange();
        refreshFormat();
      }
    };
    document.addEventListener("selectionchange", track);
    return () => document.removeEventListener("selectionchange", track);
  }, [refreshFormat]);

  /** Focuses the editor with its last selection back in place. */
  const restoreSelection = () => {
    const element = editor.current;
    if (!element) return;
    element.focus();
    const range = savedRange.current;
    const selection = window.getSelection();
    if (range && element.contains(range.commonAncestorContainer)) {
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  const exec = (command: string, value?: string, css = false) => {
    restoreSelection();
    // Fonts, sizes and colors as spans with inline styles, which mail
    // programs show; plain tags such as <b> for the rest.
    document.execCommand("styleWithCSS", false, String(css));
    document.execCommand(command, false, value);
    refreshFormat();
    onChange?.();
  };

  /** Inserts HTML the toolbar built itself (tables); never untrusted HTML. */
  const insertHtml = (html: string) => exec("insertHTML", html);

  const toggleBlock = (tag: "blockquote" | "pre") => {
    restoreSelection();
    if (document.queryCommandValue("formatBlock").toLowerCase() === tag) {
      document.execCommand("formatBlock", false, "div");
    } else {
      document.execCommand("formatBlock", false, tag);
      const node = window.getSelection()?.anchorNode;
      const block = (node instanceof Element ? node : node?.parentElement)?.closest(tag);
      if (block && editor.current?.contains(block)) block.setAttribute("style", BLOCK_STYLES[tag]);
    }
    refreshFormat();
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
    // The selection is already saved; the address field is about to take focus.
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
    restoreSelection();
    const selection = window.getSelection();
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

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      startLink();
    }
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
        <EditorToolbar state={format} actions={{ exec, toggleBlock, insertHtml, startLink }}>
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
        </EditorToolbar>
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
        onKeyDown={onKeyDown}
        // `contain: paint` keeps quoted content (even position:fixed) inside this box.
        className="min-h-72 flex-1 overflow-auto px-3 py-2 text-sm outline-none [contain:paint] isolate [&_a]:text-blue-600 [&_a]:underline [&_hr]:my-2 [&_hr]:border-foreground/30 [&_img]:max-w-full [&_td]:align-top [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
      />
    </div>
  );
}
