import { GRAPH_NODE_OUTER_BASE_HEIGHT, GRAPH_NODE_WIDTH } from './graphGeometry.js'
import { collapseExactlyCollinearPoints } from './graphPointSimplify.js'

const PORT_SIZE = 8
const BUNDLE_SPINE_OUTSET = 24
const DEFAULTS = {
  algorithm: 'layered',
  direction: 'RIGHT',
  nodeNodeSpacing: 56,
  layerSpacing: 168,
  edgeSpacing: 18,
  edgeEdgeBetweenLayers: 28,
  portPortSpacing: 10,
  edgeNodeSpacing: 26
}

function sortPorts(ports) {
  return (Array.isArray(ports) ? ports : []).slice().sort((a, b) => {
    if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex
    if (a.slotIndex !== b.slotIndex) return a.slotIndex - b.slotIndex
    return String(a.id).localeCompare(String(b.id))
  })
}

function buildPort(port, side, index, nodeWidth, nodeHeight) {
  const top = Number.isFinite(port?.top) ? port.top : 0
  const left = Number.isFinite(port?.left) ? port.left : (nodeWidth / 2)
  let x = -PORT_SIZE / 2
  let y = Math.max(0, top - PORT_SIZE / 2)

  if (side === 'EAST') {
    x = nodeWidth - PORT_SIZE / 2
    y = Math.max(0, top - PORT_SIZE / 2)
  } else if (side === 'WEST') {
    x = -PORT_SIZE / 2
    y = Math.max(0, top - PORT_SIZE / 2)
  } else if (side === 'NORTH') {
    x = Math.max(0, left - PORT_SIZE / 2)
    y = -PORT_SIZE / 2
  } else if (side === 'SOUTH') {
    x = Math.max(0, left - PORT_SIZE / 2)
    y = nodeHeight - PORT_SIZE / 2
  }

  return {
    id: port.id,
    width: PORT_SIZE,
    height: PORT_SIZE,
    x,
    y,
    layoutOptions: {
      'org.eclipse.elk.port.side': side,
      'org.eclipse.elk.port.index': String(index)
    }
  }
}

function buildElkNode(node) {
  const nodeWidth = Number.isFinite(node?.width) ? node.width : GRAPH_NODE_WIDTH
  const nodeHeight = Number.isFinite(node?.height) ? node.height : GRAPH_NODE_OUTER_BASE_HEIGHT
  const sourcePorts = sortPorts(node?.data?.sourcePorts)
  const targetPorts = sortPorts(node?.data?.targetPorts)
  const ports = []

  targetPorts.forEach((port, index) => {
    const side = typeof port?.side === 'string' ? port.side : 'WEST'
    ports.push(buildPort(port, side, index, nodeWidth, nodeHeight))
  })

  sourcePorts.forEach((port, index) => {
    const side = typeof port?.side === 'string' ? port.side : 'EAST'
    ports.push(buildPort(port, side, index, nodeWidth, nodeHeight))
  })

  return {
    id: node.id,
    width: nodeWidth,
    height: Number.isFinite(node?.height) ? node.height : GRAPH_NODE_OUTER_BASE_HEIGHT,
    ports,
    layoutOptions: {
      'org.eclipse.elk.portConstraints': 'FIXED_POS'
    }
  }
}

function buildElkEdge(edge) {
  return {
    id: edge.id,
    sources: [edge.sourceHandle],
    targets: [edge.targetHandle]
  }
}

