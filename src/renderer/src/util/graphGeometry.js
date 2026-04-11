export const GRAPH_NODE_WIDTH = 460
export const GRAPH_NODE_BORDER_WIDTH = 1
export const GRAPH_NODE_OUTER_WIDTH = GRAPH_NODE_WIDTH + (GRAPH_NODE_BORDER_WIDTH * 2)
export const GRAPH_NODE_TITLE_FONT_SIZE = 12
export const GRAPH_NODE_TITLE_LINE_HEIGHT = 16.8
export const GRAPH_NODE_HEADER_PADDING_TOP = 5
export const GRAPH_NODE_HEADER_PADDING_BOTTOM = 4
export const GRAPH_NODE_HEADER_BORDER_BOTTOM = 1
export const GRAPH_NODE_SUBTITLE_FONT_SIZE = 10
export const GRAPH_NODE_SUBTITLE_LINE_HEIGHT = 14
export const GRAPH_NODE_SUBTITLE_PADDING_TOP = 2
export const GRAPH_NODE_SUBTITLE_PADDING_BOTTOM = 5
export const GRAPH_NODE_SUBTITLE_BORDER_BOTTOM = 1
export const GRAPH_NODE_LINES_PADDING_TOP = 6
export const GRAPH_NODE_LINES_PADDING_BOTTOM = 8
export const GRAPH_NODE_LINE_FONT_SIZE = 12
export const GRAPH_NODE_ROW_HEIGHT = 20

export const GRAPH_NODE_HEADER_HEIGHT =
  GRAPH_NODE_HEADER_PADDING_TOP
  + GRAPH_NODE_TITLE_LINE_HEIGHT
  + GRAPH_NODE_HEADER_PADDING_BOTTOM
  + GRAPH_NODE_HEADER_BORDER_BOTTOM

export const GRAPH_NODE_SUBTITLE_HEIGHT =
  GRAPH_NODE_SUBTITLE_PADDING_TOP
  + GRAPH_NODE_SUBTITLE_LINE_HEIGHT
  + GRAPH_NODE_SUBTITLE_PADDING_BOTTOM
  + GRAPH_NODE_SUBTITLE_BORDER_BOTTOM

export const GRAPH_NODE_OUTER_BASE_HEIGHT =
  GRAPH_NODE_BORDER_WIDTH
  + GRAPH_NODE_HEADER_HEIGHT
  + GRAPH_NODE_SUBTITLE_HEIGHT
  + GRAPH_NODE_LINES_PADDING_TOP
  + GRAPH_NODE_LINES_PADDING_BOTTOM
  + GRAPH_NODE_BORDER_WIDTH

export const GRAPH_NODE_FIRST_ROW_CENTER =
  GRAPH_NODE_HEADER_HEIGHT
  + GRAPH_NODE_SUBTITLE_HEIGHT
  + GRAPH_NODE_LINES_PADDING_TOP
  + (GRAPH_NODE_ROW_HEIGHT / 2)

export const GRAPH_NODE_CSS_VARS = Object.freeze({
  '--graph-node-width': `${GRAPH_NODE_WIDTH}px`,
  '--graph-node-border-width': `${GRAPH_NODE_BORDER_WIDTH}px`,
  '--graph-node-title-font-size': `${GRAPH_NODE_TITLE_FONT_SIZE}px`,
  '--graph-node-title-line-height': `${GRAPH_NODE_TITLE_LINE_HEIGHT}px`,
  '--graph-node-header-padding-top': `${GRAPH_NODE_HEADER_PADDING_TOP}px`,
  '--graph-node-header-padding-bottom': `${GRAPH_NODE_HEADER_PADDING_BOTTOM}px`,
  '--graph-node-header-border-bottom': `${GRAPH_NODE_HEADER_BORDER_BOTTOM}px`,
  '--graph-node-subtitle-font-size': `${GRAPH_NODE_SUBTITLE_FONT_SIZE}px`,
  '--graph-node-subtitle-line-height': `${GRAPH_NODE_SUBTITLE_LINE_HEIGHT}px`,
  '--graph-node-subtitle-padding-top': `${GRAPH_NODE_SUBTITLE_PADDING_TOP}px`,
  '--graph-node-subtitle-padding-bottom': `${GRAPH_NODE_SUBTITLE_PADDING_BOTTOM}px`,
  '--graph-node-subtitle-border-bottom': `${GRAPH_NODE_SUBTITLE_BORDER_BOTTOM}px`,
  '--graph-node-lines-padding-top': `${GRAPH_NODE_LINES_PADDING_TOP}px`,
  '--graph-node-lines-padding-bottom': `${GRAPH_NODE_LINES_PADDING_BOTTOM}px`,
  '--graph-node-line-font-size': `${GRAPH_NODE_LINE_FONT_SIZE}px`,
  '--graph-node-row-height': `${GRAPH_NODE_ROW_HEIGHT}px`
})

function normalizeLineCount(lineCount) {
  if (!Number.isFinite(lineCount)) return 0
  return Math.max(0, Math.floor(lineCount))
}

export function getGraphNodeHeight(lineCount) {
  return GRAPH_NODE_OUTER_BASE_HEIGHT + normalizeLineCount(lineCount) * GRAPH_NODE_ROW_HEIGHT
}

export function getGraphLineCenter(rowIndex, lineCount) {
  if (!Number.isFinite(rowIndex)) return null
  const normalizedRowIndex = Math.floor(rowIndex)
  if (normalizedRowIndex < 0) return null
  const normalizedLineCount = normalizeLineCount(lineCount)
  if (normalizedRowIndex >= normalizedLineCount) return null
  return GRAPH_NODE_FIRST_ROW_CENTER + normalizedRowIndex * GRAPH_NODE_ROW_HEIGHT
}
