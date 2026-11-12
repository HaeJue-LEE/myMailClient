"use client";

import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  fromDatetimeLocal,
  hoursFrom,
  hoursFromNow,
  isSchedulable,
  MAX_SCHEDULE_AHEAD_MS,
  MAX_SCHEDULE_HOURS,
  parseHours,
  MIN_SCHEDULE_LEAD_MS,
  schedulePresets,
  scheduleTimeFormat,
  toDatetimeLocal,
} from "@/features/mail/scheduled";

/** Shown wherever a time is picked: the app has to be running to send. */
export const SCHEDULE_NOTE =
  "예약한 시간에 Mail Client가 실행 중이어야 보냅니다. 꺼져 있었다면 다음에 실행할 때 바로 보냅니다.";

/**
 * A button that opens a menu of times to send at: quick choices and a date
 * and time of the user's own. `onPick` gets epoch milliseconds.
 */
export function SchedulePicker({
  onPick,
  disabled,
  className,
  children,
  align = "left",
}: {
  onPick: (sendAt: number) => void;
  disabled?: boolean;
  className: string;
  children: ReactNode;
  /** Which edge of the button the menu lines up with. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [problem, setProblem] = useState(false);
  /** The number in "N시간 후", as typed. */
  const [hours, setHours] = useState("1");
  const hoursValue = parseHours(hours);
  const root = useRef<HTMLDivElement>(null);
  // Fixed while the menu is open, so its choices do not shift under the pointer.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const current = new Date();
      setNow(current);
      // Starts an hour ahead, on the hour.
      const suggestion = new Date(current.getTime() + 60 * 60 * 1000);
      suggestion.setMinutes(0, 0, 0);
      setCustom(toDatetimeLocal(suggestion));
      setProblem(false);
      setHours("1");
    }
    setOpen((value) => !value);
  };

  /**
   * Enter picks, rather than submitting the compose form around the menu
   * (which would send the mail at once). True when it was Enter.
   */
  const isEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return false;
    event.preventDefault();
    return true;
  };

  const pickHours = () => {
    if (hoursValue !== null) pick(hoursFromNow(hoursValue));
  };

  const pick = (sendAt: number) => {
    if (!isSchedulable(sendAt)) {
      setProblem(true);
      return;
    }
    setOpen(false);
    onPick(sendAt);
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
        className={className}
      >
        {children}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="보낼 시간"
          className={`absolute bottom-full z-30 mb-2 w-72 space-y-2 rounded-lg border border-foreground/15 bg-background p-3 text-sm shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
          // Typing here is not writing the mail: keep it from the compose form's autosave.
          onInput={(event) => event.stopPropagation()}
          onChange={(event) => event.stopPropagation()}
        >
          <p className="text-xs font-semibold opacity-70">보낼 시간</p>
          <div className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-foreground/5">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_SCHEDULE_HOURS}
              step={1}
              value={hours}
              onChange={(event) => {
                setHours(event.target.value);
                setProblem(false);
              }}
              onKeyDown={(event) => {
                if (isEnter(event)) pickHours();
              }}
              aria-label="몇 시간 후에 보낼지"
              aria-invalid={hoursValue === null || undefined}
              className="w-14 rounded border border-foreground/20 bg-transparent px-1.5 py-0.5 text-right text-sm tabular-nums outline-none aria-[invalid=true]:border-red-600"
            />
            <span>시간 후</span>
            <span className="ml-auto text-xs opacity-60">
              {hoursValue === null ? "1 이상의 정수" : scheduleTimeFormat.format(hoursFrom(now.getTime(), hoursValue))}
            </span>
            <button
              type="button"
              disabled={hoursValue === null}
              onClick={pickHours}
              className="shrink-0 rounded bg-foreground px-2 py-0.5 text-xs font-medium text-background disabled:opacity-40"
            >
              선택
            </button>
          </div>
          <ul className="space-y-0.5">
            {schedulePresets(now).map((preset) => (
              <li key={preset.label}>
                <button
                  type="button"
                  onClick={() => pick(preset.at.getTime())}
                  className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-foreground/10"
                >
                  <span>{preset.label}</span>
                  <span className="text-xs opacity-60">{scheduleTimeFormat.format(preset.at)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="space-y-1.5 border-t border-foreground/10 pt-2">
            <label className="block text-xs opacity-70" htmlFor="schedule-custom">
              날짜와 시간 직접 고르기
            </label>
            <div className="flex gap-1.5">
              <input
                id="schedule-custom"
                type="datetime-local"
                value={custom}
                min={toDatetimeLocal(new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS))}
                max={toDatetimeLocal(new Date(now.getTime() + MAX_SCHEDULE_AHEAD_MS))}
                onChange={(event) => {
                  setCustom(event.target.value);
                  setProblem(false);
                }}
                onKeyDown={(event) => {
                  if (isEnter(event)) pick(fromDatetimeLocal(custom));
                }}
                aria-invalid={problem || undefined}
                className="min-w-0 flex-1 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm outline-none aria-[invalid=true]:border-red-600"
              />
              <button
                type="button"
                onClick={() => pick(fromDatetimeLocal(custom))}
                className="shrink-0 rounded bg-foreground px-2.5 py-1 text-sm font-medium text-background"
              >
                예약
              </button>
            </div>
            {problem && (
              <p role="alert" className="text-xs text-red-600">
                지금부터 1분 뒤 ~ 1년 안의 시간을 골라 주세요.
              </p>
            )}
          </div>
          <p className="text-xs opacity-60">{SCHEDULE_NOTE}</p>
        </div>
      )}
    </div>
  );
}
