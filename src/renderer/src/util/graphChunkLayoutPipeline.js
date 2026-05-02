import { getGraphLineCenter } from './graphGeometry.js'
import { prepareGraphLayout } from './graphBuild.js'
import { collapseExactlyCollinearPoints } from './graphPointSimplify.js'

const DEFAULT_PACKING_GAP_X = 220
const DEFAULT_PACKING_GAP_Y = 180
const DEFAULT_COMPONENT_MEMBER_GAP = 96
const ROUTE_STUB = 34
const ROUTE_LANE_SPACING = 16
const RECT_PADDING = 8
const MAX_RELAX_PASSES = 6
const SMALL_COMPONENT_MAX_ITEMS = 20
const SMALL_COMPONENT_MAX_AVG_RECT_AREA = 220000
const SMALL_COMPONENT_MAX_RECT_SPAN = 620
const NEIGHBORHOOD_BASE_MAX_ITEMS = 12
const NEIGHBORHOOD_TINY_RECT_MAX_AREA = 68000
const NEIGHBORHOOD_MAX_TOTAL_AREA = 1600000
const NEIGHBORHOOD_ATTACH_WEIGHT_MIN = 4

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

function describeEdge(edge) {
  return `${String(edge?.id || '?')} (${String(edge?.source || '?')}:${String(edge?.sourceLineIndex ?? '?')} -> ${String(edge?.target || '?')}:${String(edge?.targetLineIndex ?? '?')})`
}

function getNodeBounds(node) {
  const x = Number.isFinite(node?.position?.x) ? node.position.x : 0
  const y = Number.isFinite(node?.position?.y) ? node.position.y : 0
  const width = Number.isFinite(node?.width) ? node.width : 0
  const height = Number.isFinite(node?.height) ? node.height : 0
  return {
    minX: x,
    minY: y,
    maxX: x + width,
    maxY: y + height,
    width,
    height
  }
}

function getNodeCenter(bounds) {
  return {
    x: bounds.minX + (bounds.width / 2),
    y: bounds.minY + (bounds.height / 2)
  }
}

function requireGraphLineCenter(lineIndex, lineCount, edge, sideRole) {
  const center = getGraphLineCenter(lineIndex, lineCount)
  if (!Number.isFinite(center)) {
    throw new Error(`Graph edge ${describeEdge(edge)} has invalid ${sideRole}LineIndex ${String(lineIndex)} for lineCount ${String(lineCount)}`)
  }
  return center
}

function assertFinitePoint(point, edge, label) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new Error(`Graph edge ${describeEdge(edge)} produced a non-finite ${label} point`)
  }
}

function assertFinitePointList(points, edge, context) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error(`Graph edge ${describeEdge(edge)} produced too few ${context} points`)
  }
  points.forEach((point, index) => assertFinitePoint(point, edge, `${context}[${index}]`))
}

function getChannelCoordinate(bounds, side, laneOffset, maxAbsLaneOffset) {
  const baseOffset = ROUTE_STUB + Math.max(0, maxAbsLaneOffset)
  if (side === 'right') return bounds.maxX + baseOffset + laneOffset
  if (side === 'left') return bounds.minX - baseOffset + laneOffset
  if (side === 'bottom') return bounds.maxY + baseOffset + laneOffset
  if (side === 'top') return bounds.minY - baseOffset + laneOffset
  throw new Error(`Unsupported chunk route side ${String(side)}`)
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
    gapX: Number.isFinite(options?.gapX) ? options.gapX : DEFAULT_PACKING_GAP_X,
    gapY: Number.isFinite(options?.gapY) ? options.gapY : DEFAULT_PACKING_GAP_Y,
    memberGap: Number.isFinite(options?.memberGap) ? options.memberGap : DEFAULT_COMPONENT_MEMBER_GAP
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

function placeChunkAtPosition(builtChunk, targetX, targetY) {
  const nodeList = Array.isArray(builtChunk?.nodes) ? builtChunk.nodes : []
  const edgeList = Array.isArray(builtChunk?.edges) ? builtChunk.edges : []
  const bounds = computeChunkBounds(nodeList)
  const chunkWidth = bounds.width || 1
  const chunkHeight = bounds.height || 1
  const offsetX = targetX - bounds.minX
  const offsetY = targetY - bounds.minY

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

  return {
    nodes,
    edges,
    bounds: {
      minX: bounds.minX + offsetX,
      minY: bounds.minY + offsetY,
      maxX: bounds.maxX + offsetX,
      maxY: bounds.maxY + offsetY,
      width: chunkWidth,
      height: chunkHeight,
      offsetX,
      offsetY
    }
  }
}

function getChunkEdgeWeight(edge) {
  if (!edge || typeof edge !== 'object') return 1
  if (edge.kind === 'fallthrough') return 7
  if (edge.kind === 'branch') return 4
  if (edge.kind === 'jump') return 3
  if (edge.kind === 'call') return 1
  return 1
}

function getChunkAffinityWeight(edge) {
  if (!edge || typeof edge !== 'object') return 0
  if (edge.kind === 'fallthrough') return 10
  if (edge.kind === 'branch') return 6
  if (edge.kind === 'jump') return 4
  if (edge.kind === 'call') return 0
  return 2
}

function buildChunkGraph(chunkRecords, edgeById) {
  const chunkIds = []
  const nodeToChunkId = new Map()
  const chunkById = new Map()
  const chunkIndexById = new Map()
  const outgoing = new Map()
  const incoming = new Map()
  const layoutAffinity = new Map()

  for (const record of Array.isArray(chunkRecords) ? chunkRecords : []) {
    const chunkId = record?.chunk?.chunkId
    if (!chunkId) continue
    chunkIds.push(chunkId)
    chunkById.set(chunkId, record.chunk)
    chunkIndexById.set(chunkId, Number.isFinite(record?.chunk?.chunkIndex) ? record.chunk.chunkIndex : chunkIds.length - 1)
    outgoing.set(chunkId, new Map())
    incoming.set(chunkId, new Map())
    layoutAffinity.set(chunkId, new Map())
    for (const nodeId of Array.isArray(record?.chunk?.nodeIds) ? record.chunk.nodeIds : []) {
      nodeToChunkId.set(nodeId, chunkId)
    }
  }

  for (const edge of edgeById?.values?.() || []) {
    const sourceChunkId = nodeToChunkId.get(edge?.source)
    const targetChunkId = nodeToChunkId.get(edge?.target)
    if (!sourceChunkId || !targetChunkId || sourceChunkId === targetChunkId) continue
    const weight = getChunkEdgeWeight(edge)
    outgoing.get(sourceChunkId).set(targetChunkId, (outgoing.get(sourceChunkId).get(targetChunkId) || 0) + weight)
    incoming.get(targetChunkId).set(sourceChunkId, (incoming.get(targetChunkId).get(sourceChunkId) || 0) + weight)

    const affinityWeight = getChunkAffinityWeight(edge)
    if (affinityWeight > 0) {
      addSymmetricWeight(layoutAffinity, sourceChunkId, targetChunkId, affinityWeight)
    }
  }

  return {
    chunkIds,
    nodeToChunkId,
    chunkById,
    chunkIndexById,
    outgoing,
    incoming,
    layoutAffinity
  }
}

function cloneWeightMap(weightMap, ids) {
  const cloned = new Map()
  for (const itemId of ids) {
    const row = new Map()
    for (const [otherId, weight] of weightMap.get(itemId)?.entries?.() || []) {
      row.set(otherId, weight)
    }
    cloned.set(itemId, row)
  }
  return cloned
}

function buildNeighborhoodAffinityMap(chunkGraph) {
  const affinityMap = cloneWeightMap(chunkGraph.layoutAffinity || new Map(), chunkGraph.chunkIds)

  function keysOf(ownerChunkId, mapLike) {
    return Array.from(mapLike?.keys?.() || []).filter((chunkId) => affinityMap.has(chunkId) && (affinityMap.get(ownerChunkId)?.get(chunkId) || 0) > 0)
  }

  for (const chunkId of chunkGraph.chunkIds) {
    const outgoingNeighbors = keysOf(chunkId, chunkGraph.outgoing.get(chunkId)).filter((otherChunkId) => otherChunkId !== chunkId)
    for (let leftIndex = 0; leftIndex < outgoingNeighbors.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < outgoingNeighbors.length; rightIndex++) {
        addSymmetricWeight(affinityMap, outgoingNeighbors[leftIndex], outgoingNeighbors[rightIndex], 1.2)
      }
    }

    const incomingNeighbors = keysOf(chunkId, chunkGraph.incoming.get(chunkId)).filter((otherChunkId) => otherChunkId !== chunkId)
    for (let leftIndex = 0; leftIndex < incomingNeighbors.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < incomingNeighbors.length; rightIndex++) {
        addSymmetricWeight(affinityMap, incomingNeighbors[leftIndex], incomingNeighbors[rightIndex], 0.9)
      }
    }
  }

  return affinityMap
}

