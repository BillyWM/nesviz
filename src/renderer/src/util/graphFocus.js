import { clamp } from '../../../shared/utils/numberUtils.js';

function compareNodes(a, b) {
  const aRom = Number.isFinite(a?.data?.romStart) ? a.data.romStart : Number.MAX_SAFE_INTEGER
  const bRom = Number.isFinite(b?.data?.romStart) ? b.data.romStart : Number.MAX_SAFE_INTEGER
  if (aRom !== bRom) return aRom - bRom

  const aCpu = Number.isFinite(a?.data?.cpuStart) ? a.data.cpuStart : Number.MAX_SAFE_INTEGER
  const bCpu = Number.isFinite(b?.data?.cpuStart) ? b.data.cpuStart : Number.MAX_SAFE_INTEGER
  if (aCpu !== bCpu) return aCpu - bCpu

  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

export function countNodeEdgeDegrees(nodes, edges) {
  const degreeByNodeId = new Map()

  for (const node of Array.isArray(nodes) ? nodes : []) {
    degreeByNodeId.set(node.id, {
      nodeId: node.id,
      incoming: 0,
      outgoing: 0,
      total: 0
    })
  }

  for (const edge of Array.isArray(edges) ? edges : []) {
    if (degreeByNodeId.has(edge.source)) {
      const source = degreeByNodeId.get(edge.source)
      source.outgoing += 1
      source.total += 1
    }
    if (degreeByNodeId.has(edge.target)) {
      const target = degreeByNodeId.get(edge.target)
      target.incoming += 1
      target.total += 1
    }
  }

  return degreeByNodeId
}

export function pickDefaultFocusNodeId(nodes, edges) {
  const nodeList = Array.isArray(nodes) ? nodes : []
  if (!nodeList.length) return null

  const degreeByNodeId = countNodeEdgeDegrees(nodeList, edges)
  const rankedNodes = nodeList.slice().sort((a, b) => {
    const aDegree = degreeByNodeId.get(a.id) || { incoming: 0, outgoing: 0, total: 0 }
    const bDegree = degreeByNodeId.get(b.id) || { incoming: 0, outgoing: 0, total: 0 }

    if (aDegree.total !== bDegree.total) return bDegree.total - aDegree.total
    if (aDegree.outgoing !== bDegree.outgoing) return bDegree.outgoing - aDegree.outgoing
    if (aDegree.incoming !== bDegree.incoming) return bDegree.incoming - aDegree.incoming
    return compareNodes(a, b)
  })

  return rankedNodes[0]?.id || null
}

export function buildFocusViewport(node, viewportWidth, viewportHeight, options = {}) {
  if (!node || !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) {
    return null
  }

  const padding = Number.isFinite(options.padding) ? options.padding : 48
  const minZoom = Number.isFinite(options.minZoom) ? options.minZoom : 0.2
  const maxZoom = Number.isFinite(options.maxZoom) ? options.maxZoom : 2.2
  const preferredZoom = Number.isFinite(options.preferredZoom) ? options.preferredZoom : 0.95
  const focusMode = options.mode === 'fixed' ? 'fixed' : 'fit'
  const fixedZoom = Number.isFinite(options.zoom) ? options.zoom : preferredZoom

  const nodeWidth = Math.max(1, Number.isFinite(node?.width) ? node.width : 460)
  const nodeHeight = Math.max(1, Number.isFinite(node?.height) ? node.height : 160)
  const posX = Number.isFinite(node?.position?.x) ? node.position.x : 0
  const posY = Number.isFinite(node?.position?.y) ? node.position.y : 0

  const usableWidth = Math.max(64, viewportWidth - padding * 2)
  const usableHeight = Math.max(64, viewportHeight - padding * 2)
  const fitZoom = Math.min(usableWidth / nodeWidth, usableHeight / nodeHeight)
  const zoom = focusMode === 'fixed'
    ? clamp(fixedZoom, minZoom, maxZoom)
    : clamp(Math.min(preferredZoom, fitZoom), minZoom, maxZoom)

  const centerX = posX + nodeWidth / 2
  const centerY = posY + nodeHeight / 2

  return {
    x: viewportWidth / 2 - centerX * zoom,
    y: viewportHeight / 2 - centerY * zoom,
    zoom
  }
}

export function focusGraphNode(instance, viewportElement, node, options = {}) {
  if (!instance || !viewportElement || !node) return false

  const rect = viewportElement.getBoundingClientRect()
  const viewport = buildFocusViewport(node, rect.width, rect.height, options)
  if (!viewport) return false

  const duration = Number.isFinite(options.duration) ? options.duration : 180

  if (typeof instance.setViewport === 'function') {
    instance.setViewport(viewport, { duration })
    return true
  }

  if (typeof instance.setCenter === 'function') {
    const nodeWidth = Math.max(1, Number.isFinite(node?.width) ? node.width : 460)
    const nodeHeight = Math.max(1, Number.isFinite(node?.height) ? node.height : 160)
    const posX = Number.isFinite(node?.position?.x) ? node.position.x : 0
    const posY = Number.isFinite(node?.position?.y) ? node.position.y : 0
    instance.setCenter(posX + nodeWidth / 2, posY + nodeHeight / 2, { zoom: viewport.zoom, duration })
    return true
  }

  return false
}

export function focusGraphNodeById(instance, viewportElement, nodes, nodeId, options = {}) {
  if (!nodeId) return false
  const node = (Array.isArray(nodes) ? nodes : []).find((entry) => entry?.id === nodeId)
  if (!node) return false
  return focusGraphNode(instance, viewportElement, node, options)
}
