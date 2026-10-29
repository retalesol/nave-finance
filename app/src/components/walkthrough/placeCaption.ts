export type CaptionBox = { left: number; top: number; width: number };
type Rect = { x: number; y: number; w: number; h: number };

export const CAPTION_HEIGHT = 248;
const MIN_READABLE_WIDTH = 320;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function overlaps(box: CaptionBox, hole: Rect, gap: number): boolean {
  return !(
    box.left + box.width + gap < hole.x
    || hole.x + hole.w + gap < box.left
    || box.top + CAPTION_HEIGHT + gap < hole.y
    || hole.y + hole.h + gap < box.top
  );
}

/** First-step spotlight covers the dashboard past the 210px stage sidebar.
 *  A card in that gutter (left ~14, width ~hole.x - 28) is unreadable.
 *  Dock at least ~320px beside the opening, or below it when beside does not fit. */
function placeRoomyCaption(hole: Rect, vw: number, vh: number): CaptionBox {
  const margin = 12;
  const contentLeft = Math.max(margin, hole.x);
  const rightEdge = vw - margin;
  const available = Math.max(0, rightEdge - contentLeft);
  const width = Math.min(420, available);
  const left = contentLeft + Math.max(0, (available - width) / 2);

  const besideLeft = hole.x + hole.w + 20;
  const besideRoom = rightEdge - besideLeft;
  if (besideRoom >= MIN_READABLE_WIDTH) {
    return {
      left: besideLeft,
      top: clamp(hole.y, 16, Math.max(16, vh - CAPTION_HEIGHT - 16)),
      width: Math.min(420, besideRoom),
    };
  }

  const belowTop = hole.y + hole.h + 16;
  const top = belowTop + CAPTION_HEIGHT <= vh - 8
    ? belowTop
    : Math.max(16, vh - CAPTION_HEIGHT - 16);
  return { left, top, width };
}

export function placeCaption(hole: Rect, vw: number, vh: number, narrow: boolean, roomy = false): CaptionBox {
  if (roomy && !narrow) return placeRoomyCaption(hole, vw, vh);

  const width = Math.min(420, Math.max(220, vw - 24));
  if (narrow) {
    const left = clamp(hole.x + hole.w / 2 - width / 2, 12, Math.max(12, vw - width - 12));
    const gap = 86;
    let top = hole.y + hole.h + gap;
    if (top + CAPTION_HEIGHT > vh - 8) top = hole.y - CAPTION_HEIGHT - gap;
    if (top < 8) top = Math.max(8, vh - CAPTION_HEIGHT - 8);
    return { left, top, width };
  }

  const bottom: CaptionBox = { left: (vw - width) / 2, top: vh - CAPTION_HEIGHT - 24, width };
  if (!overlaps(bottom, hole, 18)) return bottom;

  const rightLeft = hole.x + hole.w + 20;
  if (rightLeft + width <= vw - 12) {
    return { left: rightLeft, top: clamp(hole.y, 16, vh - CAPTION_HEIGHT - 16), width };
  }
  const leftLeft = hole.x - width - 20;
  if (leftLeft >= 12) {
    return { left: leftLeft, top: clamp(hole.y, 16, vh - CAPTION_HEIGHT - 16), width };
  }
  return { left: clamp(bottom.left, 12, vw - width - 12), top: Math.max(12, bottom.top), width };
}
