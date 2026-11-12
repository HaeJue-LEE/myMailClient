"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { parseAddresses } from "@/features/mail/addresses";
import {
  draftListKey,
  openComposeWindow,
  useContacts,
  useSendAs,
  useSendMessage,
} from "@/features/mail/api";
import {
  type ComposeAttachment,
  MAX_ATTACHMENT_BYTES,
  type SendMessageInput,
} from "@/features/mail/bridge";
import {
  AttachmentPicker,
  readFiles,
  totalAttachmentSize,
} from "@/features/mail/components/attachment-picker";
import { Icon } from "@/features/mail/components/icon";
import { useBeforeWindowClose, usePopupWindow } from "@/features/mail/components/popup-window";
import { RecipientInput } from "@/features/mail/components/recipient-input";
import {
  type DraftState,
  useDraftAutosave,
} from "@/features/mail/components/use-draft-autosave";
import {
  RichEditor,
  type RichEditorHandle,
} from "@/features/mail/components/rich-editor";
import { QUOTE_MARK } from "@/features/mail/reply";
import { draftHref, labelHref } from "@/features/mail/routes";
import { sanitizeForEditor } from "@/features/mail/sanitize";
import { mailServerErrorText } from "@/features/mail/server-errors";
import { signatureBlock, swapSignature } from "@/features/mail/signature";
import type { Contact, SendAsAddress } from "@/features/mail/types";

const MAX_SUBJECT_LENGTH = 998;
const INPUT_CLASS =
  "w-full rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/60 aria-[invalid=true]:border-red-600";

type AddressField = "to" | "cc" | "bcc";
type FieldErrors = Partial<Record<AddressField, string>>;

/** Everything a compose session starts from: new mail, a reply, a forward. */
export type ComposeStart = {
  title: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** A send-as address to start on; Gmail's default when absent. */
  from?: string;
  /** Initial editor content, built from sanitized parts only. */
  bodyHtml: string;
  attachments: ComposeAttachment[];
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  /** Set when continuing a saved draft. */
  draftId?: string;
  /** Whether changing the sender replaces the signature (default true). */
  swapSignature?: boolean;
  /** Where the cursor starts. */
  focus: "to" | "subject" | "body";
};

/** Saves this long after the last change. */
const AUTOSAVE_DELAY_MS = 3000;
/**
 * Every save uploads the whole message, attachments included, so autosave
 * stops above this size; the "임시저장" button still works.
 */
export const AUTOSAVE_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const NEW_MESSAGE: ComposeStart = {
  title: "메일 쓰기",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  bodyHtml: "",
  attachments: [],
  focus: "to",
};

function invalidMessage(invalid: string[]) {
  return invalid.length > 0
    ? `올바르지 않은 주소입니다: ${invalid.join(", ")}`
    : undefined;
}

