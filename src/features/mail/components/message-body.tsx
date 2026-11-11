"use client";

import { useMemo, useState } from "react";
import { buildEmailDocument } from "@/features/mail/sanitize";

const INITIAL_HEIGHT = 200;

function HtmlBody({ html }: { html: string }) {
  const document = useMemo(() => buildEmailDocument(html), [html]);
  const [height, setHeight] = useState(INITIAL_HEIGHT);

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
        const body = event.currentTarget.contentDocument?.documentElement;
        if (body) setHeight(body.scrollHeight);
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
