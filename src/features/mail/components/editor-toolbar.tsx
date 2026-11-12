"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/features/mail/components/icon";

/** What the toolbar shows as current at the editor's selection. */
export type FormatState = {
  /** Commands whose state is on, e.g. `bold`, `justifyCenter`. */
  on: ReadonlySet<string>;
  /** First family of the font, lower-cased without quotes; "" when unknown. */
  fontName: string;
  /** `fontSize` value "1"–"7"; "" when mixed or unknown. */
  fontSize: string;
  /** Block the selection is in, e.g. `blockquote`, `pre`. */
  block: string;
};

export const STATE_COMMANDS = [
  "bold",
  "italic",
  "underline",
  "strikeThrough",
  "superscript",
  "subscript",
  "insertUnorderedList",
  "insertOrderedList",
  "justifyLeft",
  "justifyCenter",
  "justifyRight",
  "justifyFull",
] as const;

export type EditorActions = {
  /** Runs a document command on the editor's selection. `css` styles with spans. */
  exec: (command: string, value?: string, css?: boolean) => void;
  /** Wraps the selection's block in `tag` (or unwraps it when already in one). */
  toggleBlock: (tag: "blockquote" | "pre") => void;
  /** Inserts trusted HTML built by the toolbar at the selection. */
  insertHtml: (html: string) => void;
  startLink: () => void;
};

/** Font families offered; the value is the CSS font-family written into the mail. */
const FONTS: [value: string, label: string][] = [
  ["'Malgun Gothic', sans-serif", "맑은 고딕"],
  ["Gulim, sans-serif", "굴림"],
  ["Dotum, sans-serif", "돋움"],
  ["Batang, serif", "바탕"],
  ["Gungsuh, serif", "궁서"],
  ["Arial, sans-serif", "Arial"],
  ["Verdana, sans-serif", "Verdana"],
  ["Tahoma, sans-serif", "Tahoma"],
  ["Georgia, serif", "Georgia"],
  ["'Times New Roman', serif", "Times New Roman"],
  ["'Courier New', monospace", "Courier New"],
];

const firstFamily = (family: string) =>
  family.split(",")[0].replace(/["']/g, "").trim().toLowerCase();

/** `fontSize` steps and the point sizes browsers give them. */
const SIZES: [value: string, label: string][] = [
  ["1", "8"],
  ["2", "10"],
  ["3", "12"],
  ["4", "14"],
  ["5", "18"],
  ["6", "24"],
  ["7", "36"],
];

const TEXT_COLORS = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#ffffff",
  "#c0392b", "#e74c3c", "#e67e22", "#f1c40f", "#27ae60", "#16a085",
  "#2980b9", "#3498db", "#8e44ad", "#9b59b6", "#2c3e50", "#7f8c8d",
];

const HIGHLIGHT_COLORS = [
  "#ffff00", "#fff2cc", "#fce5cd", "#f4cccc", "#d9ead3", "#d0e0e3",
  "#cfe2f3", "#d9d2e9", "#ead1dc", "#ffd966", "#93c47d", "#6fa8dc",
];

const EMOJIS = [
  "😀", "😃", "😄", "😁", "😊", "🙂", "😉", "😍", "🤔", "😅", "😂", "😢",
  "😭", "😮", "😎", "🙏", "👍", "👎", "👏", "🙌", "💪", "👋", "🤝", "✌️",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "⭐", "🔥", "🎉", "🎁", "✅", "❌",
  "⚠️", "❗", "❓", "💡", "📌", "📎", "📅", "⏰", "📞", "✉️", "📝", "🚀",
];

const TABLE_MAX = { rows: 8, columns: 8 };

/** A table for the mail body, styled inline so mail programs show its borders. */
export function tableHtml(rows: number, columns: number) {
  const cell = '<td style="border:1px solid #bbb;padding:4px 8px;min-width:40px">&nbsp;</td>';
  const row = `<tr>${cell.repeat(columns)}</tr>`;
  return (
    `<table style="border-collapse:collapse;margin:4px 0"><tbody>${row.repeat(rows)}</tbody></table>` +
    "<div><br></div>"
  );
}

const TOOL =
  "flex h-7 min-w-7 items-center justify-center gap-0.5 rounded px-1.5 text-sm hover:bg-foreground/10 aria-pressed:bg-foreground/15 aria-expanded:bg-foreground/10";
const SELECT =
  "h-7 rounded border border-foreground/15 bg-transparent px-1 text-sm outline-none hover:bg-foreground/5";

function Tool({
  label,
  icon,
  pressed,
  onClick,
  children,
  className,
}: {
  label: string;
  icon?: IconName;
  pressed?: boolean;
  onClick: () => void;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`${TOOL} ${className ?? ""}`}
    >
      {icon ? <Icon name={icon} /> : children}
    </button>
  );
}