function computeChunkArea(metric) {
  const width = Math.max(1, metric?.width || 1)
  const height = Math.max(1, metric?.height || 1)
  return width * height
}

function computeNeighborhoodMaxItems(seedMetric) {
  const seedArea = computeChunkArea(seedMetric)
  if (seedArea <= NEIGHBORHOOD_TINY_RECT_MAX_AREA) return 22
  if (seedArea <= NEIGHBORHOOD_TINY_RECT_MAX_AREA * 2.5) return 16
  return NEIGHBORHOOD_BASE_MAX_ITEMS
}

function buildLayoutNeighborhoods(chunkGraph, chunkMetricsByChunkId) {
  const affinityMap = buildNeighborhoodAffinityMap(chunkGraph)
  const chunkIds = chunkGraph.chunkIds.slice()
  const weightedDegreeByChunkId = new Map()
  for (const chunkId of chunkIds) {
    weightedDegreeByChunkId.set(chunkId, computeWeightedDegree(affinityMap, chunkId))
  }

  const seedOrder = chunkIds.slice().sort((a, b) => {
    const degreeDiff = (weightedDegreeByChunkId.get(b) || 0) - (weightedDegreeByChunkId.get(a) || 0)
    if (degreeDiff !== 0) return degreeDiff
    const areaDiff = computeChunkArea(chunkMetricsByChunkId.get(a)) - computeChunkArea(chunkMetricsByChunkId.get(b))
    if (areaDiff !== 0) return areaDiff
    return (chunkGraph.chunkIndexById.get(a) || 0) - (chunkGraph.chunkIndexById.get(b) || 0)
  })

  const unassigned = new Set(chunkIds)
  const components = []
  const componentIdByChunkId = new Map()

  function frontierScore(chunkId, memberIds) {
    let directWeight = 0
    let linkedMembers = 0
    for (const memberId of memberIds) {
      const weight = affinityMap.get(chunkId)?.get(memberId) || 0
      if (!weight) continue
      directWeight += weight
      linkedMembers += 1
    }
    const degree = weightedDegreeByChunkId.get(chunkId) || 0
    return {
      directWeight,
      linkedMembers,
      score: (directWeight * 10) + (linkedMembers * 6) + Math.min(20, degree)
    }
  }

  function canAttachChunk(memberIds, chunkId, totalArea, maxItems) {
    if (!unassigned.has(chunkId)) return false
    if (memberIds.length >= maxItems) return false
    if ((totalArea + computeChunkArea(chunkMetricsByChunkId.get(chunkId))) > NEIGHBORHOOD_MAX_TOTAL_AREA) return false
    const { directWeight, linkedMembers } = frontierScore(chunkId, memberIds)
    if (directWeight < NEIGHBORHOOD_ATTACH_WEIGHT_MIN) return false
    if (memberIds.length >= 3 && linkedMembers <= 0) return false
    return true
  }

  while (unassigned.size) {
    const seedChunkId = seedOrder.find((chunkId) => unassigned.has(chunkId))
    if (!seedChunkId) break
    const memberIds = [seedChunkId]
    const memberSet = new Set(memberIds)
    unassigned.delete(seedChunkId)
    let totalArea = computeChunkArea(chunkMetricsByChunkId.get(seedChunkId))
    const maxItems = computeNeighborhoodMaxItems(chunkMetricsByChunkId.get(seedChunkId))

    while (true) {
      const candidates = []
      for (const memberId of memberIds) {
        for (const [neighborChunkId] of affinityMap.get(memberId)?.entries?.() || []) {
          if (!unassigned.has(neighborChunkId) || memberSet.has(neighborChunkId)) continue
          candidates.push(neighborChunkId)
        }
      }
      const uniqueCandidates = Array.from(new Set(candidates))
      uniqueCandidates.sort((a, b) => {
        const aScore = frontierScore(a, memberIds)
        const bScore = frontierScore(b, memberIds)
        if (bScore.score !== aScore.score) return bScore.score - aScore.score
        if (bScore.directWeight !== aScore.directWeight) return bScore.directWeight - aScore.directWeight
        return (chunkGraph.chunkIndexById.get(a) || 0) - (chunkGraph.chunkIndexById.get(b) || 0)
      })

      const nextChunkId = uniqueCandidates.find((chunkId) => canAttachChunk(memberIds, chunkId, totalArea, maxItems))
      if (!nextChunkId) break
      memberIds.push(nextChunkId)
      memberSet.add(nextChunkId)
      unassigned.delete(nextChunkId)
      totalArea += computeChunkArea(chunkMetricsByChunkId.get(nextChunkId))
    }

    const componentId = `component:${components.length + 1}`
    const sortedChunkIds = memberIds.slice().sort((a, b) => (chunkGraph.chunkIndexById.get(a) || 0) - (chunkGraph.chunkIndexById.get(b) || 0))
    for (const chunkId of sortedChunkIds) {
      componentIdByChunkId.set(chunkId, componentId)
    }
    components.push({
      componentId,
      componentIndex: components.length,
      chunkIds: sortedChunkIds
    })
  }

  return {
    components,
    componentIdByChunkId
  }
}

function buildComponentGraph(components, componentIdByChunkId, chunkGraph) {
  const componentById = new Map(components.map((component) => [component.componentId, component]))
  const outgoing = new Map(components.map((component) => [component.componentId, new Map()]))
  const incoming = new Map(components.map((component) => [component.componentId, new Map()]))

  for (const sourceChunkId of chunkGraph.chunkIds) {
    const sourceComponentId = componentIdByChunkId.get(sourceChunkId)
    for (const [targetChunkId, weight] of chunkGraph.outgoing.get(sourceChunkId)?.entries?.() || []) {
      const targetComponentId = componentIdByChunkId.get(targetChunkId)
      if (!sourceComponentId || !targetComponentId || sourceComponentId === targetComponentId) continue
      outgoing.get(sourceComponentId).set(targetComponentId, (outgoing.get(sourceComponentId).get(targetComponentId) || 0) + weight)
      incoming.get(targetComponentId).set(sourceComponentId, (incoming.get(targetComponentId).get(sourceComponentId) || 0) + weight)
    }
  }

  return {
    componentById,
    outgoing,
    incoming
  }
}

function addSymmetricWeight(weightMap, a, b, weight) {
  if (!a || !b || a === b || !Number.isFinite(weight) || weight <= 0) return
  if (!weightMap.has(a)) weightMap.set(a, new Map())
  if (!weightMap.has(b)) weightMap.set(b, new Map())
  weightMap.get(a).set(b, (weightMap.get(a).get(b) || 0) + weight)
  weightMap.get(b).set(a, (weightMap.get(b).get(a) || 0) + weight)
}

function buildInternalChunkWeights(component, chunkGraph, componentIdByChunkId) {
  const weightMap = new Map(component.chunkIds.map((chunkId) => [chunkId, new Map()]))
  for (const sourceChunkId of component.chunkIds) {
    for (const [targetChunkId, weight] of chunkGraph.outgoing.get(sourceChunkId)?.entries?.() || []) {
      if (componentIdByChunkId.get(targetChunkId) !== component.componentId) continue
      addSymmetricWeight(weightMap, sourceChunkId, targetChunkId, weight)
    }
  }
  return weightMap
}

function buildUndirectedComponentWeights(components, componentGraph) {
  const weightMap = new Map(components.map((component) => [component.componentId, new Map()]))
  for (const component of components) {
    for (const [targetComponentId, weight] of componentGraph.outgoing.get(component.componentId)?.entries?.() || []) {
      addSymmetricWeight(weightMap, component.componentId, targetComponentId, weight)
    }
  }
  return weightMap
}

function computeWeightedDegree(weightMap, itemId) {
  let total = 0
  for (const weight of weightMap.get(itemId)?.values?.() || []) {
    total += weight
  }
  return total
}

function computeRectsBounds(rects) {
  if (!rects.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
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

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  )
}

function rectCenter(rect) {
  return {
    x: rect.x + (rect.width / 2),
    y: rect.y + (rect.height / 2)
  }
}

function dedupeCandidateRects(candidates) {
  const seen = new Set()
  const deduped = []
  for (const candidate of candidates) {
    const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
  }
  return deduped
}

