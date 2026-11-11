"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { draftListKey, draftRequests } from "@/features/mail/api";
import type { SendMessageInput } from "@/features/mail/bridge";

export type DraftState = "idle" | "saving" | "saved" | "error";

/** True when there is anything worth keeping as a draft. */
function hasContent(message: SendMessageInput) {
  return Boolean(
    message.to.length ||
      message.cc.length ||
      message.bcc.length ||
      message.subject.trim() ||
      message.text.trim() ||
      message.attachments?.length,
  );
}

/**
 * Keeps the message saved as a Gmail draft while it is being written.
 *
 * Saves run one at a time through a queue, so a late save can never overtake
 * a newer one, recreate a sent draft, or race a delete. `read` returns the
 * current message, or null if the form is gone.
 */
export function useDraftAutosave({
  initialDraftId,
  read,
  delayMs,
}: {
  initialDraftId?: string;
  read: () => SendMessageInput | null;
  delayMs: number;
}) {
  const queryClient = useQueryClient();
  const draftId = useRef(initialDraftId);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const dirty = useRef(false);
  /** Set once sending or discarding starts: no more saves. */
  const closed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The latest `read`, for saves scheduled from earlier renders.
  const readRef = useRef(read);
  useLayoutEffect(() => {
    readRef.current = read;
  });
  const [state, setState] = useState<DraftState>(initialDraftId ? "saved" : "idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const saveNow = useCallback(() => {
    clearTimeout(timer.current);
    dirty.current = false;
    // Read now, while the form is certainly there.
    const message = readRef.current();
    queue.current = queue.current.then(async () => {
      if (closed.current || !message) return;
      if (!draftId.current && !hasContent(message)) return;
      setState("saving");
      try {
        const saved = await draftRequests.save({ ...message, draftId: draftId.current });
        draftId.current = saved.draftId;
        setState("saved");
        setSavedAt(Date.now());
        void queryClient.invalidateQueries({ queryKey: draftListKey });
      } catch {
        dirty.current = true;
        setState("error");
      }
    });
    return queue.current;
  }, [queryClient]);

  /** Call after any change; saves once typing pauses unless `autosave` is off. */
  const markDirty = useCallback(
    (autosave = true) => {
      if (closed.current) return;
      dirty.current = true;
      clearTimeout(timer.current);
      if (autosave) timer.current = setTimeout(() => void saveNow(), delayMs);
    },
    [delayMs, saveNow],
  );

  /** Stops saving and waits for any save in flight; returns the draft to send as. */
  const beginSend = useCallback(async () => {
    clearTimeout(timer.current);
    closed.current = true;
    await queue.current;
    return draftId.current;
  }, []);

  /** After a failed send: allow saving again. */
  const resume = useCallback(() => {
    closed.current = false;
  }, []);

  /** Deletes the saved draft (if any) after any save in flight. */
  const discard = useCallback(async () => {
    clearTimeout(timer.current);
    closed.current = true;
    await queue.current;
    if (draftId.current) {
      await draftRequests.delete(draftId.current);
      draftId.current = undefined;
      void queryClient.invalidateQueries({ queryKey: draftListKey });
    }
  }, [queryClient]);

  // Leaving with unsaved changes saves them. A layout-effect cleanup still
  // sees the form, which a passive-effect cleanup would not.
  useLayoutEffect(
    () => () => {
      clearTimeout(timer.current);
      if (dirty.current && !closed.current) void saveNow();
    },
    [saveNow],
  );

  /** Saves any unsaved change now and waits for every save in flight. */
  const flush = useCallback(
    () => (dirty.current && !closed.current ? saveNow() : queue.current),
    [saveNow],
  );

  /**
   * Saves what is unsaved, then stops saving here: the draft is handed to
   * another window. Returns its id, or undefined when there was nothing to
   * keep. Throws, and keeps saving here, when the save fails.
   */
  const handOff = useCallback(async () => {
    await flush();
    // A failed save leaves the change marked unsaved.
    if (dirty.current) throw new Error("The draft could not be saved");
    clearTimeout(timer.current);
    closed.current = true;
    await queue.current;
    return draftId.current;
  }, [flush]);

  return {
    state,
    savedAt,
    hasDraft: () => Boolean(draftId.current),
    markDirty,
    saveNow,
    flush,
    handOff,
    beginSend,
    resume,
    discard,
  };
}
