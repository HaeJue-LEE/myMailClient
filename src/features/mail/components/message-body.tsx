"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildEmailDocument } from "@/features/mail/sanitize";

const INITIAL_HEIGHT = 200;

/** The height of a mail document's content (not of the frame showing it). */
function contentHeight(doc: Document) {
  // scrollHeight never drops below the frame's own height, so a frame that
  // grew once could never shrink with it alone.
  const root = doc.documentElement.getBoundingClientRect().height;
  return Math.ceil(Math.max(root, doc.body?.scrollHeight ?? 0));
}

function HtmlBody({ html }: { html: string }) {
  const document = useMemo(() => buildEmailDocument(html), [html]);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const observer = useRef<ResizeObserver | null>(null);

  useEffect(() => () => observer.current?.disconnect(), []);

  return (
    <iframe
      title="메일 본문"
      srcDoc={document}
      // allow-same-origin lets the parent measure height. allow-scripts must stay
      // off: combined with allow-same-origin it would give the email full access.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ height }}
      className="w-full rounded bg-white"
      onLoad={(event) => {
        const frame = event.currentTarget;
        const doc = frame.contentDocument;
        if (!doc) return;
        const measure = () => setHeight(contentHeight(doc));
        measure();
        // Text rewraps when the window (so the frame) changes width, and images
        // load late: measure again whenever the content's size changes.
        observer.current?.disconnect();
        // The frame's own constructor, for elements of its document.
        const view = frame.contentWindow as (Window & typeof globalThis) | null;
        const watcher = new (view?.ResizeObserver ?? ResizeObserver)(measure);
        watcher.observe(doc.documentElement);
        if (doc.body) watcher.observe(doc.body);
        observer.current = watcher;
      }}
    />
  );
}

export function MessageBody({
  html,
  text,
}: {
  html: string | null;
  text: string | null;
}) {
  if (html !== null) return <HtmlBody html={html} />;
  return <pre className="font-sans text-sm whitespace-pre-wrap">{text}</pre>;
}