function generatePlacementCandidates(placedRects, size, gapX, gapY) {
  const width = Math.max(1, size?.width || 1)
  const height = Math.max(1, size?.height || 1)
  if (!placedRects.length) {
    return [{ x: 0, y: 0, width, height }]
  }

  const candidates = []
  const bounds = computeRectsBounds(placedRects)

  for (const rect of placedRects) {
    const centerY = Math.round(rect.y + ((rect.height - height) / 2))
    const centerX = Math.round(rect.x + ((rect.width - width) / 2))
    candidates.push({ x: rect.x + rect.width + gapX, y: rect.y, width, height })
    candidates.push({ x: rect.x - gapX - width, y: rect.y, width, height })
    candidates.push({ x: rect.x, y: rect.y + rect.height + gapY, width, height })
    candidates.push({ x: rect.x, y: rect.y - gapY - height, width, height })
    candidates.push({ x: rect.x + rect.width + gapX, y: centerY, width, height })
    candidates.push({ x: rect.x - gapX - width, y: centerY, width, height })
    candidates.push({ x: centerX, y: rect.y + rect.height + gapY, width, height })
    candidates.push({ x: centerX, y: rect.y - gapY - height, width, height })
    candidates.push({ x: rect.x + rect.width + gapX, y: rect.y + rect.height + gapY, width, height })
    candidates.push({ x: rect.x - gapX - width, y: rect.y + rect.height + gapY, width, height })
    candidates.push({ x: rect.x + rect.width + gapX, y: rect.y - gapY - height, width, height })
    candidates.push({ x: rect.x - gapX - width, y: rect.y - gapY - height, width, height })
  }

  candidates.push({ x: bounds.minX, y: bounds.minY - gapY - height, width, height })
  candidates.push({ x: bounds.minX, y: bounds.maxY + gapY, width, height })
  candidates.push({ x: bounds.minX - gapX - width, y: bounds.minY, width, height })
  candidates.push({ x: bounds.maxX + gapX, y: bounds.minY, width, height })
  candidates.push({ x: Math.round(bounds.minX + ((bounds.width - width) / 2)), y: bounds.minY - gapY - height, width, height })
  candidates.push({ x: Math.round(bounds.minX + ((bounds.width - width) / 2)), y: bounds.maxY + gapY, width, height })
  candidates.push({ x: bounds.minX - gapX - width, y: Math.round(bounds.minY + ((bounds.height - height) / 2)), width, height })
  candidates.push({ x: bounds.maxX + gapX, y: Math.round(bounds.minY + ((bounds.height - height) / 2)), width, height })

  return dedupeCandidateRects(candidates)
}

function computePlacementScore(candidate, placedRects, weightMap, itemId, options = {}) {
  const candidateCenter = rectCenter(candidate)
  const currentBounds = computeRectsBounds(placedRects)
  const nextBounds = computeRectsBounds(placedRects.concat(candidate))
  const compactAreaIncrease = (nextBounds.width * nextBounds.height) - (currentBounds.width * currentBounds.height)
  const compactnessPenalty = compactAreaIncrease * (options.compactnessWeight || 0.02)
  const aspectPenalty = Math.abs(nextBounds.width - nextBounds.height) * (options.aspectWeight || 0.18)
  const originPenalty = (Math.abs(candidateCenter.x) + Math.abs(candidateCenter.y)) * (options.originWeight || 0.35)

  let connectionCost = 0
  let connectedWeight = 0
  for (const rect of placedRects) {
    const weight = weightMap.get(itemId)?.get(rect.itemId) || 0
    if (!weight) continue
    const rectRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    const otherCenter = rectCenter(rectRect)
    const distance = Math.abs(candidateCenter.x - otherCenter.x) + Math.abs(candidateCenter.y - otherCenter.y)
    connectionCost += distance * weight
    connectedWeight += weight
  }

  let score = compactnessPenalty + aspectPenalty + originPenalty
  if (connectedWeight > 0) {
    score += connectionCost / connectedWeight
  } else {
    score += (nextBounds.width + nextBounds.height) * 0.4
  }

  if (typeof options.additionalPenalty === 'function') {
    score += options.additionalPenalty(candidate, candidateCenter)
  }

  return score
}

function placeRectanglesGreedy(itemIds, sizeById, weightMap, options = {}) {
  const gapX = Number.isFinite(options?.gapX) ? options.gapX : DEFAULT_PACKING_GAP_X
  const gapY = Number.isFinite(options?.gapY) ? options.gapY : DEFAULT_PACKING_GAP_Y
  const padding = Number.isFinite(options?.padding) ? options.padding : RECT_PADDING
  const placements = new Map()
  const placedRects = []

  const orderedIds = itemIds.slice().sort((a, b) => {
    const degreeDiff = computeWeightedDegree(weightMap, b) - computeWeightedDegree(weightMap, a)
    if (degreeDiff !== 0) return degreeDiff
    return String(a).localeCompare(String(b))
  })

  for (const itemId of orderedIds) {
    const size = sizeById.get(itemId) || { width: 1, height: 1 }
    const candidates = generatePlacementCandidates(placedRects, size, gapX, gapY)
    let bestCandidate = null
    let bestScore = Infinity

    for (const candidate of candidates) {
      const overlaps = placedRects.some((rect) => rectsOverlap(candidate, rect, padding))
      if (overlaps) continue
      const score = computePlacementScore(candidate, placedRects, weightMap, itemId, options)
      if (score < bestScore) {
        bestScore = score
        bestCandidate = candidate
      }
    }

    if (!bestCandidate) {
      const fallback = { x: 0, y: 0, width: size.width, height: size.height }
      const bounds = computeRectsBounds(placedRects)
      fallback.x = bounds.maxX + gapX
      fallback.y = bounds.minY
      bestCandidate = fallback
    }

    placements.set(itemId, { x: bestCandidate.x, y: bestCandidate.y })
    placedRects.push({ itemId, x: bestCandidate.x, y: bestCandidate.y, width: size.width, height: size.height })
  }

  compactPlacementsTowardOrigin(placements, sizeById, {
    gapX,
    gapY,
    padding,
    axisOrder: ['x', 'y'],
    passes: 4
  })

  return normalizePlacements(placements, sizeById)
}

function compactPlacementsTowardOrigin(placements, sizeById, options = {}) {
  const itemIds = Array.from(placements.keys())
  if (!itemIds.length) return placements

  const gapX = Number.isFinite(options?.gapX) ? options.gapX : DEFAULT_PACKING_GAP_X
  const gapY = Number.isFinite(options?.gapY) ? options.gapY : DEFAULT_PACKING_GAP_Y
  const padding = Number.isFinite(options?.padding) ? options.padding : RECT_PADDING
  const axisOrder = Array.isArray(options?.axisOrder) && options.axisOrder.length ? options.axisOrder : ['x', 'y']
  const passes = Number.isFinite(options?.passes) ? Math.max(1, Math.trunc(options.passes)) : 3

  function buildRect(itemId, proposal = null) {
    const pos = proposal || placements.get(itemId) || { x: 0, y: 0 }
    const size = sizeById.get(itemId) || { width: 1, height: 1 }
    return { x: pos.x, y: pos.y, width: size.width, height: size.height }
  }

  function candidateAxisValues(itemId, axis) {
    const values = [0]
    for (const otherId of itemIds) {
      if (otherId === itemId) continue
      const otherPos = placements.get(otherId)
      if (!otherPos) continue
      const otherSize = sizeById.get(otherId) || { width: 1, height: 1 }
      if (axis === 'x') {
        values.push(otherPos.x + otherSize.width + gapX)
      } else {
        values.push(otherPos.y + otherSize.height + gapY)
      }
    }
    return Array.from(new Set(values.filter((value) => Number.isFinite(value)).map((value) => Math.max(0, Math.round(value))))).sort((a, b) => a - b)
  }

  function overlapsAny(itemId, proposal) {
    const proposalRect = buildRect(itemId, proposal)
    for (const otherId of itemIds) {
      if (otherId === itemId) continue
      const otherPos = placements.get(otherId)
      if (!otherPos) continue
      if (rectsOverlap(proposalRect, buildRect(otherId), padding)) return true
    }
    return false
  }

  for (let pass = 0; pass < passes; pass++) {
    const orderedIds = itemIds.slice().sort((a, b) => {
      const aPos = placements.get(a) || { x: 0, y: 0 }
      const bPos = placements.get(b) || { x: 0, y: 0 }
      if (aPos.y !== bPos.y) return aPos.y - bPos.y
      if (aPos.x !== bPos.x) return aPos.x - bPos.x
      return String(a).localeCompare(String(b))
    })

    for (const axis of axisOrder) {
      for (const itemId of orderedIds) {
        const current = placements.get(itemId)
        if (!current) continue
        const values = candidateAxisValues(itemId, axis)
        let bestValue = axis === 'x' ? current.x : current.y

        for (const candidateValue of values) {
          if (candidateValue > bestValue) break
          const proposal = axis === 'x'
            ? { x: candidateValue, y: current.y }
            : { x: current.x, y: candidateValue }
          if (overlapsAny(itemId, proposal)) continue
          bestValue = candidateValue
          break
        }

        if (axis === 'x' && bestValue !== current.x) current.x = bestValue
        if (axis === 'y' && bestValue !== current.y) current.y = bestValue
      }
    }
  }

  return placements
}

function getTotalRectArea(itemIds, sizeById) {
  let total = 0
  for (const itemId of itemIds) {
    const size = sizeById.get(itemId) || { width: 1, height: 1 }
    total += Math.max(1, size.width) * Math.max(1, size.height)
  }
  return total
}

