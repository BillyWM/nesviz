import { GRAPH_NODE_OUTER_WIDTH, getGraphNodeHeight } from './graphGeometry.js'
import {
  buildElkGraph,
  finalizeElkLayoutResult
} from './graphElkLayout.js'
import {
  getMeasurementKey,
  isFiniteNumber,
  isMeasurementComplete
} from './graphMeasurement.js'

const PROGRESS_EVERY = 200

function emitProgress(onProgress, stepId, patch = {}) {
  if (typeof onProgress !== 'function') return
  onProgress({ stepId, ...patch })
}

function maybeEmitLoopProgress(onProgress, stepId, completed, total, noun) {
  if (completed !== total && (completed % PROGRESS_EVERY) !== 0) return
  emitProgress(onProgress, stepId, {
    status: 'active',
    completed,
    total,
    detail: `${completed} / ${total} ${noun}`
  })
}

function getMeasuredLineCenter(measurementsByNode, nodeId, rowIndex) {
  const measurement = measurementsByNode.get(getMeasurementKey(nodeId))
  if (!measurement) return null
  const center = Array.isArray(measurement.lineCenters) ? measurement.lineCenters[rowIndex] : null
  return isFiniteNumber(center) ? center : null
}

function getMeasuredPortTop(measurementsByNode, nodeId, rowIndex) {
  const center = getMeasuredLineCenter(measurementsByNode, nodeId, rowIndex)
  return isFiniteNumber(center) ? center : null
}


function describeEdge(edge) {
  return `${String(edge?.id || '?')} (${String(edge?.source || '?')}:${String(edge?.sourceLineIndex ?? '?')} -> ${String(edge?.target || '?')}:${String(edge?.targetLineIndex ?? '?')})`
}

function getNodeLineCount(node) {
  return Array.isArray(node?.lines) ? node.lines.length : 0
}

function assertValidNodeLineIndex(node, lineIndex, edge, sideRole) {
  if (!node) {
    throw new Error(`Graph edge ${describeEdge(edge)} references missing ${sideRole} node`)
  }
  if (!Number.isInteger(lineIndex)) {
    throw new Error(`Graph edge ${describeEdge(edge)} has non-integer ${sideRole}LineIndex`)
  }

  const lineCount = getNodeLineCount(node)
  if (lineIndex < 0 || lineIndex >= lineCount) {
    throw new Error(`Graph edge ${describeEdge(edge)} has out-of-range ${sideRole}LineIndex ${lineIndex} for node ${String(node.id)} with ${lineCount} lines`)
  }
}

function assertMeasurementCompleteForNode(node, measurementsByNode) {
  const measurement = measurementsByNode.get(getMeasurementKey(node?.id))
  if (!isMeasurementComplete(node, measurement)) {
    throw new Error(`Deterministic graph measurement is incomplete for node ${String(node?.id || '?')}`)
  }
  return measurement
}

function validateGraphLayoutInputs(graphNodes, graphEdges, measurementsByNode) {
  const nodeList = Array.isArray(graphNodes) ? graphNodes : []
  const edgeList = Array.isArray(graphEdges) ? graphEdges : []
  const nodesById = new Map(nodeList.map((node) => [node.id, node]))

  for (const node of nodeList) {
    assertMeasurementCompleteForNode(node, measurementsByNode)
  }

  for (const edge of edgeList) {
    const sourceNode = nodesById.get(edge?.source) || null
    const targetNode = nodesById.get(edge?.target) || null
    assertValidNodeLineIndex(sourceNode, edge?.sourceLineIndex, edge, 'source')
    assertValidNodeLineIndex(targetNode, edge?.targetLineIndex, edge, 'target')
  }

  return nodesById
}

