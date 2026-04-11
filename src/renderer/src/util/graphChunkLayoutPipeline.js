import { getGraphLineCenter } from './graphGeometry.js'
import { prepareGraphLayout } from './graphBuild.js'
import { collapseExactlyCollinearPoints } from './graphPointSimplify.js'

const DEFAULT_PACKING_GAP_X = 96
const DEFAULT_PACKING_GAP_Y = 120
const DEFAULT_ROW_WIDTH = 3600

function emitProgress(onProgress, stepId, patch = {}) {
  if (typeof onProgress !== 'function') return
  onProgress({ stepId, ...patch })
}

function translatePoints(points, offsetX, offsetY) {
  return (Array.isArray(points) ? points : []).map((point) => ({
    x: point.x + offsetX,
    y: point.y + offsetY
  }))
}

function dedupePoints(points) {
  const deduped = []
  for (const point of Array.isArray(points) ? points : []) {
    const last = deduped[deduped.length - 1]
    if (last && last.x === point.x && last.y === point.y) continue
    deduped.push(point)
  }
  return deduped
}

function buildChunkProgressMapper(globalState, onProgress) {
  return (progress = {}) => {
    const stepId = progress?.stepId
    if (!stepId) return

    if (stepId === 'scanEdges' || stepId === 'buildPorts') {
      const completed = Math.min(globalState.totalInternalEdgeCount, globalState.completedInternalEdgesBefore + (progress.completed || 0))
      emitProgress(onProgress, stepId, {
        status: progress.status,
        completed,
        total: globalState.totalInternalEdgeCount,
        detail: `${completed} / ${globalState.totalInternalEdgeCount} edges`
      })
      return
    }

    if (stepId === 'elkGraph') {
      emitProgress(onProgress, stepId, {
        status: progress.status,
        detail: `${globalState.completedNodesBefore} / ${globalState.totalNodeCount} nodes, ${globalState.completedInternalEdgesBefore} / ${globalState.totalInternalEdgeCount} edges`
      })
    }
  }
}