function computeConnectionCostForPlacement(itemId, position, size, placements, sizeById, weightMap) {
  const centerX = position.x + (size.width / 2)
  const centerY = position.y + (size.height / 2)
  let connectionCost = 0
  let connectedWeight = 0

  for (const [otherId, weight] of weightMap.get(itemId)?.entries?.() || []) {
    if (!weight) continue
    const otherPos = placements.get(otherId)
    const otherSize = sizeById.get(otherId) || { width: 1, height: 1 }
    if (!otherPos) continue
    const otherCenterX = otherPos.x + (otherSize.width / 2)
    const otherCenterY = otherPos.y + (otherSize.height / 2)
    const distance = Math.abs(centerX - otherCenterX) + Math.abs(centerY - otherCenterY)
    connectionCost += distance * weight
    connectedWeight += weight
  }

  return connectedWeight > 0 ? (connectionCost / connectedWeight) : 0
}

function computeCompactNeighborhoodScore(candidate, placedRects, placements, itemId, sizeById, weightMap) {
  const size = { width: candidate.width, height: candidate.height }
  const rectsWithCandidate = placedRects.concat(candidate)
  const bounds = computeRectsBounds(rectsWithCandidate)
  const usedArea = rectsWithCandidate.reduce((total, rect) => total + (rect.width * rect.height), 0)
  const wastedArea = Math.max(0, (bounds.width * bounds.height) - usedArea)
  const aspectPenalty = Math.max(bounds.width, bounds.height) / Math.max(1, Math.min(bounds.width, bounds.height))
  const center = rectCenter(candidate)
  const originPenalty = (Math.abs(center.x) + Math.abs(center.y)) * 0.04

  let sharedAxisPenalty = 0
  let touchingWeight = 0
  for (const rect of placedRects) {
    const weight = weightMap.get(itemId)?.get(rect.itemId) || 0
    if (!weight) continue
    const xAligned = candidate.x === rect.x || (candidate.x + candidate.width) === (rect.x + rect.width)
    const yAligned = candidate.y === rect.y || (candidate.y + candidate.height) === (rect.y + rect.height)
    if (!xAligned && !yAligned) sharedAxisPenalty += 18 * weight
    if (
      candidate.x === rect.x + rect.width + Math.max(1, Math.round(DEFAULT_COMPONENT_MEMBER_GAP * 0.34)) ||
      candidate.y === rect.y + rect.height + Math.max(1, Math.round(DEFAULT_COMPONENT_MEMBER_GAP * 0.28))
    ) {
      touchingWeight += weight
    }
  }

  const connectionPenalty = computeConnectionCostForPlacement(itemId, candidate, size, placements, sizeById, weightMap)
  return (
    connectionPenalty +
    (wastedArea * 0.0038) +
    (Math.abs(bounds.width - bounds.height) * 0.16) +
    (aspectPenalty * 42) +
    sharedAxisPenalty +
    originPenalty -
    (touchingWeight * 12)
  )
}

function chooseCompactPlacementOrder(itemIds, weightMap, sizeById) {
  const ordered = []
  const remaining = new Set(itemIds)
  const sortedSeedIds = itemIds.slice().sort((a, b) => {
    const degreeDiff = computeWeightedDegree(weightMap, b) - computeWeightedDegree(weightMap, a)
    if (degreeDiff !== 0) return degreeDiff
    const areaDiff = computeChunkArea(sizeById.get(b)) - computeChunkArea(sizeById.get(a))
    if (areaDiff !== 0) return areaDiff
    return String(a).localeCompare(String(b))
  })

  const seedId = sortedSeedIds[0]
  if (seedId) {
    ordered.push(seedId)
    remaining.delete(seedId)
  }

  while (remaining.size) {
    const nextId = Array.from(remaining).sort((a, b) => {
      let aWeight = 0
      let bWeight = 0
      for (const placedId of ordered) {
        aWeight += weightMap.get(a)?.get(placedId) || 0
        bWeight += weightMap.get(b)?.get(placedId) || 0
      }
      if (bWeight !== aWeight) return bWeight - aWeight
      const degreeDiff = computeWeightedDegree(weightMap, b) - computeWeightedDegree(weightMap, a)
      if (degreeDiff !== 0) return degreeDiff
      return String(a).localeCompare(String(b))
    })[0]
    ordered.push(nextId)
    remaining.delete(nextId)
  }

  return ordered
}

function refineCompactPlacements(placements, sizeById, weightMap, options = {}) {
  const gapX = Number.isFinite(options?.gapX) ? options.gapX : Math.max(24, Math.round(DEFAULT_COMPONENT_MEMBER_GAP * 0.34))
  const gapY = Number.isFinite(options?.gapY) ? options.gapY : Math.max(20, Math.round(DEFAULT_COMPONENT_MEMBER_GAP * 0.28))
  const padding = Number.isFinite(options?.padding) ? options.padding : RECT_PADDING
  const itemIds = Array.from(placements.keys())

  for (let pass = 0; pass < 5; pass++) {
    let moved = false
    const orderedIds = itemIds.slice().sort((a, b) => {
      const degreeDiff = computeWeightedDegree(weightMap, a) - computeWeightedDegree(weightMap, b)
      if (degreeDiff !== 0) return degreeDiff
      return String(a).localeCompare(String(b))
    })

    for (const itemId of orderedIds) {
      const size = sizeById.get(itemId) || { width: 1, height: 1 }
      const current = placements.get(itemId) || { x: 0, y: 0 }
      const otherRects = itemIds
        .filter((otherId) => otherId !== itemId)
        .map((otherId) => {
          const otherPos = placements.get(otherId) || { x: 0, y: 0 }
          const otherSize = sizeById.get(otherId) || { width: 1, height: 1 }
          return { itemId: otherId, x: otherPos.x, y: otherPos.y, width: otherSize.width, height: otherSize.height }
        })
      const candidates = generatePlacementCandidates(otherRects, size, gapX, gapY)
      let bestPosition = current
      let bestScore = computeCompactNeighborhoodScore({ x: current.x, y: current.y, width: size.width, height: size.height }, otherRects, placements, itemId, sizeById, weightMap)

      for (const candidate of candidates) {
        if (otherRects.some((rect) => rectsOverlap(candidate, rect, padding))) continue
        const score = computeCompactNeighborhoodScore(candidate, otherRects, placements, itemId, sizeById, weightMap)
        if (score + 1 < bestScore) {
          bestScore = score
          bestPosition = { x: candidate.x, y: candidate.y }
        }
      }

      if (bestPosition.x !== current.x || bestPosition.y !== current.y) {
        placements.set(itemId, bestPosition)
        moved = true
      }
    }

    if (!moved) break
  }

  compactPlacementsTowardOrigin(placements, sizeById, {
    gapX,
    gapY,
    padding,
    axisOrder: ['x', 'y'],
    passes: 6
  })

  return placements
}

function placeRectanglesCompactNeighborhood(itemIds, sizeById, weightMap, options = {}) {
  const gapX = Number.isFinite(options?.gapX) ? options.gapX : Math.max(24, Math.round(DEFAULT_COMPONENT_MEMBER_GAP * 0.34))
  const gapY = Number.isFinite(options?.gapY) ? options.gapY : Math.max(20, Math.round(DEFAULT_COMPONENT_MEMBER_GAP * 0.28))
  const padding = Number.isFinite(options?.padding) ? options.padding : RECT_PADDING
  const placements = new Map()
  const placedRects = []
  const orderedIds = chooseCompactPlacementOrder(itemIds, weightMap, sizeById)

  for (const itemId of orderedIds) {
    const size = sizeById.get(itemId) || { width: 1, height: 1 }
    if (!placedRects.length) {
      placements.set(itemId, { x: 0, y: 0 })
      placedRects.push({ itemId, x: 0, y: 0, width: size.width, height: size.height })
      continue
    }

    const candidates = generatePlacementCandidates(placedRects, size, gapX, gapY)
    let bestCandidate = null
    let bestScore = Infinity
    for (const candidate of candidates) {
      if (placedRects.some((rect) => rectsOverlap(candidate, rect, padding))) continue
      const score = computeCompactNeighborhoodScore(candidate, placedRects, placements, itemId, sizeById, weightMap)
      if (score < bestScore) {
        bestScore = score
        bestCandidate = candidate
      }
    }

    if (!bestCandidate) {
      const bounds = computeRectsBounds(placedRects)
      bestCandidate = { x: bounds.maxX + gapX, y: bounds.minY, width: size.width, height: size.height }
    }

    const position = { x: bestCandidate.x, y: bestCandidate.y }
    placements.set(itemId, position)
    placedRects.push({ itemId, x: position.x, y: position.y, width: size.width, height: size.height })
  }

  refineCompactPlacements(placements, sizeById, weightMap, { gapX, gapY, padding })
  return normalizePlacements(placements, sizeById)
}

