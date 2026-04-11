import {
  GRAPH_NODE_OUTER_WIDTH,
  getGraphLineCenter,
  getGraphNodeHeight
} from './graphGeometry.js'

export function getMeasurementKey(nodeId) {
  return String(nodeId || '')
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function measurementsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.width !== b.width || a.height !== b.height) return false
  const aCenters = Array.isArray(a.lineCenters) ? a.lineCenters : []
  const bCenters = Array.isArray(b.lineCenters) ? b.lineCenters : []
  if (aCenters.length !== bCenters.length) return false
  for (let index = 0; index < aCenters.length; index++) {
    if (aCenters[index] !== bCenters[index]) return false
  }
  return true
}

export function isMeasurementComplete(node, measurement) {
  const lines = Array.isArray(node?.lines) ? node.lines : []
  const lineCenters = Array.isArray(measurement?.lineCenters) ? measurement.lineCenters : []
  if (!isFiniteNumber(measurement?.width) || !isFiniteNumber(measurement?.height)) return false
  if (lineCenters.length !== lines.length) return false
  return lineCenters.every((value) => isFiniteNumber(value))
}

export function buildDeterministicMeasurement(node) {
  const lines = Array.isArray(node?.lines) ? node.lines : []
  return {
    width: GRAPH_NODE_OUTER_WIDTH,
    height: getGraphNodeHeight(lines.length),
    lineCenters: lines.map((_, index) => getGraphLineCenter(index, lines.length))
  }
}

export function buildDeterministicMeasurements(graphNodes) {
  const measurements = {}
  for (const node of Array.isArray(graphNodes) ? graphNodes : []) {
    const key = getMeasurementKey(node?.id)
    measurements[key] = buildDeterministicMeasurement(node)
  }
  return measurements
}