export function prepareChunkLayouts(graphNodes, graphEdges, measurementsByNode, chunkPlan, options = {}) {
  const { onProgress, onChunkPrepared } = options
  const nodeById = new Map((Array.isArray(graphNodes) ? graphNodes : []).map((node) => [node.id, node]))
  const edgeById = new Map((Array.isArray(graphEdges) ? graphEdges : []).map((edge) => [edge.id, edge]))
  const chunks = Array.isArray(chunkPlan?.chunks) ? chunkPlan.chunks : []
  let completedNodesBefore = 0
  let completedInternalEdgesBefore = 0

  emitProgress(onProgress, 'scanEdges', {
    status: chunks.length ? 'active' : 'done',
    completed: 0,
    total: chunkPlan?.totalInternalEdgeCount || 0,
    detail: `0 / ${chunkPlan?.totalInternalEdgeCount || 0} edges`
  })
  emitProgress(onProgress, 'buildPorts', {
    status: chunks.length ? 'active' : 'done',
    completed: 0,
    total: chunkPlan?.totalInternalEdgeCount || 0,
    detail: `0 / ${chunkPlan?.totalInternalEdgeCount || 0} edges`
  })
  emitProgress(onProgress, 'elkGraph', {
    status: chunks.length ? 'active' : 'done',
    detail: `0 / ${chunkPlan?.totalNodeCount || 0} nodes, 0 / ${chunkPlan?.totalInternalEdgeCount || 0} edges`
  })

  for (const chunk of chunks) {
    const chunkNodes = chunk.nodeIds.map((nodeId) => nodeById.get(nodeId)).filter(Boolean)
    const internalEdges = chunk.internalEdgeIds.map((edgeId) => edgeById.get(edgeId)).filter(Boolean)
    const localOnProgress = buildChunkProgressMapper({
      totalNodeCount: chunkPlan.totalNodeCount,
      totalInternalEdgeCount: chunkPlan.totalInternalEdgeCount,
      completedNodesBefore,
      completedInternalEdgesBefore
    }, onProgress)

    const prepared = prepareGraphLayout(chunkNodes, internalEdges, measurementsByNode, localOnProgress)
    completedNodesBefore += chunk.nodeCount
    completedInternalEdgesBefore += chunk.internalEdgeCount

    emitProgress(onProgress, 'elkGraph', {
      status: completedNodesBefore >= chunkPlan.totalNodeCount ? 'done' : 'active',
      detail: `${completedNodesBefore} / ${chunkPlan.totalNodeCount} nodes, ${completedInternalEdgesBefore} / ${chunkPlan.totalInternalEdgeCount} edges`
    })

    if (typeof onChunkPrepared === 'function') {
      onChunkPrepared({
        chunk,
        prepared,
        chunkTotals: {
          completedNodes: completedNodesBefore,
          completedInternalEdges: completedInternalEdgesBefore,
          totalNodes: chunkPlan.totalNodeCount,
          totalInternalEdges: chunkPlan.totalInternalEdgeCount
        }
      })
    }
  }

  emitProgress(onProgress, 'scanEdges', {
    status: 'done',
    completed: chunkPlan?.totalInternalEdgeCount || 0,
    total: chunkPlan?.totalInternalEdgeCount || 0,
    detail: `${chunkPlan?.totalInternalEdgeCount || 0} / ${chunkPlan?.totalInternalEdgeCount || 0} edges`
  })
  emitProgress(onProgress, 'buildPorts', {
    status: 'done',
    completed: chunkPlan?.totalInternalEdgeCount || 0,
    total: chunkPlan?.totalInternalEdgeCount || 0,
    detail: `${chunkPlan?.totalInternalEdgeCount || 0} / ${chunkPlan?.totalInternalEdgeCount || 0} edges`
  })
}

export function createChunkPackingState(options = {}) {
  return {
    cursorX: 0,
    cursorY: 0,
    rowHeight: 0,
    rowWidth: Number.isFinite(options?.rowWidth) ? options.rowWidth : DEFAULT_ROW_WIDTH,
    gapX: Number.isFinite(options?.gapX) ? options.gapX : DEFAULT_PACKING_GAP_X,
    gapY: Number.isFinite(options?.gapY) ? options.gapY : DEFAULT_PACKING_GAP_Y
  }
}

function computeChunkBounds(nodes) {
  const nodeList = Array.isArray(nodes) ? nodes : []
  if (!nodeList.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const node of nodeList) {
    const x = Number.isFinite(node?.position?.x) ? node.position.x : 0
    const y = Number.isFinite(node?.position?.y) ? node.position.y : 0
    const width = Number.isFinite(node?.width) ? node.width : 0
    const height = Number.isFinite(node?.height) ? node.height : 0
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + width)
    maxY = Math.max(maxY, y + height)
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  }
}

export function placeChunkLayout(builtChunk, packingState) {
  const nodeList = Array.isArray(builtChunk?.nodes) ? builtChunk.nodes : []
  const edgeList = Array.isArray(builtChunk?.edges) ? builtChunk.edges : []
  const bounds = computeChunkBounds(nodeList)
  const chunkWidth = bounds.width || 1
  const chunkHeight = bounds.height || 1

  if (packingState.cursorX > 0 && (packingState.cursorX + chunkWidth) > packingState.rowWidth) {
    packingState.cursorX = 0
    packingState.cursorY += packingState.rowHeight + packingState.gapY
    packingState.rowHeight = 0
  }

  const offsetX = packingState.cursorX - bounds.minX
  const offsetY = packingState.cursorY - bounds.minY

  const nodes = nodeList.map((node) => ({
    ...node,
    position: {
      x: (Number.isFinite(node?.position?.x) ? node.position.x : 0) + offsetX,
      y: (Number.isFinite(node?.position?.y) ? node.position.y : 0) + offsetY
    }
  }))

  const edges = edgeList.map((edge) => ({
    ...edge,
    data: {
      ...(edge.data || {}),
      points: translatePoints(edge?.data?.points, offsetX, offsetY)
    }
  }))

  packingState.cursorX += chunkWidth + packingState.gapX
  packingState.rowHeight = Math.max(packingState.rowHeight, chunkHeight)

  return {
    nodes,
    edges,
    bounds: {
      ...bounds,
      width: chunkWidth,
      height: chunkHeight,
      offsetX,
      offsetY
    }
  }
}