function computeInternalDegreeStats(chunkIds, weightMap) {
  let internalEdgeCount = 0
  let lowDegreeCount = 0
  let branchingCount = 0
  let leafCount = 0
  for (const chunkId of chunkIds) {
    const degree = weightMap.get(chunkId)?.size || 0
    internalEdgeCount += degree
    if (degree <= 2) lowDegreeCount += 1
    if (degree >= 3) branchingCount += 1
    if (degree <= 1) leafCount += 1
  }
  return {
    internalEdgeCount: internalEdgeCount / 2,
    lowDegreeCount,
    branchingCount,
    leafCount
  }
}

function classifyComponentPackingMode(component, chunkMetricsByChunkId, weightMap) {
  const chunkIds = Array.isArray(component?.chunkIds) ? component.chunkIds : []
  if (chunkIds.length <= 1) return 'singleton'

  let totalArea = 0
  let maxSpan = 0
  let connectedMembers = 0
  for (const chunkId of chunkIds) {
    const size = chunkMetricsByChunkId.get(chunkId) || { width: 1, height: 1 }
    totalArea += Math.max(1, size.width) * Math.max(1, size.height)
    maxSpan = Math.max(maxSpan, size.width, size.height)
    if ((weightMap.get(chunkId)?.size || 0) > 0) connectedMembers += 1
  }

  const avgArea = totalArea / Math.max(1, chunkIds.length)
  const degreeStats = computeInternalDegreeStats(chunkIds, weightMap)
  const mostlyChainLike = (
    chunkIds.length >= 3 &&
    chunkIds.length <= 14 &&
    degreeStats.branchingCount <= 1 &&
    degreeStats.leafCount >= 2 &&
    degreeStats.lowDegreeCount >= Math.max(2, chunkIds.length - 1) &&
    degreeStats.internalEdgeCount <= chunkIds.length
  )
  if (mostlyChainLike) return 'chain'

  if (chunkIds.length <= SMALL_COMPONENT_MAX_ITEMS && avgArea <= SMALL_COMPONENT_MAX_AVG_RECT_AREA && maxSpan <= SMALL_COMPONENT_MAX_RECT_SPAN) {
    if (connectedMembers >= Math.max(2, Math.floor(chunkIds.length * 0.4))) return 'compactSmall'
  }
  return 'force'
}

function normalizePlacements(placements, sizeById) {
  const rects = []
  for (const [itemId, position] of placements.entries()) {
    const size = sizeById.get(itemId) || { width: 1, height: 1 }
    rects.push({ x: position.x, y: position.y, width: size.width, height: size.height })
  }
  const bounds = computeRectsBounds(rects)
  const normalized = new Map()
  for (const [itemId, position] of placements.entries()) {
    normalized.set(itemId, {
      x: position.x - bounds.minX,
      y: position.y - bounds.minY
    })
  }
  return normalized
}


function clampSigned(value, maxMagnitude) {
  if (!Number.isFinite(value)) return 0
  if (value > maxMagnitude) return maxMagnitude
  if (value < -maxMagnitude) return -maxMagnitude
  return value
}

function placeRectanglesWithForce(itemIds, sizeById, weightMap, options = {}) {
  const gapX = Number.isFinite(options?.gapX) ? options.gapX : DEFAULT_PACKING_GAP_X
  const gapY = Number.isFinite(options?.gapY) ? options.gapY : DEFAULT_PACKING_GAP_Y
  const iterations = Number.isFinite(options?.iterations) ? Math.max(10, Math.trunc(options.iterations)) : 110
  const repulsionWeight = Number.isFinite(options?.repulsionWeight) ? options.repulsionWeight : 2600
  const attractionScale = Number.isFinite(options?.attractionScale) ? options.attractionScale : 0.018
  const directionScale = Number.isFinite(options?.directionScale) ? options.directionScale : 0.028
  const orderedIds = itemIds.slice().sort((a, b) => {
    const degreeDiff = computeWeightedDegree(weightMap, b) - computeWeightedDegree(weightMap, a)
    if (degreeDiff !== 0) return degreeDiff
    return String(a).localeCompare(String(b))
  })
  const centers = new Map()
  const baseRadius = Math.max(gapX, gapY) * 1.35
  const goldenAngle = 2.399963229728653

  for (let index = 0; index < orderedIds.length; index++) {
    const itemId = orderedIds[index]
    if (index === 0) {
      centers.set(itemId, { x: 0, y: 0 })
      continue
    }
    const angle = index * goldenAngle
    const radius = Math.sqrt(index) * baseRadius
    centers.set(itemId, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    })
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    const forces = new Map(orderedIds.map((itemId) => [itemId, { x: 0, y: 0 }]))

    for (let leftIndex = 0; leftIndex < orderedIds.length; leftIndex++) {
      const leftId = orderedIds[leftIndex]
      const leftCenter = centers.get(leftId)
      const leftSize = sizeById.get(leftId) || { width: 1, height: 1 }
      if (!leftCenter) continue

      for (let rightIndex = leftIndex + 1; rightIndex < orderedIds.length; rightIndex++) {
        const rightId = orderedIds[rightIndex]
        const rightCenter = centers.get(rightId)
        const rightSize = sizeById.get(rightId) || { width: 1, height: 1 }
        if (!rightCenter) continue

        let dx = rightCenter.x - leftCenter.x
        let dy = rightCenter.y - leftCenter.y
        let distance = Math.hypot(dx, dy)
        if (distance < 1) {
          dx = 0.001 * (rightIndex - leftIndex + 1)
          dy = 0.001 * (leftIndex + rightIndex + 1)
          distance = Math.hypot(dx, dy)
        }
        const unitX = dx / distance
        const unitY = dy / distance
        const desiredX = ((leftSize.width + rightSize.width) / 2) + gapX
        const desiredY = ((leftSize.height + rightSize.height) / 2) + gapY
        const overlapX = desiredX - Math.abs(dx)
        const overlapY = desiredY - Math.abs(dy)

        let pushMagnitude = repulsionWeight / ((distance * distance) + 400)
        if (overlapX > 0 && overlapY > 0) {
          pushMagnitude += (Math.max(overlapX, overlapY) * 0.35) + 4
        }

        forces.get(leftId).x -= unitX * pushMagnitude
        forces.get(leftId).y -= unitY * pushMagnitude
        forces.get(rightId).x += unitX * pushMagnitude
        forces.get(rightId).y += unitY * pushMagnitude
      }
    }

    const seenPairs = new Set()
    for (const itemId of orderedIds) {
      for (const [otherId, rawWeight] of weightMap.get(itemId)?.entries?.() || []) {
        const weight = Math.min(rawWeight, 16)
        const pairKey = String(itemId) < String(otherId) ? `${itemId}|${otherId}` : `${otherId}|${itemId}`
        if (seenPairs.has(pairKey)) continue
        seenPairs.add(pairKey)

        const leftCenter = centers.get(itemId)
        const rightCenter = centers.get(otherId)
        const leftSize = sizeById.get(itemId) || { width: 1, height: 1 }
        const rightSize = sizeById.get(otherId) || { width: 1, height: 1 }
        if (!leftCenter || !rightCenter || !weight) continue

        let dx = rightCenter.x - leftCenter.x
        let dy = rightCenter.y - leftCenter.y
        let distance = Math.hypot(dx, dy)
        if (distance < 1) distance = 1
        const unitX = dx / distance
        const unitY = dy / distance
        const idealDistance = Math.max(
          ((leftSize.width + rightSize.width) / 2) + (gapX * 0.45),
          ((leftSize.height + rightSize.height) / 2) + (gapY * 0.45)
        )
        const pullMagnitude = (distance - idealDistance) * attractionScale * weight
        forces.get(itemId).x += unitX * pullMagnitude
        forces.get(itemId).y += unitY * pullMagnitude
        forces.get(otherId).x -= unitX * pullMagnitude
        forces.get(otherId).y -= unitY * pullMagnitude
      }
    }

    if (options?.directedGraph) {
      const flowGap = Number.isFinite(options?.flowGap) ? options.flowGap : (gapX * 0.7)
      for (const sourceId of orderedIds) {
        for (const [targetId, rawWeight] of options.directedGraph.outgoing.get(sourceId)?.entries?.() || []) {
          const weight = Math.min(rawWeight, 12)
          const sourceCenter = centers.get(sourceId)
          const targetCenter = centers.get(targetId)
          if (!sourceCenter || !targetCenter || !weight) continue
          const currentDx = targetCenter.x - sourceCenter.x
          if (currentDx >= flowGap) continue
          const push = (flowGap - currentDx) * directionScale * weight
          forces.get(sourceId).x -= push
          forces.get(targetId).x += push
        }
      }
    }

    const maxStep = Math.max(6, 30 - (iteration * 0.18))
    for (const itemId of orderedIds) {
      const force = forces.get(itemId) || { x: 0, y: 0 }
      const center = centers.get(itemId)
      if (!center) continue
      center.x += clampSigned(force.x, maxStep)
      center.y += clampSigned(force.y, maxStep)
    }
  }

  const placements = new Map()
  for (const itemId of orderedIds) {
    const center = centers.get(itemId) || { x: 0, y: 0 }
    const size = sizeById.get(itemId) || { width: 1, height: 1 }
    placements.set(itemId, {
      x: Math.round(center.x - (size.width / 2)),
      y: Math.round(center.y - (size.height / 2))
    })
  }

  const relaxed = normalizePlacements(placements, sizeById)
  relaxRectPlacementOverlaps(relaxed, sizeById, gapX, gapY)
  return normalizePlacements(relaxed, sizeById)
}