function getSectionPoints(section) {
  const points = []
  if (section?.startPoint) points.push({ x: section.startPoint.x, y: section.startPoint.y })
  for (const point of Array.isArray(section?.bendPoints) ? section.bendPoints : []) {
    points.push({ x: point.x, y: point.y })
  }
  if (section?.endPoint) points.push({ x: section.endPoint.x, y: section.endPoint.y })
  return points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
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

function collectEdgePoints(elkEdge) {
  const points = []
  for (const section of Array.isArray(elkEdge?.sections) ? elkEdge.sections : []) {
    const sectionPoints = getSectionPoints(section)
    if (!sectionPoints.length) continue
    if (!points.length) {
      points.push(...sectionPoints)
      continue
    }
    const first = sectionPoints[0]
    const last = points[points.length - 1]
    if (!last || last.x !== first.x || last.y !== first.y) {
      points.push(first)
    }
    points.push(...sectionPoints.slice(1))
  }
  return dedupePoints(points)
}

function getPortAnchor(reactNode, laidOutNode, portId, side) {
  const ports = side === 'source'
    ? (Array.isArray(reactNode?.data?.sourcePorts) ? reactNode.data.sourcePorts : [])
    : (Array.isArray(reactNode?.data?.targetPorts) ? reactNode.data.targetPorts : [])
  const port = ports.find((entry) => entry?.id === portId) || null
  if (!port) return null

  const nodeX = Number.isFinite(laidOutNode?.x) ? laidOutNode.x : (Number.isFinite(reactNode?.position?.x) ? reactNode.position.x : 0)
  const nodeY = Number.isFinite(laidOutNode?.y) ? laidOutNode.y : (Number.isFinite(reactNode?.position?.y) ? reactNode.position.y : 0)
  const nodeWidth = Number.isFinite(reactNode?.width) ? reactNode.width : (Number.isFinite(laidOutNode?.width) ? laidOutNode.width : 0)
  const nodeHeight = Number.isFinite(reactNode?.height) ? reactNode.height : (Number.isFinite(laidOutNode?.height) ? laidOutNode.height : 0)
  const portSide = typeof port?.side === 'string' ? port.side : (side === 'source' ? 'EAST' : 'WEST')

  if (portSide === 'NORTH' || portSide === 'SOUTH') {
    const left = Number.isFinite(port?.left) ? port.left : (nodeWidth / 2)
    return {
      x: nodeX + left,
      y: portSide === 'SOUTH' ? (nodeY + nodeHeight) : nodeY
    }
  }

  const top = Number.isFinite(port?.top) ? port.top : null
  if (!Number.isFinite(top)) return null

  return {
    x: side === 'source' ? (nodeX + nodeWidth) : nodeX,
    y: nodeY + top
  }
}

function forceEdgeEndpoints(edge, points, reactNodesById, laidOutNodesById) {
  const exactPoints = Array.isArray(points) ? points.map((point) => ({ ...point })) : []
  const sourceReactNode = reactNodesById.get(edge?.source) || null
  const targetReactNode = reactNodesById.get(edge?.target) || null
  const sourceLaidOutNode = laidOutNodesById.get(edge?.source) || null
  const targetLaidOutNode = laidOutNodesById.get(edge?.target) || null
  const sourceAnchor = getPortAnchor(sourceReactNode, sourceLaidOutNode, edge?.sourceHandle, 'source')
  const targetAnchor = getPortAnchor(targetReactNode, targetLaidOutNode, edge?.targetHandle, 'target')

  if (!sourceAnchor || !targetAnchor) return exactPoints
  if (!exactPoints.length) return [sourceAnchor, targetAnchor]

  exactPoints[0] = sourceAnchor
  if (exactPoints.length === 1) {
    exactPoints.push(targetAnchor)
  } else {
    exactPoints[exactPoints.length - 1] = targetAnchor
  }
  return dedupePoints(exactPoints)
}

function getBundleGroupKey(edge) {
  return typeof edge?.data?.bundleGroupKey === 'string' && edge.data.bundleGroupKey
    ? edge.data.bundleGroupKey
    : null
}

function buildBundledEdgePoints(groupEdges, reactNodesById, laidOutNodesById) {
  const routed = new Map()
  const anchors = []

  for (const edge of Array.isArray(groupEdges) ? groupEdges : []) {
    const sourceReactNode = reactNodesById.get(edge?.source) || null
    const targetReactNode = reactNodesById.get(edge?.target) || null
    const sourceLaidOutNode = laidOutNodesById.get(edge?.source) || null
    const targetLaidOutNode = laidOutNodesById.get(edge?.target) || null
    const sourceAnchor = getPortAnchor(sourceReactNode, sourceLaidOutNode, edge?.sourceHandle, 'source')
    const targetAnchor = getPortAnchor(targetReactNode, targetLaidOutNode, edge?.targetHandle, 'target')
    if (!sourceAnchor || !targetAnchor) continue
    anchors.push({ edge, sourceAnchor, targetAnchor })
  }

  if (anchors.length < 2) return routed

  const first = anchors[0]
  const sourceEdgeX = first.sourceAnchor.x
  const sharedTargetX = first.targetAnchor.x
  const sharedTargetY = first.targetAnchor.y

  const sameSourceSide = anchors.every(({ sourceAnchor }) => sourceAnchor.x === sourceEdgeX)
  const sameTargetRow = anchors.every(({ targetAnchor }) => targetAnchor.x === sharedTargetX && targetAnchor.y === sharedTargetY)
  const movingRight = anchors.every(({ sourceAnchor, targetAnchor }) => targetAnchor.x > sourceAnchor.x)
  const movingLeft = anchors.every(({ sourceAnchor, targetAnchor }) => targetAnchor.x < sourceAnchor.x)

  if (!sameSourceSide || !sameTargetRow) return routed
  if (!movingRight && !movingLeft) return routed

  const spineX = movingRight
    ? (sourceEdgeX + BUNDLE_SPINE_OUTSET)
    : (sourceEdgeX - BUNDLE_SPINE_OUTSET)

  for (const { edge, sourceAnchor, targetAnchor } of anchors) {
    const points = dedupePoints([
      sourceAnchor,
      { x: spineX, y: sourceAnchor.y },
      { x: spineX, y: sharedTargetY },
      { x: sharedTargetX, y: sharedTargetY },
      targetAnchor
    ])
    routed.set(edge.id, points)
  }

  return routed
}

function applyOutboundBundles(edgeList, reactNodesById, laidOutNodesById, defaultPointsByEdgeId) {
  const bundledPointsByEdgeId = new Map(defaultPointsByEdgeId)
  const groups = new Map()

  for (const edge of Array.isArray(edgeList) ? edgeList : []) {
    const key = getBundleGroupKey(edge)
    if (!key) continue
    const group = groups.get(key) || []
    group.push(edge)
    groups.set(key, group)
  }

  for (const groupEdges of groups.values()) {
    if (!Array.isArray(groupEdges) || groupEdges.length < 2) continue
    const overrides = buildBundledEdgePoints(groupEdges, reactNodesById, laidOutNodesById)
    for (const [edgeId, points] of overrides.entries()) {
      bundledPointsByEdgeId.set(edgeId, points)
    }
  }

  return bundledPointsByEdgeId
}

function emitProgress(onProgress, stepId, patch = {}) {
  if (typeof onProgress !== 'function') return
  onProgress({ stepId, ...patch })
}


function buildFinalizeDebugSummary(edgeList, laidOutEdgesById, defaultPointsByEdgeId) {
  const missingElkEdges = []
  const edgesWithNoSections = []
  const straightFallbackEdges = []
  const sampleReturnedEdges = []

  for (const edge of Array.isArray(edgeList) ? edgeList : []) {
    const elkEdge = laidOutEdgesById.get(edge?.id)
    const routedPoints = defaultPointsByEdgeId.get(edge?.id) || []
    if (elkEdge && sampleReturnedEdges.length < 5) {
      sampleReturnedEdges.push({
        id: elkEdge?.id || null,
        sectionCount: Array.isArray(elkEdge?.sections) ? elkEdge.sections.length : 0,
        sources: Array.isArray(elkEdge?.sources) ? elkEdge.sources : null,
        targets: Array.isArray(elkEdge?.targets) ? elkEdge.targets : null
      })
    }
    if (!elkEdge) {
      if (missingElkEdges.length < 12) missingElkEdges.push(edge?.id || null)
      continue
    }
    const sectionCount = Array.isArray(elkEdge?.sections) ? elkEdge.sections.length : 0
    if (sectionCount === 0 && edgesWithNoSections.length < 12) {
      edgesWithNoSections.push(edge?.id || null)
    }
    if (Array.isArray(routedPoints) && routedPoints.length === 2 && sectionCount === 0 && straightFallbackEdges.length < 12) {
      straightFallbackEdges.push(edge?.id || null)
    }
  }

  return {
    expectedEdgeCount: Array.isArray(edgeList) ? edgeList.length : 0,
    returnedEdgeCount: laidOutEdgesById.size,
    missingElkEdges,
    edgesWithNoSections,
    straightFallbackEdges,
    sampleReturnedEdges
  }
}

export function buildElkGraph(nodes, edges, options = {}) {
  const { onProgress, ...cfg } = { ...DEFAULTS, ...options }
  const nodeList = Array.isArray(nodes) ? nodes : []
  const edgeList = Array.isArray(edges) ? edges : []

  emitProgress(onProgress, 'elkGraph', {
    status: 'active',
    detail: `${nodeList.length} nodes, ${edgeList.length} edges`
  })

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'org.eclipse.elk.algorithm': cfg.algorithm,
      'org.eclipse.elk.direction': cfg.direction,
      'org.eclipse.elk.edgeRouting': 'ORTHOGONAL',
      'org.eclipse.elk.layered.mergeEdges': 'false',
      'org.eclipse.elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'org.eclipse.elk.spacing.nodeNode': String(cfg.nodeNodeSpacing),
      'org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers': String(cfg.layerSpacing),
      'org.eclipse.elk.spacing.edgeEdge': String(cfg.edgeSpacing),
      'org.eclipse.elk.layered.spacing.edgeEdgeBetweenLayers': String(cfg.edgeEdgeBetweenLayers),
      'org.eclipse.elk.spacing.portPort': String(cfg.portPortSpacing),
      'org.eclipse.elk.spacing.edgeNode': String(cfg.edgeNodeSpacing),
      'org.eclipse.elk.layered.unnecessaryBendpoints': 'true'
    },
    children: nodeList.map(buildElkNode),
    edges: edgeList.map(buildElkEdge)
  }

  emitProgress(onProgress, 'elkGraph', {
    status: 'done',
    detail: `${nodeList.length} nodes, ${edgeList.length} edges`
  })

  return elkGraph
}

