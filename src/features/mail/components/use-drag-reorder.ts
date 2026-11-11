"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/** How long rows take to slide out of the way, and the dropped row into place. */
const SLIDE_MS = 160;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

type Drag = {
  id: string;
  pointerId: number;
  /** Pointer position when the drag began. */
  startY: number;
  /** Index of the dragged row in `ids`. */
  from: number;
  /** Where it would land if dropped now. */
  over: number;
  /** How far the dragged row has moved. */
  dy: number;
  /** Every row's box when the drag began, in `ids` order. */
  rects: DOMRect[];
  /** Released: the row slides into its slot before the order changes. */
  dropping: boolean;
};

/**
 * Where the dragged row would land: a neighbour makes way once the dragged
 * row's leading edge (bottom going down, top going up) passes its middle.
 */
export function targetIndex(rects: Pick<DOMRect, "top" | "height">[], from: number, dy: number) {
  const top = rects[from].top + dy;
  const bottom = top + rects[from].height;
  const middle = (i: number) => rects[i].top + rects[i].height / 2;
  let over = from;
  for (let i = from + 1; i < rects.length; i++) {
    if (bottom > middle(i)) over = i;
  }
  for (let i = from - 1; i >= 0; i--) {
    if (top < middle(i)) over = i;
  }
  return over;
}

/** `ids` with the item at `from` moved to `to`. */
export function moveIndex<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Reordering a vertical list by dragging a handle. While a row is dragged the
 * others slide aside to show where it will land; on release it slides into
 * that slot, and only then is `onReorder` called with the new order. The
 * handle also takes ↑/↓ keys, for the keyboard.
 */
export function useDragReorder(ids: readonly string[], onReorder: (ids: string[]) => void) {
  const rows = useRef(new Map<string, HTMLElement>());
  const [drag, setDrag] = useState<Drag | null>(null);
  // After a drop the rows are reordered and their offsets cleared together;
  // for that one frame nothing may animate, or the rows would jump back.
  const [settling, setSettling] = useState(false);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
  /** A row moved by key: its handle gets the focus back once it is in place. */
  const [refocus, setRefocus] = useState<string | null>(null);

  useEffect(() => {
    if (!settling) return;
    const frame = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(frame);
  }, [settling]);

  useEffect(() => {
    if (!refocus) return;
    rows.current.get(refocus)?.querySelector<HTMLElement>("[data-drag-handle]")?.focus();
  }, [refocus, ids]);

  const slide = reducedMotion ? "none" : `transform ${SLIDE_MS}ms ease`;

  const finish = (current: Drag) => {
    if (current.over === current.from) {
      setDrag(null);
      return;
    }
    // Into the slot the other rows made room for, then commit the order.
    const { rects, from, over } = current;
    const landing =
      over > from ? rects[over].bottom - rects[from].bottom : rects[over].top - rects[from].top;
    setDrag({ ...current, dy: landing, dropping: true });
    window.setTimeout(
      () => {
        setSettling(true);
        setDrag(null);
        onReorder(moveIndex([...ids], from, over));
      },
      reducedMotion ? 0 : SLIDE_MS,
    );
  };

  const rowProps = (id: string) => {
    const index = ids.indexOf(id);
    let style: CSSProperties = { transition: settling ? "none" : slide };
    if (drag) {
      if (id === drag.id) {
        style = {
          transform: `translateY(${drag.dy}px)`,
          transition: drag.dropping ? slide : "none",
          position: "relative",
          zIndex: 10,
        };
      } else {
        const height = drag.rects[drag.from].height;
        const shift =
          drag.from < drag.over && index > drag.from && index <= drag.over
            ? -height
            : drag.from > drag.over && index >= drag.over && index < drag.from
              ? height
              : 0;
        style = { transform: `translateY(${shift}px)`, transition: slide };
      }
    }
    return {
      ref: (element: HTMLElement | null) => {
        if (element) rows.current.set(id, element);
        else rows.current.delete(id);
      },
      style,
      "data-dragging": drag?.id === id || undefined,
    };
  };

  const handleProps = (id: string) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (drag || event.button !== 0) return;
      const rects = ids.map((item) => rows.current.get(item)?.getBoundingClientRect());
      if (rects.some((rect) => !rect)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const from = ids.indexOf(id);
      setDrag({
        id,
        pointerId: event.pointerId,
        startY: event.clientY,
        from,
        over: from,
        dy: 0,
        rects: rects as DOMRect[],
        dropping: false,
      });
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (!drag || drag.dropping || event.pointerId !== drag.pointerId) return;
      const { rects, from } = drag;
      // Kept within the list, so the row cannot be dragged off into nowhere.
      const min = rects[0].top - rects[from].top;
      const max = rects[rects.length - 1].bottom - rects[from].bottom;
      const dy = Math.min(max, Math.max(min, event.clientY - drag.startY));
      setDrag({ ...drag, dy, over: targetIndex(rects, from, dy) });
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (!drag || drag.dropping || event.pointerId !== drag.pointerId) return;
      finish(drag);
    },
    onPointerCancel: () => {
      if (drag && !drag.dropping) setDrag(null);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      const from = ids.indexOf(id);
      const to = from + step;
      if (!step || drag || to < 0 || to >= ids.length) return;
      event.preventDefault();
      setRefocus(id);
      onReorder(moveIndex([...ids], from, to));
    },
    onBlur: () => setRefocus(null),
    "data-drag-handle": true,
    style: { touchAction: "none", cursor: drag?.id === id ? "grabbing" : "grab" } as CSSProperties,
  });

  return { rowProps, handleProps, dragging: drag !== null };
}