function scanEdgeSlotCounts(graphEdges, onProgress) {
  const sourceCounts = new Map()
  const targetCounts = new Map()
  const edgeList = Array.isArray(graphEdges) ? graphEdges : []
  const total = edgeList.length

  emitProgress(onProgress, 'scanEdges', {
    status: 'active',
    completed: 0,
    total,
    detail: `0 / ${total} edges`
  })

  for (let index = 0; index < edgeList.length; index++) {
    const edge = edgeList[index]
    if (edge?.kind !== 'fallthrough') {
      const sourceKey = `${edge.source}:${edge.sourceLineIndex}`
      const targetKey = `${edge.target}:${edge.targetLineIndex}`
      sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) || 0) + 1)
      targetCounts.set(targetKey, (targetCounts.get(targetKey) || 0) + 1)
    }
    maybeEmitLoopProgress(onProgress, 'scanEdges', index + 1, total, 'edges')
  }

  emitProgress(onProgress, 'scanEdges', {
    status: 'done',
    completed: total,
    total,
    detail: `${total} / ${total} edges`
  })

  return { sourceCounts, targetCounts }
}

function buildPortCollections(graphNodes, graphEdges, measurementsByNode, onProgress) {
  const { sourceCounts, targetCounts } = scanEdgeSlotCounts(graphEdges, onProgress)
  const sourceSeen = new Map()
  const targetSeen = new Map()
  const portsByNode = new Map()
  const syntheticSourcePortIds = new Map()
  const syntheticTargetPortIds = new Map()

  for (const node of Array.isArray(graphNodes) ? graphNodes : []) {
    portsByNode.set(node.id, { sourcePorts: [], targetPorts: [] })
  }

  const edgeList = Array.isArray(graphEdges) ? graphEdges : []
  const reactFlowEdges = []
  const total = edgeList.length
  emitProgress(onProgress, 'buildPorts', {
    status: 'active',
    completed: 0,
    total,
    detail: `0 / ${total} edges`
  })

  for (let index = 0; index < edgeList.length; index++) {
    const edge = edgeList[index]
    const sourceNodePorts = portsByNode.get(edge.source)
    const targetNodePorts = portsByNode.get(edge.target)
    const sourceMeasurement = measurementsByNode.get(getMeasurementKey(edge.source))
    const targetMeasurement = measurementsByNode.get(getMeasurementKey(edge.target))

    let sourceHandle = `out:${edge.id}`
    let targetHandle = `in:${edge.id}`

    if (edge?.kind === 'fallthrough') {
      sourceHandle = `out:blockBottom:${edge.source}`
      targetHandle = `in:blockTop:${edge.target}`

      if (sourceNodePorts && !syntheticSourcePortIds.has(edge.source)) {
        const sourceWidth = isFiniteNumber(sourceMeasurement?.width) ? sourceMeasurement.width : GRAPH_NODE_OUTER_WIDTH
        const sourceHeight = isFiniteNumber(sourceMeasurement?.height) ? sourceMeasurement.height : getGraphNodeHeight(0)
        sourceNodePorts.sourcePorts.push({
          id: sourceHandle,
          rowIndex: Number.MAX_SAFE_INTEGER,
          slotIndex: 0,
          slotCount: 1,
          side: 'SOUTH',
          left: sourceWidth / 2,
          top: sourceHeight,
          kind: edge.kind
        })
        syntheticSourcePortIds.set(edge.source, true)
      }

      if (targetNodePorts && !syntheticTargetPortIds.has(edge.target)) {
        const targetWidth = isFiniteNumber(targetMeasurement?.width) ? targetMeasurement.width : GRAPH_NODE_OUTER_WIDTH
        targetNodePorts.targetPorts.push({
          id: targetHandle,
          rowIndex: Number.MIN_SAFE_INTEGER,
          slotIndex: 0,
          slotCount: 1,
          side: 'NORTH',
          left: targetWidth / 2,
          top: 0,
          kind: edge.kind
        })
        syntheticTargetPortIds.set(edge.target, true)
      }
    } else {
      const sourceKey = `${edge.source}:${edge.sourceLineIndex}`
      const targetKey = `${edge.target}:${edge.targetLineIndex}`
      const sourceSlot = sourceSeen.get(sourceKey) || 0
      const targetSlot = targetSeen.get(targetKey) || 0
      sourceSeen.set(sourceKey, sourceSlot + 1)
      targetSeen.set(targetKey, targetSlot + 1)

      const sourceSlotCount = sourceCounts.get(sourceKey) || 1
      const targetSlotCount = targetCounts.get(targetKey) || 1
      const sourceTop = getMeasuredPortTop(measurementsByNode, edge.source, edge.sourceLineIndex)
      const targetTop = getMeasuredPortTop(measurementsByNode, edge.target, edge.targetLineIndex)
      if (!isFiniteNumber(sourceTop) || !isFiniteNumber(targetTop)) {
        throw new Error(`Graph edge ${describeEdge(edge)} could not resolve a measured per-line anchor`)
      }

      if (sourceNodePorts) {
        sourceNodePorts.sourcePorts.push({
          id: sourceHandle,
          rowIndex: edge.sourceLineIndex,
          slotIndex: sourceSlot,
          slotCount: sourceSlotCount,
          side: 'EAST',
          top: sourceTop,
          kind: edge.kind
        })
      }

      if (targetNodePorts) {
        targetNodePorts.targetPorts.push({
          id: targetHandle,
          rowIndex: edge.targetLineIndex,
          slotIndex: targetSlot,
          slotCount: targetSlotCount,
          side: 'WEST',
          top: targetTop,
          kind: edge.kind
        })
      }
    }

    reactFlowEdges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'routed',
      sourceHandle,
      targetHandle,
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
        points: []
      }
    })

    maybeEmitLoopProgress(onProgress, 'buildPorts', index + 1, total, 'edges')
  }

  emitProgress(onProgress, 'buildPorts', {
    status: 'done',
    completed: total,
    total,
    detail: `${total} / ${total} edges`
  })

  return { portsByNode, reactFlowEdges }
}