function RecipientField({
  name,
  label,
  contacts,
  error,
  defaultValue,
  autoFocus,
}: {
  name: AddressField;
  label: string;
  contacts: readonly Contact[];
  error?: string;
  defaultValue?: string;
  autoFocus?: boolean;
}) {
  const errorId = `${name}-error`;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <RecipientInput
        id={name}
        name={name}
        contacts={contacts}
        defaultValue={defaultValue}
        autoFocus={autoFocus}
        invalid={Boolean(error)}
        describedBy={error ? errorId : undefined}
        className={INPUT_CLASS}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

const senderLabel = (sender: SendAsAddress) =>
  sender.name ? `${sender.name} <${sender.email}>` : sender.email;

/** The send-as address to start on: the requested one if usable, else Gmail's default. */
export function initialSender(
  senders: readonly SendAsAddress[],
  requested?: string,
) {
  return (
    senders.find((sender) => sender.email === requested?.toLowerCase()) ??
    senders.find((sender) => sender.isDefault) ??
    senders[0]
  );
}

/**
 * Picks the From address among the account's verified Gmail addresses.
 * Renders nothing until the list has loaded, in which case the message goes
 * out from Gmail's default anyway.
 */
function SenderField({
  requested,
  onChange,
}: {
  requested?: string;
  onChange?: (email: string) => void;
}) {
  const { data: senders } = useSendAs();
  if (!senders || senders.length === 0) return null;
  const start = initialSender(senders, requested);

  if (senders.length === 1) {
    return (
      <p className="text-sm">
        <span className="font-medium">보내는 사람</span>{" "}
        <span className="opacity-80">{senderLabel(start)}</span>
        <input type="hidden" name="from" value={start.email} />
      </p>
    );
  }

  return (
    <div>
      <label htmlFor="from" className="mb-1 block text-sm font-medium">
        보내는 사람
      </label>
      <select
        id="from"
        name="from"
        defaultValue={start.email}
        onChange={(event) => onChange?.(event.target.value)}
        className={INPUT_CLASS}
      >
        {senders.map((sender) => (
          <option key={sender.email} value={sender.email}>
            {senderLabel(sender)}
            {sender.isDefault ? " (기본)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The editor's content as a message body: HTML in a `dir` wrapper, plus plain text. */
export function bodyFromEditor(editor: RichEditorHandle | null) {
  const source = editor?.element();
  let raw = editor?.html() ?? "";
  if (source?.querySelector('[data-mc="quote"]')) {
    const copy = source.cloneNode(true) as HTMLElement;
    copy.querySelector('[data-mc="quote"]')?.setAttribute(QUOTE_MARK, "");
    raw = copy.innerHTML;
  }
  const html = sanitizeForEditor(raw);
  return { html: `<div dir="ltr">${html}</div>`, text: editor?.text() ?? "" };
}

const savedTime = new Intl.DateTimeFormat("ko-KR", { timeStyle: "short" });

export function ComposeForm({ start }: { start: ComposeStart }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Contacts the user hid are left out of the suggestions too.
  const { visibleContacts: contacts } = useContacts();
  const senders = useSendAs();
  const { mutate: send, isPending, isSuccess, isError, error: sendError } = useSendMessage();
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<RichEditorHandle>(null);
  const [showCopies, setShowCopies] = useState(Boolean(start.cc || start.bcc));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(
    start.attachments,
  );
  const attachmentsRef = useRef(attachments);
  const [dragging, setDragging] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [moveFailed, setMoveFailed] = useState(false);
  const popup = usePopupWindow();
  const isSubmitting = isPending || isSuccess;
  const attachmentTotal = totalAttachmentSize(attachments);
  const tooLarge = attachmentTotal > MAX_ATTACHMENT_BYTES;
  const autosaveOff = attachmentTotal > AUTOSAVE_MAX_ATTACHMENT_BYTES;

  /** The message as it stands; invalid addresses are left out of drafts. */
  const readMessage = (): SendMessageInput | null => {
    if (!form.current) return null;
    const data = new FormData(form.current);
    const value = (name: string) => String(data.get(name) ?? "");
    return {
      to: parseAddresses(value("to")).valid,
      cc: parseAddresses(value("cc")).valid,
      bcc: parseAddresses(value("bcc")).valid,
      subject: value("subject"),
      ...bodyFromEditor(editor.current),
      // Absent while the sender list loads: Gmail's default is used.
      from: value("from") || undefined,
      attachments: attachmentsRef.current,
      threadId: start.threadId,
      inReplyTo: start.inReplyTo,
      references: start.references,
    };
  };
  const draft = useDraftAutosave({
    initialDraftId: start.draftId,
    read: readMessage,
    delayMs: AUTOSAVE_DELAY_MS,
  });
  const changed = () => draft.markDirty(!autosaveOff);

  const updateAttachments = (next: (current: ComposeAttachment[]) => ComposeAttachment[]) => {
    const value = next(attachmentsRef.current);
    attachmentsRef.current = value;
    setAttachments(value);
    draft.markDirty(totalAttachmentSize(value) <= AUTOSAVE_MAX_ATTACHMENT_BYTES);
  };
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const added = await readFiles(files);
    updateAttachments((current) => [...current, ...added]);
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tooLarge || isSubmitting) return;
    const data = new FormData(event.currentTarget);
    const value = (name: string) => String(data.get(name) ?? "");

    const to = parseAddresses(value("to"));
    const cc = parseAddresses(value("cc"));
    const bcc = parseAddresses(value("bcc"));
    const isToEmpty = to.valid.length === 0 && to.invalid.length === 0;

    const nextErrors: FieldErrors = {
      to: isToEmpty ? "받는사람을 입력해 주세요." : invalidMessage(to.invalid),
      cc: invalidMessage(cc.invalid),
      bcc: invalidMessage(bcc.invalid),
    };
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    const message = readMessage();
    if (!message) return;
    // No save may land after this point; a saved draft is sent as itself.
    const draftId = await draft.beginSend();
    send(
      { ...message, draftId },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: draftListKey });
          if (popup) window.close();
          else router.push(labelHref("SENT"));
        },
        onError: () => draft.resume(),
      },
    );
  }

  const discard = async () => {
    await draft.discard();
    if (popup) window.close();
    else router.push(labelHref("INBOX"));
  };

  // However a pop-up is closed, what was typed last is saved first.
  const { flush } = draft;
  useBeforeWindowClose(flush, popup);

  useEffect(() => {
    if (popup) document.title = `${start.title} - Mail Client`;
  }, [popup, start.title]);

  /** Saves the message as a draft and goes on writing it in a window of its own. */
  const moveToWindow = async () => {
    setMoveFailed(false);
    try {
      // Throws, keeping everything here, when the draft cannot be saved.
      const draftId = await draft.handOff();
      try {
        // Nothing written yet: start the same kind of message there instead.
        await openComposeWindow(
          draftId ? draftHref(draftId) : `${window.location.pathname}${window.location.search}`,
        );
      } catch (error) {
        draft.resume();
        throw error;
      }
    } catch {
      setMoveFailed(true);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: draftListKey });
    router.push("/mail");
  };

  return (
    <form
      ref={form}
      onSubmit={(event) => void handleSubmit(event)}
      // Typing in any field (the editor included) marks the draft as changed.
      onInput={changed}
      onChange={changed}
      noValidate
      // Files dropped anywhere on the form are attached.
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void addFiles([...event.dataTransfer.files]);
      }}
      // As wide as the window: wide mail (tables, quoted newsletters) needs the room.
      className={`flex min-h-full w-full flex-col gap-4 p-6 ${
        dragging ? "rounded-lg outline-2 outline-dashed outline-foreground/40" : ""
      }`}
    >
      <h1 className="text-xl font-semibold">{start.title}</h1>

      <SenderField
        requested={start.from}
        // A different sender brings its own signature.
        onChange={(email) => {
          if (start.swapSignature === false) return;
          const root = editor.current?.element();
          const sender = senders.data?.find((item) => item.email === email);
          if (root) swapSignature(root, signatureBlock(sender?.signature ?? "", sanitizeForEditor));
        }}
      />

      <RecipientField
        name="to"
        label="받는사람"
        contacts={contacts}
        error={errors.to}
        defaultValue={start.to}
        autoFocus={start.focus === "to"}
      />

      {showCopies ? (
        <>
          <RecipientField
            name="cc"
            label="참조"
            contacts={contacts}
            error={errors.cc}
            defaultValue={start.cc}
          />
          <RecipientField
            name="bcc"
            label="숨은참조"
            contacts={contacts}
            error={errors.bcc}
            defaultValue={start.bcc}
          />
        </>
      ) : (
        <button
          type="button"
          onClick={() => setShowCopies(true)}
          className="self-start text-sm underline opacity-70"
        >
          참조/숨은참조 추가
        </button>
      )}

      <div>
        <label htmlFor="subject" className="mb-1 block text-sm font-medium">
          제목
        </label>
        <input
          id="subject"
          name="subject"
          type="text"
          defaultValue={start.subject}
          maxLength={MAX_SUBJECT_LENGTH}
          autoFocus={start.focus === "subject"}
          onKeyDown={(event) => {
            // Tab goes on to the body, past the formatting toolbar (which
            // Shift+Tab from the body still reaches).
            if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
              return;
            }
            event.preventDefault();
            editor.current?.focus();
          }}
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex flex-1 flex-col">
        <span className="mb-1 block text-sm font-medium">내용</span>
        <RichEditor
          ref={editor}
          label="내용"
          initialHtml={start.bodyHtml}
          autoFocus={start.focus === "body"}
          // Formatting commands change the content without an input event.
          onChange={changed}
        />
      </div>

      <AttachmentPicker
        attachments={attachments}
        onAdd={(files) => void addFiles(files)}
        onRemove={(index) =>
          updateAttachments((current) => current.filter((_, i) => i !== index))
        }
      />

      {isError && (
        <p role="alert" className="text-sm text-red-600">
          {mailServerErrorText(sendError) ?? "메일을 보내지 못했습니다."} 작성한 내용은
          그대로 있으니 잠시 후 다시 시도해 주세요.
        </p>
      )}
      {moveFailed && (
        <p role="alert" className="text-sm text-red-600">
          새 창으로 옮기지 못했습니다. 작성한 내용은 그대로 있으니 여기서 계속 쓰거나
          다시 시도해 주세요.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isSubmitting || tooLarge}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {isSubmitting ? "보내는 중…" : "보내기"}
        </button>
        <button
          type="button"
          disabled={isSubmitting || tooLarge || draft.state === "saving"}
          onClick={() => void draft.saveNow()}
          className="rounded-md border border-foreground/20 px-3 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
        >
          임시저장
        </button>
        {popup ? (
          <button
            type="button"
            // The window saves what is unsaved before it closes.
            onClick={() => window.close()}
            title="닫아도 작성한 내용은 임시보관함에 남습니다"
            className="text-sm underline opacity-70"
          >
            닫기
          </button>
        ) : (
          <>
            <Link
              href="/mail"
              title="닫아도 임시저장된 내용은 임시보관함에 남습니다"
              className="text-sm underline opacity-70"
            >
              닫기
            </Link>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => void moveToWindow()}
              title="임시저장한 뒤 새 창에서 이어서 씁니다"
              className="flex items-center gap-1 text-sm opacity-70 hover:opacity-100 disabled:opacity-40"
            >
              <Icon name="popOut" />
              새 창으로
            </button>
          </>
        )}
        <DraftStatus
          state={draft.state}
          savedAt={draft.savedAt}
          autosaveOff={autosaveOff}
        />
        <div className="ml-auto flex items-center gap-2">
          {confirmDiscard ? (
            <>
              <span className="text-sm">
                {draft.hasDraft()
                  ? "임시저장된 메일을 삭제할까요? 되돌릴 수 없습니다."
                  : "작성한 내용을 버릴까요?"}
              </span>
              <button
                type="button"
                onClick={() => void discard()}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white"
              >
                삭제
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmDiscard(false)}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
              >
                취소
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => setConfirmDiscard(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Icon name="trash" />
              삭제
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function DraftStatus({
  state,
  savedAt,
  autosaveOff,
}: {
  state: DraftState;
  savedAt: number | null;
  autosaveOff: boolean;
}) {
  const text =
    state === "saving"
      ? "임시저장 중…"
      : state === "error"
        ? "임시저장하지 못했습니다"
        : state === "saved"
          ? `임시저장됨${savedAt ? ` · ${savedTime.format(savedAt)}` : ""}`
          : "";
  return (
    <span
      role="status"
      className={`text-xs ${state === "error" ? "text-red-600" : "opacity-60"}`}
    >
      {text}
      {autosaveOff && " (첨부파일이 커서 자동 저장하지 않습니다. 임시저장 버튼을 눌러 주세요)"}
    </span>
  );
}