function relaxRectPlacementOverlaps(placements, sizeById, gapX, gapY) {
  const itemIds = Array.from(placements.keys())
  const separationPadding = Math.max(16, Math.round(Math.min(gapX, gapY) * 0.5))

  for (let iteration = 0; iteration < 24; iteration++) {
    let moved = false
    for (let leftIndex = 0; leftIndex < itemIds.length; leftIndex++) {
      const leftId = itemIds[leftIndex]
      const leftPos = placements.get(leftId)
      const leftSize = sizeById.get(leftId) || { width: 1, height: 1 }
      if (!leftPos) continue
      const leftRect = { x: leftPos.x, y: leftPos.y, width: leftSize.width, height: leftSize.height }
      const leftCenter = rectCenter(leftRect)

      for (let rightIndex = leftIndex + 1; rightIndex < itemIds.length; rightIndex++) {
        const rightId = itemIds[rightIndex]
        const rightPos = placements.get(rightId)
        const rightSize = sizeById.get(rightId) || { width: 1, height: 1 }
        if (!rightPos) continue
        const rightRect = { x: rightPos.x, y: rightPos.y, width: rightSize.width, height: rightSize.height }
        if (!rectsOverlap(leftRect, rightRect, separationPadding)) continue

        const rightCenter = rectCenter(rightRect)
        let dx = rightCenter.x - leftCenter.x
        let dy = rightCenter.y - leftCenter.y
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
          dx = rightIndex - leftIndex + 1
          dy = leftIndex + rightIndex + 1
        }
        const pushX = (leftRect.width + rightRect.width) / 2 + separationPadding - Math.abs(dx)
        const pushY = (leftRect.height + rightRect.height) / 2 + separationPadding - Math.abs(dy)
        if (pushX <= 0 && pushY <= 0) continue

        if (pushX >= pushY) {
          const delta = Math.ceil(pushX / 2)
          leftPos.x -= dx >= 0 ? delta : -delta
          rightPos.x += dx >= 0 ? delta : -delta
        } else {
          const delta = Math.ceil(pushY / 2)
          leftPos.y -= dy >= 0 ? delta : -delta
          rightPos.y += dy >= 0 ? delta : -delta
        }
        moved = true
      }
    }
    if (!moved) break
  }
}

function relaxComponentPlacements(placements, sizeById, weightMap, componentGraph, passes = MAX_RELAX_PASSES) {
  const componentIds = Array.from(placements.keys())
  for (let pass = 0; pass < passes; pass++) {
    let moved = false
    for (const componentId of componentIds) {
      const current = placements.get(componentId)
      const size = sizeById.get(componentId) || { width: 1, height: 1 }
      if (!current) continue

      let pullX = 0
      let pullY = 0
      let totalWeight = 0

      for (const [otherComponentId, weight] of weightMap.get(componentId)?.entries?.() || []) {
        const other = placements.get(otherComponentId)
        const otherSize = sizeById.get(otherComponentId) || { width: 1, height: 1 }
        if (!other || !weight) continue
        const currentCenterX = current.x + (size.width / 2)
        const currentCenterY = current.y + (size.height / 2)
        const otherCenterX = other.x + (otherSize.width / 2)
        const otherCenterY = other.y + (otherSize.height / 2)
        pullX += (otherCenterX - currentCenterX) * weight
        pullY += (otherCenterY - currentCenterY) * weight
        totalWeight += weight
      }

      if (!totalWeight) continue

      let nextX = current.x + Math.round((pullX / totalWeight) * 0.18)
      let nextY = current.y + Math.round((pullY / totalWeight) * 0.18)

      for (const [sourceComponentId, weight] of componentGraph.incoming.get(componentId)?.entries?.() || []) {
        const sourcePlacement = placements.get(sourceComponentId)
        const sourceSize = sizeById.get(sourceComponentId) || { width: 1, height: 1 }
        if (!sourcePlacement || !weight) continue
        const sourceCenterX = sourcePlacement.x + (sourceSize.width / 2)
        const nextCenterX = nextX + (size.width / 2)
        if (nextCenterX <= sourceCenterX) {
          nextX += Math.round((sourceCenterX - nextCenterX + 1) * 0.2)
        }
      }
      for (const [targetComponentId, weight] of componentGraph.outgoing.get(componentId)?.entries?.() || []) {
        const targetPlacement = placements.get(targetComponentId)
        const targetSize = sizeById.get(targetComponentId) || { width: 1, height: 1 }
        if (!targetPlacement || !weight) continue
        const targetCenterX = targetPlacement.x + (targetSize.width / 2)
        const nextCenterX = nextX + (size.width / 2)
        if (nextCenterX >= targetCenterX) {
          nextX -= Math.round((nextCenterX - targetCenterX + 1) * 0.2)
        }
      }

      const proposal = { x: nextX, y: nextY, width: size.width, height: size.height }
      const overlaps = componentIds.some((otherComponentId) => {
        if (otherComponentId === componentId) return false
        const other = placements.get(otherComponentId)
        const otherSize = sizeById.get(otherComponentId) || { width: 1, height: 1 }
        if (!other) return false
        return rectsOverlap(proposal, { x: other.x, y: other.y, width: otherSize.width, height: otherSize.height }, RECT_PADDING)
      })
      if (overlaps) continue
      if (proposal.x === current.x && proposal.y === current.y) continue
      placements.set(componentId, { x: proposal.x, y: proposal.y })
      moved = true
    }
    if (!moved) break
  }
}

function computeChunkRecordMetrics(chunkRecords) {
  const metricsByChunkId = new Map()
  for (const record of Array.isArray(chunkRecords) ? chunkRecords : []) {
    const chunkId = record?.chunk?.chunkId
    if (!chunkId) continue
    metricsByChunkId.set(chunkId, {
      width: computeChunkBounds(record?.built?.nodes).width || 1,
      height: computeChunkBounds(record?.built?.nodes).height || 1
    })
  }
  return metricsByChunkId
}

function computeComponentLayouts(components, chunkGraph, componentIdByChunkId, chunkMetricsByChunkId, options = {}) {
  const componentLayoutsById = new Map()
  const memberGap = Number.isFinite(options?.memberGap) ? options.memberGap : DEFAULT_COMPONENT_MEMBER_GAP

  for (const component of components) {
    const internalWeightMap = buildInternalChunkWeights(component, chunkGraph, componentIdByChunkId)
    const packingMode = classifyComponentPackingMode(component, chunkMetricsByChunkId, internalWeightMap)
    let memberPlacements

    if (packingMode === 'compactSmall') {
      memberPlacements = placeRectanglesCompactNeighborhood(component.chunkIds, chunkMetricsByChunkId, internalWeightMap, {
        gapX: Math.max(18, Math.round(memberGap * 0.3)),
        gapY: Math.max(16, Math.round(memberGap * 0.24)),
        padding: Math.max(6, Math.round(RECT_PADDING * 0.7))
      })
    } else if (packingMode === 'chain') {
      memberPlacements = placeRectanglesGreedy(component.chunkIds, chunkMetricsByChunkId, internalWeightMap, {
        gapX: Math.max(28, Math.round(memberGap * 0.38)),
        gapY: Math.max(24, Math.round(memberGap * 0.28)),
        padding: Math.max(6, Math.round(RECT_PADDING * 0.75)),
        compactnessWeight: 0.018,
        aspectWeight: 0.12,
        originWeight: 0.1,
        additionalPenalty: (candidate) => Math.max(0, Math.abs(candidate.y) - Math.abs(candidate.x) * 0.45) * 0.08
      })
    } else {
      memberPlacements = placeRectanglesWithForce(component.chunkIds, chunkMetricsByChunkId, internalWeightMap, {
        gapX: memberGap,
        gapY: memberGap,
        iterations: 80,
        repulsionWeight: 2400,
        attractionScale: 0.022
      })
    }

    const memberRects = component.chunkIds.map((chunkId) => {
      const pos = memberPlacements.get(chunkId) || { x: 0, y: 0 }
      const size = chunkMetricsByChunkId.get(chunkId) || { width: 1, height: 1 }
      return {
        chunkId,
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height
      }
    })
    const bounds = computeRectsBounds(memberRects)

    componentLayoutsById.set(component.componentId, {
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
      packingMode,
      memberOffsets: memberRects.map((rect) => ({
        chunkId: rect.chunkId,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }))
    })
  }

  return componentLayoutsById
}