const Divider = () => <span aria-hidden className="mx-0.5 h-5 w-px bg-foreground/10" />;

/** A toolbar button opening a small panel; closes on choosing, Escape, or a click elsewhere. */
function Menu({
  label,
  button,
  children,
}: {
  label: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
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
  return (
    <span ref={root} className="relative">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={TOOL}
      >
        {button}
        <Icon name="chevronDown" className="size-3 opacity-60" />
      </button>
      {open && (
        <div
          role="group"
          aria-label={label}
          className="absolute left-0 top-full z-20 mt-1 rounded-md border border-foreground/15 bg-background p-2 shadow-lg"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}

function Swatches({
  colors,
  onPick,
  none,
}: {
  colors: string[];
  onPick: (color: string) => void;
  none?: { label: string; onPick: () => void };
}) {
  return (
    <div className="w-44 space-y-2">
      <div className="grid grid-cols-6 gap-1">
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={color}
            onClick={() => onPick(color)}
            style={{ backgroundColor: color }}
            className="size-6 rounded border border-foreground/20 hover:scale-110"
          />
        ))}
      </div>
      {none && (
        <button
          type="button"
          onClick={none.onPick}
          className="w-full rounded px-2 py-1 text-left text-xs hover:bg-foreground/10"
        >
          {none.label}
        </button>
      )}
    </div>
  );
}

function TablePicker({ onPick }: { onPick: (rows: number, columns: number) => void }) {
  const [size, setSize] = useState({ rows: 0, columns: 0 });
  return (
    <div className="space-y-1">
      <div
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${TABLE_MAX.columns}, 1rem)` }}
        onMouseLeave={() => setSize({ rows: 0, columns: 0 })}
      >
        {Array.from({ length: TABLE_MAX.rows * TABLE_MAX.columns }, (_, index) => {
          const row = Math.floor(index / TABLE_MAX.columns) + 1;
          const column = (index % TABLE_MAX.columns) + 1;
          const lit = row <= size.rows && column <= size.columns;
          return (
            <button
              key={index}
              type="button"
              aria-label={`${row}행 ${column}열 표`}
              onMouseEnter={() => setSize({ rows: row, columns: column })}
              onFocus={() => setSize({ rows: row, columns: column })}
              onClick={() => onPick(row, column)}
              className={`size-4 rounded-sm border ${
                lit ? "border-blue-500 bg-blue-500/30" : "border-foreground/20"
              }`}
            />
          );
        })}
      </div>
      <p className="text-center text-xs opacity-70">
        {size.rows ? `${size.rows} × ${size.columns}` : "표 크기를 고르세요"}
      </p>
    </div>
  );
}

/**
 * The compose editor's formatting toolbar, laid out like Zoho Mail's: history,
 * font, text style, colors, paragraph, and insert groups. Buttons keep the
 * editor's selection (the parent stops their mousedown); the selects and
 * panels act on the selection the editor last had.
 */
export function EditorToolbar({
  state,
  actions,
  children,
}: {
  state: FormatState;
  actions: EditorActions;
  /** Shown at the end, e.g. the link address field. */
  children?: ReactNode;
}) {
  const { exec, toggleBlock, insertHtml, startLink } = actions;
  const on = (command: string) => state.on.has(command);
  const font = FONTS.find(([value]) => firstFamily(value) === state.fontName)?.[0] ?? "";

  return (
    <>
      <Tool label="실행 취소 (Ctrl+Z)" icon="undo" onClick={() => exec("undo")} />
      <Tool label="다시 실행 (Ctrl+Y)" icon="redo" onClick={() => exec("redo")} />
      <Divider />

      <select
        aria-label="글꼴"
        title="글꼴"
        value={font}
        onChange={(event) => event.target.value && exec("fontName", event.target.value, true)}
        className={`${SELECT} w-28`}
      >
        <option value="" disabled className="bg-background text-foreground">
          글꼴
        </option>
        {FONTS.map(([value, label]) => (
          <option key={value} value={value} style={{ fontFamily: value }} className="bg-background text-foreground">
            {label}
          </option>
        ))}
      </select>
      <select
        aria-label="글자 크기"
        title="글자 크기"
        value={state.fontSize}
        onChange={(event) => event.target.value && exec("fontSize", event.target.value, true)}
        className={`${SELECT} w-16`}
      >
        <option value="" disabled className="bg-background text-foreground">
          크기
        </option>
        {SIZES.map(([value, label]) => (
          <option key={value} value={value} className="bg-background text-foreground">
            {label}pt
          </option>
        ))}
      </select>
      <Divider />

      <Tool label="굵게 (Ctrl+B)" pressed={on("bold")} onClick={() => exec("bold")} className="font-bold">
        B
      </Tool>
      <Tool label="기울임 (Ctrl+I)" pressed={on("italic")} onClick={() => exec("italic")} className="italic">
        I
      </Tool>
      <Tool label="밑줄 (Ctrl+U)" pressed={on("underline")} onClick={() => exec("underline")} className="underline">
        U
      </Tool>
      <Tool label="취소선" pressed={on("strikeThrough")} onClick={() => exec("strikeThrough")} className="line-through">
        S
      </Tool>
      <Tool label="위 첨자" pressed={on("superscript")} onClick={() => exec("superscript")}>
        x<sup>2</sup>
      </Tool>
      <Tool label="아래 첨자" pressed={on("subscript")} onClick={() => exec("subscript")}>
        x<sub>2</sub>
      </Tool>
      <Menu label="글자 색" button={<span className="font-semibold underline decoration-red-500 decoration-2">A</span>}>
        {(close) => (
          <Swatches
            colors={TEXT_COLORS}
            onPick={(color) => {
              exec("foreColor", color, true);
              close();
            }}
          />
        )}
      </Menu>
      <Menu label="배경 색" button={<Icon name="highlight" />}>
        {(close) => (
          <Swatches
            colors={HIGHLIGHT_COLORS}
            onPick={(color) => {
              exec("hiliteColor", color, true);
              close();
            }}
            none={{
              label: "배경 색 없음",
              onPick: () => {
                exec("hiliteColor", "transparent", true);
                close();
              },
            }}
          />
        )}
      </Menu>
      <Divider />

      <Menu
        label="정렬"
        button={
          <Icon
            name={
              on("justifyCenter")
                ? "alignCenter"
                : on("justifyRight")
                  ? "alignRight"
                  : on("justifyFull")
                    ? "alignJustify"
                    : "alignLeft"
            }
          />
        }
      >
        {(close) => (
          <div className="flex gap-0.5">
            {(
              [
                ["justifyLeft", "alignLeft", "왼쪽 정렬"],
                ["justifyCenter", "alignCenter", "가운데 정렬"],
                ["justifyRight", "alignRight", "오른쪽 정렬"],
                ["justifyFull", "alignJustify", "양쪽 정렬"],
              ] as const
            ).map(([command, icon, label]) => (
              <Tool
                key={command}
                label={label}
                icon={icon}
                pressed={on(command)}
                onClick={() => {
                  exec(command);
                  close();
                }}
              />
            ))}
          </div>
        )}
      </Menu>
      <Tool
        label="글머리 기호 목록"
        icon="listBullet"
        pressed={on("insertUnorderedList")}
        onClick={() => exec("insertUnorderedList")}
      />
      <Tool
        label="번호 목록"
        icon="listNumber"
        pressed={on("insertOrderedList")}
        onClick={() => exec("insertOrderedList")}
      />
      <Tool label="내어쓰기" icon="outdent" onClick={() => exec("outdent")} />
      <Tool label="들여쓰기" icon="indent" onClick={() => exec("indent")} />
      <Tool
        label="인용"
        icon="quote"
        pressed={state.block === "blockquote"}
        onClick={() => toggleBlock("blockquote")}
      />
      <Tool label="코드" icon="code" pressed={state.block === "pre"} onClick={() => toggleBlock("pre")} />
      <Divider />

      <Tool label="링크 (Ctrl+K)" icon="link" onClick={startLink} />
      <Tool label="링크 해제" icon="unlink" onClick={() => exec("unlink")} />
      <Menu label="표 넣기" button={<Icon name="table" />}>
        {(close) => (
          <TablePicker
            onPick={(rows, columns) => {
              insertHtml(tableHtml(rows, columns));
              close();
            }}
          />
        )}
      </Menu>
      <Menu label="이모지" button={<Icon name="emoji" />}>
        {(close) => (
          <div className="grid w-72 grid-cols-8 gap-0.5">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={emoji}
                onClick={() => {
                  exec("insertText", emoji);
                  close();
                }}
                className="rounded p-0.5 text-lg hover:bg-foreground/10"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </Menu>
      <Tool label="구분선" icon="horizontalRule" onClick={() => exec("insertHorizontalRule")} />
      <Divider />
      <Tool
        label="서식 지우기"
        icon="eraser"
        onClick={() => {
          exec("removeFormat");
          exec("unlink");
        }}
      />
      {children}
    </>
  );
}