function getEdgeAnchor(node, edge, side) {
  if (!node || !edge) return null
  const x = Number.isFinite(node?.position?.x) ? node.position.x : 0
  const y = Number.isFinite(node?.position?.y) ? node.position.y : 0
  const width = Number.isFinite(node?.width) ? node.width : 0
  const height = Number.isFinite(node?.height) ? node.height : 0
  const lineCount = Array.isArray(node?.data?.lines) ? node.data.lines.length : 0

  if (edge?.kind === 'fallthrough') {
    return side === 'source'
      ? { x: x + (width / 2), y: y + height }
      : { x: x + (width / 2), y }
  }

  const lineIndex = side === 'source' ? edge?.sourceLineIndex : edge?.targetLineIndex
  const centerY = y + getGraphLineCenter(lineIndex, lineCount)
  return {
    x: side === 'source' ? (x + width) : x,
    y: centerY
  }
}

function buildCrossChunkPoints(edge, sourceNode, targetNode) {
  const sourceAnchor = getEdgeAnchor(sourceNode, edge, 'source')
  const targetAnchor = getEdgeAnchor(targetNode, edge, 'target')
  if (!sourceAnchor || !targetAnchor) return []

  if (edge?.kind === 'fallthrough') {
    const midY = Math.round((sourceAnchor.y + targetAnchor.y) / 2)
    return dedupePoints([
      sourceAnchor,
      { x: sourceAnchor.x, y: midY },
      { x: targetAnchor.x, y: midY },
      targetAnchor
    ])
  }

  const midX = Math.round((sourceAnchor.x + targetAnchor.x) / 2)
  return dedupePoints([
    sourceAnchor,
    { x: midX, y: sourceAnchor.y },
    { x: midX, y: targetAnchor.y },
    targetAnchor
  ])
}

export function buildCrossChunkEdgesForChunk(chunkMeta, context = {}) {
  const { completedChunkIds, nodesById, edgeById, renderedEdgeIds } = context
  const edges = []

  for (const boundary of Array.isArray(chunkMeta?.boundaryEdges) ? chunkMeta.boundaryEdges : []) {
    if (!completedChunkIds?.has(boundary?.otherChunkId)) continue
    if (renderedEdgeIds?.has(boundary?.edgeId)) continue

    const edge = edgeById?.get(boundary?.edgeId)
    if (!edge) continue
    const sourceNode = nodesById?.get(edge.source)
    const targetNode = nodesById?.get(edge.target)
    if (!sourceNode || !targetNode) continue

    const rawPoints = buildCrossChunkPoints(edge, sourceNode, targetNode)
    const simplified = collapseExactlyCollinearPoints(rawPoints, { edgeId: edge.id, context: 'cross-chunk' })
    const points = simplified.points
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'routed',
      selectable: false,
      focusable: false,
      data: {
        kind: edge.kind,
        sourceAsm: edge.sourceAsm,
        targetAsm: edge.targetAsm,
        sourceLineIndex: edge.sourceLineIndex,
        targetLineIndex: edge.targetLineIndex,
        targetCpuAddr: Number.isFinite(edge.targetCpuAddr) ? (edge.targetCpuAddr & 0xffff) : null,
        bundleGroupKey: null,
        points
      }
    })
  }

  return edges
}