function computeGlobalComponentPlacements(components, componentGraph, componentLayoutsById, options = {}) {
  const gapX = Number.isFinite(options?.gapX) ? options.gapX : DEFAULT_PACKING_GAP_X
  const gapY = Number.isFinite(options?.gapY) ? options.gapY : DEFAULT_PACKING_GAP_Y
  const componentSizeById = new Map()
  for (const component of components) {
    const layout = componentLayoutsById.get(component.componentId)
    componentSizeById.set(component.componentId, {
      width: layout?.width || 1,
      height: layout?.height || 1
    })
  }

  const weightMap = buildUndirectedComponentWeights(components, componentGraph)
  return placeRectanglesWithForce(
    components.map((component) => component.componentId),
    componentSizeById,
    weightMap,
    {
      gapX,
      gapY,
      iterations: 120,
      repulsionWeight: 3200,
      attractionScale: 0.02,
      directionScale: 0.03,
      directedGraph: componentGraph,
      flowGap: gapX * 0.8
    }
  )
}

function mergeChunkPlacements(components, componentLayoutsById, componentPlacementsById) {
  const placementByChunkId = new Map()
  for (const component of components) {
    const componentPlacement = componentPlacementsById.get(component.componentId) || { x: 0, y: 0 }
    const componentLayout = componentLayoutsById.get(component.componentId)
    if (!componentLayout) continue
    for (const member of componentLayout.memberOffsets) {
      placementByChunkId.set(member.chunkId, {
        x: componentPlacement.x + member.x,
        y: componentPlacement.y + member.y
      })
    }
  }
  return placementByChunkId
}

function chooseChunkRouteSides(sourceNode, targetNode, sourceBounds, targetBounds, edge) {
  if (!sourceNode || !targetNode) {
    throw new Error(`Graph edge ${describeEdge(edge)} could not resolve source/target nodes for cross-chunk routing`)
  }

  if (targetBounds.minX >= sourceBounds.maxX) {
    return { sourceSide: 'right', targetSide: 'left' }
  }
  if (sourceBounds.minX >= targetBounds.maxX) {
    return { sourceSide: 'left', targetSide: 'right' }
  }
  if (targetBounds.minY >= sourceBounds.maxY) {
    return { sourceSide: 'bottom', targetSide: 'top' }
  }
  if (sourceBounds.minY >= targetBounds.maxY) {
    return { sourceSide: 'top', targetSide: 'bottom' }
  }

  const sourceNodeBounds = getNodeBounds(sourceNode)
  const targetNodeBounds = getNodeBounds(targetNode)
  const sourceCenter = getNodeCenter(sourceNodeBounds)
  const targetCenter = getNodeCenter(targetNodeBounds)
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y
  const preferVertical = edge?.kind === 'fallthrough'
    ? Math.abs(dy) >= Math.max(16, Math.abs(dx) * 0.5)
    : Math.abs(dy) > Math.max(24, Math.abs(dx) * 1.1)

  if (preferVertical) {
    return dy >= 0
      ? { sourceSide: 'bottom', targetSide: 'top' }
      : { sourceSide: 'top', targetSide: 'bottom' }
  }

  return dx >= 0
    ? { sourceSide: 'right', targetSide: 'left' }
    : { sourceSide: 'left', targetSide: 'right' }
}

function getForcedSideAnchor(node, edge, sideRole, forcedSide) {
  if (!node || !edge) {
    throw new Error(`Cross-chunk routing could not resolve ${sideRole} anchor inputs`)
  }

  const x = Number.isFinite(node?.position?.x) ? node.position.x : 0
  const y = Number.isFinite(node?.position?.y) ? node.position.y : 0
  const width = Number.isFinite(node?.width) ? node.width : 0
  const height = Number.isFinite(node?.height) ? node.height : 0
  const lineCount = Array.isArray(node?.data?.lines) ? node.data.lines.length : 0
  const lineIndex = sideRole === 'source' ? edge?.sourceLineIndex : edge?.targetLineIndex
  const centerY = y + requireGraphLineCenter(lineIndex, lineCount, edge, sideRole)
  const centerX = x + (width / 2)

  if (forcedSide === 'right') return { x: x + width, y: centerY }
  if (forcedSide === 'left') return { x, y: centerY }
  if (forcedSide === 'top') return { x: centerX, y }
  if (forcedSide === 'bottom') return { x: centerX, y: y + height }
  throw new Error(`Graph edge ${describeEdge(edge)} requested unsupported forced side ${String(forcedSide)}`)
}

function laneOffsetForGroup(index, total) {
  return Math.round((index - ((total - 1) / 2)) * ROUTE_LANE_SPACING)
}

function buildCrossChunkRouteHints(edgeById, chunkGraph, chunkBoundsById, nodesById) {
  const specs = []
  const groups = new Map()

  for (const edge of edgeById?.values?.() || []) {
    const sourceChunkId = chunkGraph.nodeToChunkId.get(edge?.source)
    const targetChunkId = chunkGraph.nodeToChunkId.get(edge?.target)
    if (!sourceChunkId || !targetChunkId || sourceChunkId === targetChunkId) continue
    const sourceBounds = chunkBoundsById.get(sourceChunkId)
    const targetBounds = chunkBoundsById.get(targetChunkId)
    const sourceNode = nodesById.get(edge?.source) || null
    const targetNode = nodesById.get(edge?.target) || null
    if (!sourceBounds || !targetBounds) {
      throw new Error(`Graph edge ${describeEdge(edge)} is missing cross-chunk bounds during route hint construction`)
    }
    if (!sourceNode || !targetNode) {
      throw new Error(`Graph edge ${describeEdge(edge)} is missing cross-chunk nodes during route hint construction`)
    }
    const { sourceSide, targetSide } = chooseChunkRouteSides(sourceNode, targetNode, sourceBounds, targetBounds, edge)
    const spec = {
      edge,
      sourceChunkId,
      targetChunkId,
      sourceSide,
      targetSide,
      laneOffset: 0
    }
    specs.push(spec)
    const groupKey = `${sourceChunkId}|${targetChunkId}|${sourceSide}|${targetSide}`
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push(spec)
  }

  for (const group of groups.values()) {
    group.sort((a, b) => {
      const aSourceLine = Number.isFinite(a.edge?.sourceLineIndex) ? a.edge.sourceLineIndex : Number.MAX_SAFE_INTEGER
      const bSourceLine = Number.isFinite(b.edge?.sourceLineIndex) ? b.edge.sourceLineIndex : Number.MAX_SAFE_INTEGER
      if (aSourceLine !== bSourceLine) return aSourceLine - bSourceLine
      const aTargetLine = Number.isFinite(a.edge?.targetLineIndex) ? a.edge.targetLineIndex : Number.MAX_SAFE_INTEGER
      const bTargetLine = Number.isFinite(b.edge?.targetLineIndex) ? b.edge.targetLineIndex : Number.MAX_SAFE_INTEGER
      if (aTargetLine !== bTargetLine) return aTargetLine - bTargetLine
      return String(a.edge?.id || '').localeCompare(String(b.edge?.id || ''))
    })
    let maxAbsLaneOffset = 0
    for (let index = 0; index < group.length; index++) {
      group[index].laneOffset = laneOffsetForGroup(index, group.length)
      maxAbsLaneOffset = Math.max(maxAbsLaneOffset, Math.abs(group[index].laneOffset))
    }
    for (const spec of group) {
      spec.maxAbsLaneOffset = maxAbsLaneOffset
    }
  }

  return specs
}

function buildCrossChunkEdge(edge, nodesById, chunkBoundsById, routeHint) {
  if (!edge) return null
  const sourceNode = nodesById.get(edge.source)
  const targetNode = nodesById.get(edge.target)
  if (!sourceNode || !targetNode) {
    throw new Error(`Graph edge ${describeEdge(edge)} is missing cross-chunk source/target nodes`)
  }

  const sourceBounds = chunkBoundsById.get(routeHint?.sourceChunkId)
  const targetBounds = chunkBoundsById.get(routeHint?.targetChunkId)
  if (!sourceBounds || !targetBounds) {
    throw new Error(`Graph edge ${describeEdge(edge)} is missing cross-chunk source/target bounds`)
  }

  const rawPoints = buildCrossChunkPoints(edge, sourceNode, targetNode, sourceBounds, targetBounds, routeHint)
  assertFinitePointList(rawPoints, edge, 'cross-chunk raw route')
  const simplified = collapseExactlyCollinearPoints(rawPoints, { edgeId: edge.id, context: 'cross-chunk' })
  const points = simplified.points
  assertFinitePointList(points, edge, 'cross-chunk simplified route')

  return {
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
  }
}

