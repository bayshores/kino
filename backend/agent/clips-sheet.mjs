// look {mode:"source"} with no layer: every clip and picture of the project on one sheet, 3 to 6
// frames each (a picture: 1), so an agent never builds contact sheets with FFmpeg. This file
// picks the times and lays the blocks out; look.mjs clipsImage draws them.

export const CLIPS_WIDTH = 1280;
export const CLIPS_PAGE_HEIGHT = 1400;
// Every tile has about this area (px²): 200 × 112 landscape, 112 × 200 portrait.
const TILE_AREA = 200 * 112;
export const CLIPS_HEADER = 22;
export const CLIPS_GAP = 4;
const BLOCK_GAP = 14;
const ROW_GAP = 10;

/** Frames for a clip of `duration` seconds, at most `most` (0 or less: a picture, 1 frame). */
export function clipFrameCount(duration, most = 6) {
  if (!(duration > 0)) return 1;
  return Math.min(most, duration < 4 ? 3 : duration < 8 ? 4 : duration < 15 ? 5 : 6);
}

/** The file seconds of a clip's frames, spread over it (the middle of each equal part). */
export function clipTimes(duration, most = 6) {
  const count = clipFrameCount(duration, most);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => Math.round(((index + 0.5) / count) * duration * 10) / 10);
}

/** A tile of about TILE_AREA with the file's shape. */
export function clipTile(width, height) {
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const tileWidth = Math.max(2, Math.round(Math.sqrt(TILE_AREA * aspect)));
  return { width: Math.min(CLIPS_WIDTH, tileWidth), height: Math.max(2, Math.round(tileWidth / aspect)) };
}

/**
 * Blocks ([{tile, times}]) flowed left to right in rows CLIPS_WIDTH wide, rows in pages at most
 * CLIPS_PAGE_HEIGHT tall. Answers pages: [{width, height, places: [{index, x, y, width, tile}]}].
 */
export function layoutClips(blocks) {
  const pages = [];
  let page = null, row = [], x = 0, y = 0, rowHeight = 0;
  const startPage = () => { page = { width: CLIPS_WIDTH, height: 0, places: [] }; pages.push(page); y = 0; };
  const closeRow = () => {
    if (!row.length) return;
    if (page && page.places.length && y + rowHeight > CLIPS_PAGE_HEIGHT) startPage();
    if (!page) startPage();
    for (const place of row) page.places.push({ ...place, y });
    page.height = y + rowHeight;
    y += rowHeight + ROW_GAP;
    row = []; x = 0; rowHeight = 0;
  };
  for (const [index, block] of blocks.entries()) {
    const count = block.times.length;
    // A very wide file's tiles shrink to fit one row.
    const scale = Math.min(1, (CLIPS_WIDTH - (count - 1) * CLIPS_GAP) / (count * block.tile.width));
    const tile = { width: Math.floor(block.tile.width * scale), height: Math.floor(block.tile.height * scale) };
    const width = count * tile.width + (count - 1) * CLIPS_GAP;
    if (row.length && x + width > CLIPS_WIDTH) closeRow();
    row.push({ index, x, width, tile });
    x += width + BLOCK_GAP;
    rowHeight = Math.max(rowHeight, CLIPS_HEADER + tile.height);
  }
  closeRow();
  return pages;
}

/**
 * Files ([{width, height, duration}]) as blocks and pages: 6 frames a clip at most, fewer (4,
 * then 3) when that keeps them all on one page. A file with `times` keeps them (a group of found
 * clips: one frame each). Answers { blocks, pages }.
 */
export function planClips(files) {
  let plan = null;
  for (const most of [6, 4, 3]) {
    const blocks = files.map((file) => ({ tile: clipTile(file.width, file.height), times: file.times ?? clipTimes(file.duration, most) }));
    plan = { blocks, pages: layoutClips(blocks) };
    if (plan.pages.length === 1) break;
  }
  return plan;
}