export function prepareGraphLayout(graphNodes, graphEdges, measurementsByNode, onProgress) {
  validateGraphLayoutInputs(graphNodes, graphEdges, measurementsByNode)
  const { portsByNode, reactFlowEdges } = buildPortCollections(graphNodes, graphEdges, measurementsByNode, onProgress)

  const nodeList = Array.isArray(graphNodes) ? graphNodes : []
  const baseNodes = nodeList.map((node) => {
    const nodeMeasurement = assertMeasurementCompleteForNode(node, measurementsByNode)
    const lines = Array.isArray(node?.lines) ? node.lines : []
    const ports = portsByNode.get(node.id) || { sourcePorts: [], targetPorts: [] }
    return {
      id: node.id,
      type: 'graphBlock',
      width: isFiniteNumber(nodeMeasurement?.width) ? nodeMeasurement.width : GRAPH_NODE_OUTER_WIDTH,
      height: isFiniteNumber(nodeMeasurement?.height) ? nodeMeasurement.height : getGraphNodeHeight(lines.length),
      draggable: false,
      selectable: false,
      data: {
        ...node,
        nodeId: node.id,
        lines,
        sourcePorts: ports.sourcePorts,
        targetPorts: ports.targetPorts
      }
    }
  })

  const elkGraph = buildElkGraph(baseNodes, reactFlowEdges, {
    nodeWidth: GRAPH_NODE_OUTER_WIDTH,
    onProgress
  })

  return {
    baseNodes,
    reactFlowEdges,
    elkGraph
  }
}

export function finalizeGraphLayout(prepared, laidOutGraph, onProgress) {
  const baseNodes = Array.isArray(prepared?.baseNodes) ? prepared.baseNodes : []
  const reactFlowEdges = Array.isArray(prepared?.reactFlowEdges) ? prepared.reactFlowEdges : []
  return finalizeElkLayoutResult(baseNodes, reactFlowEdges, laidOutGraph, { onProgress })
}