export function composeChunkLayouts(chunkRecords, edgeById, options = {}) {
  const normalizedRecords = (Array.isArray(chunkRecords) ? chunkRecords : [])
    .filter((record) => record?.chunk?.chunkId)
    .slice()
    .sort((a, b) => {
      const aIndex = Number.isFinite(a?.chunk?.chunkIndex) ? a.chunk.chunkIndex : Number.MAX_SAFE_INTEGER
      const bIndex = Number.isFinite(b?.chunk?.chunkIndex) ? b.chunk.chunkIndex : Number.MAX_SAFE_INTEGER
      if (aIndex !== bIndex) return aIndex - bIndex
      return String(a?.chunk?.chunkId || '').localeCompare(String(b?.chunk?.chunkId || ''))
    })

  const nodes = []
  const internalEdges = []
  const nodesById = new Map()
  const chunkBoundsById = new Map()
  const chunkMetricsByChunkId = computeChunkRecordMetrics(normalizedRecords)
  const chunkGraph = buildChunkGraph(normalizedRecords, edgeById)
  const { components, componentIdByChunkId } = buildLayoutNeighborhoods(chunkGraph, chunkMetricsByChunkId)
  const componentGraph = buildComponentGraph(components, componentIdByChunkId, chunkGraph)
  const componentLayoutsById = computeComponentLayouts(components, chunkGraph, componentIdByChunkId, chunkMetricsByChunkId, options)
  const componentPlacementsById = computeGlobalComponentPlacements(components, componentGraph, componentLayoutsById, options)
  const placementByChunkId = mergeChunkPlacements(components, componentLayoutsById, componentPlacementsById)

  for (const record of normalizedRecords) {
    const placement = placementByChunkId.get(record.chunk.chunkId) || { x: 0, y: 0 }
    const placed = placeChunkAtPosition(record.built, placement.x, placement.y)
    chunkBoundsById.set(record.chunk.chunkId, placed.bounds)
    for (const node of placed.nodes) {
      nodes.push(node)
      nodesById.set(node.id, node)
    }
    for (const edge of placed.edges) {
      internalEdges.push(edge)
    }
  }

  const routeHints = buildCrossChunkRouteHints(edgeById, chunkGraph, chunkBoundsById, nodesById)
  const crossEdges = []
  for (const routeHint of routeHints) {
    const builtEdge = buildCrossChunkEdge(routeHint.edge, nodesById, chunkBoundsById, routeHint)
    if (builtEdge) crossEdges.push(builtEdge)
  }

  return {
    nodes,
    edges: internalEdges.concat(crossEdges),
    meta: {
      chunkCount: normalizedRecords.length,
      componentCount: components.length
    }
  }
}

function buildCrossChunkPoints(edge, sourceNode, targetNode, sourceBounds, targetBounds, routeHint = {}) {
  const sourceSide = routeHint.sourceSide || 'right'
  const targetSide = routeHint.targetSide || 'left'
  const laneOffset = Number.isFinite(routeHint.laneOffset) ? routeHint.laneOffset : 0
  const maxAbsLaneOffset = Number.isFinite(routeHint.maxAbsLaneOffset) ? routeHint.maxAbsLaneOffset : Math.abs(laneOffset)
  const sourceAnchor = getForcedSideAnchor(sourceNode, edge, 'source', sourceSide)
  const targetAnchor = getForcedSideAnchor(targetNode, edge, 'target', targetSide)

  const horizontalRoute = (sourceSide === 'right' && targetSide === 'left') || (sourceSide === 'left' && targetSide === 'right')
  const verticalRoute = (sourceSide === 'bottom' && targetSide === 'top') || (sourceSide === 'top' && targetSide === 'bottom')

  if (horizontalRoute) {
    const sourceChannelX = getChannelCoordinate(sourceBounds, sourceSide, laneOffset, maxAbsLaneOffset)
    const targetChannelX = getChannelCoordinate(targetBounds, targetSide, laneOffset, maxAbsLaneOffset)

    if ((sourceSide === 'right' && sourceChannelX <= targetChannelX) || (sourceSide === 'left' && sourceChannelX >= targetChannelX)) {
      return dedupePoints([
        sourceAnchor,
        { x: sourceChannelX, y: sourceAnchor.y },
        { x: targetChannelX, y: sourceAnchor.y },
        { x: targetChannelX, y: targetAnchor.y },
        targetAnchor
      ])
    }

    const midX = Math.round((sourceChannelX + targetChannelX) / 2)
    return dedupePoints([
      sourceAnchor,
      { x: sourceChannelX, y: sourceAnchor.y },
      { x: midX, y: sourceAnchor.y },
      { x: midX, y: targetAnchor.y },
      { x: targetChannelX, y: targetAnchor.y },
      targetAnchor
    ])
  }

  if (verticalRoute) {
    const sourceChannelY = getChannelCoordinate(sourceBounds, sourceSide, laneOffset, maxAbsLaneOffset)
    const targetChannelY = getChannelCoordinate(targetBounds, targetSide, laneOffset, maxAbsLaneOffset)

    if ((sourceSide === 'bottom' && sourceChannelY <= targetChannelY) || (sourceSide === 'top' && sourceChannelY >= targetChannelY)) {
      return dedupePoints([
        sourceAnchor,
        { x: sourceAnchor.x, y: sourceChannelY },
        { x: sourceAnchor.x, y: targetChannelY },
        { x: targetAnchor.x, y: targetChannelY },
        targetAnchor
      ])
    }

    const midY = Math.round((sourceChannelY + targetChannelY) / 2)
    return dedupePoints([
      sourceAnchor,
      { x: sourceAnchor.x, y: sourceChannelY },
      { x: sourceAnchor.x, y: midY },
      { x: targetAnchor.x, y: midY },
      { x: targetAnchor.x, y: targetChannelY },
      targetAnchor
    ])
  }

  const sourceChannel = sourceSide === 'right'
    ? { x: getChannelCoordinate(sourceBounds, sourceSide, laneOffset, maxAbsLaneOffset), y: sourceAnchor.y }
    : sourceSide === 'left'
      ? { x: getChannelCoordinate(sourceBounds, sourceSide, laneOffset, maxAbsLaneOffset), y: sourceAnchor.y }
      : sourceSide === 'bottom'
        ? { x: sourceAnchor.x, y: getChannelCoordinate(sourceBounds, sourceSide, laneOffset, maxAbsLaneOffset) }
        : { x: sourceAnchor.x, y: getChannelCoordinate(sourceBounds, sourceSide, laneOffset, maxAbsLaneOffset) }

  const targetChannel = targetSide === 'right'
    ? { x: getChannelCoordinate(targetBounds, targetSide, laneOffset, maxAbsLaneOffset), y: targetAnchor.y }
    : targetSide === 'left'
      ? { x: getChannelCoordinate(targetBounds, targetSide, laneOffset, maxAbsLaneOffset), y: targetAnchor.y }
      : targetSide === 'bottom'
        ? { x: targetAnchor.x, y: getChannelCoordinate(targetBounds, targetSide, laneOffset, maxAbsLaneOffset) }
        : { x: targetAnchor.x, y: getChannelCoordinate(targetBounds, targetSide, laneOffset, maxAbsLaneOffset) }

  return dedupePoints([
    sourceAnchor,
    sourceChannel,
    { x: sourceChannel.x, y: targetChannel.y },
    targetChannel,
    targetAnchor
  ])
}

export function buildCrossChunkEdgesForChunk(chunkMeta, context = {}) {
  const { completedChunkIds, nodesById, edgeById, renderedEdgeIds, chunkBoundsById } = context
  const edges = []

  for (const boundary of Array.isArray(chunkMeta?.boundaryEdges) ? chunkMeta.boundaryEdges : []) {
    if (!completedChunkIds?.has(boundary?.otherChunkId)) continue
    if (renderedEdgeIds?.has(boundary?.edgeId)) continue

    const edge = edgeById?.get(boundary?.edgeId)
    if (!edge) continue
    const sourceChunkId = chunkMeta?.chunkId || null
    const targetChunkId = boundary?.otherChunkId || null
    const sourceBounds = chunkBoundsById?.get?.(sourceChunkId)
    const targetBounds = chunkBoundsById?.get?.(targetChunkId)
    const sourceNode = nodesById?.get?.(edge?.source) || null
    const targetNode = nodesById?.get?.(edge?.target) || null
    if (!sourceBounds || !targetBounds || !sourceNode || !targetNode) continue
    const routeHint = {
      sourceChunkId,
      targetChunkId,
      ...chooseChunkRouteSides(sourceNode, targetNode, sourceBounds, targetBounds, edge),
      laneOffset: 0,
      maxAbsLaneOffset: 0
    }
    const builtEdge = buildCrossChunkEdge(edge, nodesById, chunkBoundsById, routeHint)
    if (builtEdge) edges.push(builtEdge)
  }

  return edges
}
