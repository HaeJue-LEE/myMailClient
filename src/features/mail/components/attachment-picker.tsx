"use client";

import { useId, useRef } from "react";
import {
  type ComposeAttachment,
  type FileAttachment,
  MAX_ATTACHMENT_BYTES,
} from "@/features/mail/bridge";
import { Icon } from "@/features/mail/components/icon";

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function attachmentSize(attachment: ComposeAttachment) {
  return attachment.kind === "file" ? attachment.data.byteLength : attachment.size;
}

export function totalAttachmentSize(attachments: readonly ComposeAttachment[]) {
  return attachments.reduce((sum, item) => sum + attachmentSize(item), 0);
}

/** Reads picked or dropped files into attachments the main process can send. */
export async function readFiles(files: Iterable<File>): Promise<FileAttachment[]> {
  return Promise.all(
    [...files].map(async (file) => ({
      kind: "file" as const,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      data: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

/**
 * The attachment list with an "attach files" button. Files can also be
 * dropped anywhere on the compose form (handled by the form).
 */
export function AttachmentPicker({
  attachments,
  onAdd,
  onRemove,
}: {
  attachments: readonly ComposeAttachment[];
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const total = totalAttachmentSize(attachments);
  const over = total > MAX_ATTACHMENT_BYTES;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex items-center gap-1.5 rounded-md border border-foreground/20 px-3 py-1.5 text-sm hover:bg-foreground/5"
        >
          <Icon name="attach" />
          파일 첨부
        </button>
        <input
          id={inputId}
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            onAdd([...(event.target.files ?? [])]);
            // The same file can be picked again after removing it.
            event.target.value = "";
          }}
        />
        <span className={`text-xs ${over ? "text-red-600" : "opacity-60"}`}>
          {attachments.length > 0
            ? `${attachments.length}개 · ${formatBytes(total)} / 최대 ${formatBytes(MAX_ATTACHMENT_BYTES)}`
            : "파일을 여기로 끌어다 놓아도 됩니다"}
        </span>
      </div>
      {over && (
        <p role="alert" className="text-sm text-red-600">
          첨부파일이 너무 큽니다. 합계 {formatBytes(MAX_ATTACHMENT_BYTES)} 이하로
          줄여 주세요.
        </p>
      )}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="첨부파일">
          {attachments.map((attachment, index) => (
            <li
              key={`${attachment.filename}-${index}`}
              className="flex max-w-xs items-center gap-2 rounded-md bg-foreground/5 py-1 pl-2.5 pr-1 text-sm"
            >
              <Icon name="attach" className="opacity-60" />
              <span className="truncate" title={attachment.filename}>
                {attachment.filename}
              </span>
              <span className="shrink-0 text-xs opacity-60">
                {formatBytes(attachmentSize(attachment))}
              </span>
              <button
                type="button"
                onClick={() => onRemove(index)}
                title={`${attachment.filename} 빼기`}
                aria-label={`${attachment.filename} 빼기`}
                className="rounded p-0.5 opacity-60 hover:bg-foreground/10 hover:opacity-100"
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