export function finalizeElkLayoutResult(nodes, edges, laidOutGraph, options = {}) {
  const { onProgress } = options
  const nodeList = Array.isArray(nodes) ? nodes : []
  const edgeList = Array.isArray(edges) ? edges : []
  const reactNodesById = new Map(nodeList.map((node) => [node.id, node]))
  const laidOutNodesById = new Map((Array.isArray(laidOutGraph?.children) ? laidOutGraph.children : []).map((node) => [node.id, node]))
  const laidOutEdgesById = new Map((Array.isArray(laidOutGraph?.edges) ? laidOutGraph.edges : []).map((edge) => [edge.id, edge]))

  emitProgress(onProgress, 'finalize', {
    status: 'active',
    completed: 0,
    total: edgeList.length,
    detail: `0 / ${edgeList.length} edges`
  })

  const laidOutNodes = nodeList.map((node) => {
    const laidOut = laidOutNodesById.get(node.id)
    if (!laidOut) return node

    return {
      ...node,
      position: {
        x: Number.isFinite(laidOut.x) ? laidOut.x : 0,
        y: Number.isFinite(laidOut.y) ? laidOut.y : 0
      }
    }
  })

  const defaultPointsByEdgeId = new Map()

  for (let index = 0; index < edgeList.length; index++) {
    const edge = edgeList[index]
    const elkEdge = laidOutEdgesById.get(edge.id)
    const points = collectEdgePoints(elkEdge)
    const anchoredPoints = forceEdgeEndpoints(edge, points, reactNodesById, laidOutNodesById)
    const simplified = collapseExactlyCollinearPoints(anchoredPoints, { edgeId: edge.id, context: 'elk-finalize' })
    defaultPointsByEdgeId.set(edge.id, simplified.points)
    if (((index + 1) % 200) === 0 || (index + 1) === edgeList.length) {
      emitProgress(onProgress, 'finalize', {
        status: 'active',
        completed: index + 1,
        total: edgeList.length,
        detail: `${index + 1} / ${edgeList.length} edges`
      })
    }
  }

  const bundledPointsByEdgeId = applyOutboundBundles(edgeList, reactNodesById, laidOutNodesById, defaultPointsByEdgeId)
  const laidOutEdges = edgeList.map((edge) => ({
    ...edge,
    data: {
      ...(edge.data || {}),
      points: (bundledPointsByEdgeId.get(edge.id) || defaultPointsByEdgeId.get(edge.id) || [])
    }
  }))

  console.groupCollapsed('[NesViz graph] finalize layout summary')
  console.log('nodes', {
    expectedNodeCount: nodeList.length,
    returnedNodeCount: laidOutNodesById.size
  })
  console.log('edges', buildFinalizeDebugSummary(edgeList, laidOutEdgesById, defaultPointsByEdgeId))
  console.groupEnd()

  emitProgress(onProgress, 'finalize', {
    status: 'done',
    completed: edgeList.length,
    total: edgeList.length,
    detail: `${edgeList.length} / ${edgeList.length} edges`
  })

  return {
    nodes: laidOutNodes,
    edges: laidOutEdges
  }
}
