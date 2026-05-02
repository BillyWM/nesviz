import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  ReactFlow
} from '@xyflow/react'

import GraphBlockNode from './components/graph/GraphBlockNode.jsx'
import RoutedGraphEdge from './components/graph/RoutedGraphEdge.jsx'
import { focusGraphNodeById } from './util/graphFocus.js'
import { finalizeGraphLayout } from './util/graphBuild.js'
import { runElkLayoutOnMainThread } from './util/elkMainThreadRunner.js'
import { buildDeterministicMeasurements } from './util/graphMeasurement.js'
import { clampNumber } from '../../shared/utils/numberUtils.js'
import {
  composeChunkLayouts,
  createChunkPackingState
} from './util/graphChunkLayoutPipeline.js'

const DOUBLE_CLICK_ZOOM = 0.92
const CHUNK_THRESHOLD = 100
const GRAPH_LAYOUT_CACHE_VERSION = 2
const nodeTypes = { graphBlock: GraphBlockNode }
const edgeTypes = { routed: RoutedGraphEdge }
const LAYOUT_PROGRESS_STEPS = Object.freeze([
  { id: 'geometry', label: 'Preparing deterministic geometry' },
  { id: 'scanEdges', label: 'Scanning edge fan-out' },
  { id: 'buildPorts', label: 'Assigning ports and building edges' },
  { id: 'elkGraph', label: 'Constructing ELK graph' },
  { id: 'elkLayout', label: 'Running ELK layout' },
  { id: 'finalize', label: 'Finalizing routed graph' },
  { id: 'render', label: 'Rendering graph' }
])

function createInitialLayoutProgress(nodeCount, edgeCount) {
  return LAYOUT_PROGRESS_STEPS.map((step) => {
    if (step.id === 'geometry') {
      return {
        ...step,
        status: 'done',
        detail: `${nodeCount} / ${nodeCount} nodes`
      }
    }

    if (step.id === 'elkLayout' || step.id === 'finalize') {
      return {
        ...step,
        status: 'pending',
        detail: `0 / ${nodeCount} nodes, 0 / ${edgeCount} edges`
      }
    }

    if (step.id === 'render') {
      return {
        ...step,
        status: 'pending',
        detail: `0 / ${nodeCount} nodes, 0 / ${edgeCount} edges`
      }
    }

    return {
      ...step,
      status: 'pending',
      detail: step.id === 'elkGraph'
        ? `0 / ${nodeCount} nodes, 0 / ${edgeCount} edges`
        : `0 / ${edgeCount} edges`
    }
  })
}

function updateLayoutProgress(prev, stepId, patch = {}) {
  return (Array.isArray(prev) ? prev : []).map((step) => {
    if (step.id !== stepId) return step
    return {
      ...step,
      ...patch
    }
  })
}

function progressSymbol(status) {
  if (status === 'done') return '✓'
  if (status === 'active') return '…'
  if (status === 'error') return '!'
  return '○'
}

function buildHighlightMaps(rawNodes, rawEdges, activeBlockId) {
  const connectedNodeIds = new Set()
  const highlightedEdgeIds = new Set()

  if (activeBlockId) {
    connectedNodeIds.add(activeBlockId)
    for (const edge of Array.isArray(rawEdges) ? rawEdges : []) {
      if (edge?.source !== activeBlockId && edge?.target !== activeBlockId) continue
      highlightedEdgeIds.add(edge.id)
      if (edge?.source) connectedNodeIds.add(edge.source)
      if (edge?.target) connectedNodeIds.add(edge.target)
    }
  }

  return {
    connectedNodeIds,
    highlightedEdgeIds,
    hasActiveSelection: Boolean(activeBlockId)
  }
}

function createNodeEdgeDetail(completedNodes, totalNodes, completedEdges, totalEdges) {
  return `${completedNodes} / ${totalNodes} nodes, ${completedEdges} / ${totalEdges} edges`
}

function getNodePosition(node) {
  if (node?.positionAbsolute && Number.isFinite(node.positionAbsolute.x) && Number.isFinite(node.positionAbsolute.y)) {
    return node.positionAbsolute
  }
  if (node?.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) {
    return node.position
  }
  return { x: 0, y: 0 }
}

function getNodeWidth(node) {
  if (Number.isFinite(node?.measured?.width)) return node.measured.width
  if (Number.isFinite(node?.width)) return node.width
  if (Number.isFinite(node?.style?.width)) return node.style.width
  return 0
}

function getNodeHeight(node) {
  if (Number.isFinite(node?.measured?.height)) return node.measured.height
  if (Number.isFinite(node?.height)) return node.height
  if (Number.isFinite(node?.style?.height)) return node.style.height
  return 0
}

function computeGraphBounds(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  if (!list.length) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const node of list) {
    const position = getNodePosition(node)
    const width = Math.max(0, getNodeWidth(node))
    const height = Math.max(0, getNodeHeight(node))
    const left = position.x
    const top = position.y
    const right = left + width
    const bottom = top + height

    if (left < minX) minX = left
    if (top < minY) minY = top
    if (right > maxX) maxX = right
    if (bottom > maxY) maxY = bottom
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  }
}

function buildInitialGraphViewport(bounds, viewportWidth, viewportHeight) {
  if (!bounds) return null
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) return null

  const padding = 72
  const usableWidth = Math.max(64, viewportWidth - padding * 2)
  const usableHeight = Math.max(64, viewportHeight - padding * 2)
  const fitZoom = Math.min(usableWidth / bounds.width, usableHeight / bounds.height)
  const zoom = clampNumber(Number.isFinite(fitZoom) ? fitZoom : 1, 0.16, 0.65)
  const centerX = bounds.minX + (bounds.width / 2)
  const centerY = bounds.minY + (bounds.height / 2)

  return {
    x: (viewportWidth / 2) - (centerX * zoom),
    y: (viewportHeight / 2) - (centerY * zoom),
    zoom
  }
}


function isFinitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y)
}

function isCachedLayoutCompatible(analysisNodes, analysisEdges, cachedNodes, cachedEdges, deterministicMeasurements, cacheMeta) {
  const nextNodes = Array.isArray(analysisNodes) ? analysisNodes : []
  const nextEdges = Array.isArray(analysisEdges) ? analysisEdges : []
  const layoutNodes = Array.isArray(cachedNodes) ? cachedNodes : []
  const layoutEdges = Array.isArray(cachedEdges) ? cachedEdges : []

  if (cacheMeta?.layoutVersion !== GRAPH_LAYOUT_CACHE_VERSION) return false
  if (layoutNodes.length !== nextNodes.length) return false
  if (layoutEdges.length !== nextEdges.length) return false

  const analysisNodeById = new Map(nextNodes.map((node) => [node.id, node]))
  const analysisEdgeById = new Map(nextEdges.map((edge) => [edge.id, edge]))

  for (const cachedNode of layoutNodes) {
    const analysisNode = analysisNodeById.get(cachedNode?.id) || null
    const measurement = deterministicMeasurements[String(cachedNode?.id || '')] || null
    if (!analysisNode || !measurement) return false

    const cachedLines = Array.isArray(cachedNode?.data?.lines)
      ? cachedNode.data.lines
      : (Array.isArray(cachedNode?.lines) ? cachedNode.lines : [])
    const analysisLineCount = Array.isArray(analysisNode?.lines) ? analysisNode.lines.length : 0

    if (cachedLines.length !== analysisLineCount) return false
    if (!Number.isFinite(cachedNode?.position?.x) || !Number.isFinite(cachedNode?.position?.y)) return false
    if (!Number.isFinite(cachedNode?.width) || !Number.isFinite(cachedNode?.height)) return false
    if (cachedNode.width !== measurement.width || cachedNode.height !== measurement.height) return false
  }

  for (const cachedEdge of layoutEdges) {
    const analysisEdge = analysisEdgeById.get(cachedEdge?.id) || null
    if (!analysisEdge) return false
    if (cachedEdge?.source !== analysisEdge.source || cachedEdge?.target !== analysisEdge.target) return false
    if (cachedEdge?.data?.sourceLineIndex !== analysisEdge.sourceLineIndex) return false
    if (cachedEdge?.data?.targetLineIndex !== analysisEdge.targetLineIndex) return false

    const points = Array.isArray(cachedEdge?.data?.points) ? cachedEdge.data.points : []
    if (points.length < 2) return false
    if (!points.every(isFinitePoint)) return false
  }

  return true
}

export default function GraphWindow() {
  const [graphData, setGraphData] = useState(null)
  const [status, setStatus] = useState('')
  const [hasLoadedGraphDataOnce, setHasLoadedGraphDataOnce] = useState(false)
  const [rawNodes, setRawNodes] = useState([])
  const [rawEdges, setRawEdges] = useState([])
  const [activeBlockId, setActiveBlockId] = useState(null)
  const [layoutProgress, setLayoutProgress] = useState([])
  const [isProgressOverlayVisible, setIsProgressOverlayVisible] = useState(true)
  const [isPanning, setIsPanning] = useState(false)
  const reactFlowRef = useRef(null)
  const canvasShellRef = useRef(null)
  const requestIdRef = useRef(0)
  const layoutWorkerRef = useRef(null)
  const queuedReloadRef = useRef(false)
  const buildInFlightRef = useRef(false)
  const preparedChunkQueueRef = useRef([])
  const processingChunkRef = useRef(false)
  const workerCompleteRef = useRef(false)
  const packingOptionsRef = useRef(createChunkPackingState())
  const finalizedChunksByIdRef = useRef(new Map())
  const visibleNodesByIdRef = useRef(new Map())
  const visibleEdgesByIdRef = useRef(new Map())
  const edgeByIdRef = useRef(new Map())
  const totalsRef = useRef({ totalNodes: 0, totalEdges: 0, totalInternalEdges: 0, totalChunks: 0 })
  const completedRef = useRef({ elkNodes: 0, elkEdges: 0, finalizedNodes: 0, finalizedEdges: 0, renderedNodes: 0, renderedEdges: 0 })
  const autoViewportKeyRef = useRef('')
  const [isFlowReady, setIsFlowReady] = useState(false)

  const stopLayoutWorker = useCallback(() => {
    if (layoutWorkerRef.current) {
      layoutWorkerRef.current.terminate()
      layoutWorkerRef.current = null
    }
  }, [])

  const saveFinishedGraphLayoutCache = useCallback(() => {
    if (queuedReloadRef.current) return
    const nodes = Array.from(visibleNodesByIdRef.current.values())
    const edges = Array.from(visibleEdgesByIdRef.current.values())
    if (!nodes.length && !edges.length) return

    void window.nesviz?.saveGraphLayoutCache?.({
      nodes,
      edges,
      meta: {
        layoutVersion: GRAPH_LAYOUT_CACHE_VERSION,
        nodeCount: nodes.length,
        edgeCount: edges.length
      }
    })
  }, [])

  const resetBuildState = useCallback(() => {
    autoViewportKeyRef.current = ''
    preparedChunkQueueRef.current = []
    processingChunkRef.current = false
    workerCompleteRef.current = false
    packingOptionsRef.current = createChunkPackingState()
    finalizedChunksByIdRef.current = new Map()
    visibleNodesByIdRef.current = new Map()
    visibleEdgesByIdRef.current = new Map()
    edgeByIdRef.current = new Map()
    totalsRef.current = { totalNodes: 0, totalEdges: 0, totalInternalEdges: 0, totalChunks: 0 }
    completedRef.current = { elkNodes: 0, elkEdges: 0, finalizedNodes: 0, finalizedEdges: 0, renderedNodes: 0, renderedEdges: 0 }
  }, [])

  const finishBuildIfIdle = useCallback((requestId, reload) => {
    if (requestIdRef.current !== requestId) return
    if (!workerCompleteRef.current) return
    if (processingChunkRef.current) return
    if (preparedChunkQueueRef.current.length) return
    if (finalizedChunksByIdRef.current.size < (totalsRef.current.totalChunks || 0)) return

    try {
      const composed = composeChunkLayouts(
        Array.from(finalizedChunksByIdRef.current.values()),
        edgeByIdRef.current,
        packingOptionsRef.current
      )

      visibleNodesByIdRef.current = new Map(composed.nodes.map((node) => [node.id, node]))
      visibleEdgesByIdRef.current = new Map(composed.edges.map((edge) => [edge.id, edge]))

      completedRef.current = {
        ...completedRef.current,
        renderedNodes: composed.nodes.length,
        renderedEdges: composed.edges.length
      }

      const totals = totalsRef.current
      const completed = completedRef.current

      setRawNodes(composed.nodes)
      setRawEdges(composed.edges)
      setLayoutProgress((prev) => updateLayoutProgress(
        updateLayoutProgress(
          updateLayoutProgress(prev, 'elkLayout', {
            status: 'done',
            detail: createNodeEdgeDetail(completed.elkNodes, totals.totalNodes, completed.elkEdges, totals.totalInternalEdges)
          }),
          'finalize',
          {
            status: 'done',
            detail: createNodeEdgeDetail(completed.finalizedNodes, totals.totalNodes, completed.finalizedEdges, totals.totalInternalEdges)
          }
        ),
        'render',
        {
          status: 'done',
          detail: createNodeEdgeDetail(completed.renderedNodes, totals.totalNodes, completed.renderedEdges, totals.totalEdges)
        }
      ))
    } catch (error) {
      if (requestIdRef.current !== requestId) return
      console.error('[NesViz graph] Chunk composition failure', {
        message: error?.message ?? String(error),
        stack: error?.stack || null,
        graphNodeCount: totalsRef.current.totalNodes,
        graphEdgeCount: totalsRef.current.totalEdges
      })
      setStatus(`Failed to compose graph layout: ${error?.message ?? String(error)}`)
      setLayoutProgress((prev) => updateLayoutProgress(prev, 'render', {
        status: 'error',
        detail: error?.message ?? String(error)
      }))
      buildInFlightRef.current = false
      stopLayoutWorker()
      return
    }

    buildInFlightRef.current = false
    stopLayoutWorker()
    saveFinishedGraphLayoutCache()
    if (queuedReloadRef.current) {
      queuedReloadRef.current = false
      reload()
    }
  }, [saveFinishedGraphLayoutCache, stopLayoutWorker])

  const processPreparedChunkQueue = useCallback(async (requestId, reload) => {
    if (processingChunkRef.current) return
    processingChunkRef.current = true

    try {
      while (preparedChunkQueueRef.current.length) {
        if (requestIdRef.current !== requestId) return
        const item = preparedChunkQueueRef.current.shift()
        if (!item) continue
        const { chunk, prepared } = item
        const totals = totalsRef.current
        const completedBefore = completedRef.current

        setLayoutProgress((prev) => updateLayoutProgress(prev, 'elkLayout', {
          status: 'active',
          detail: createNodeEdgeDetail(completedBefore.elkNodes, totals.totalNodes, completedBefore.elkEdges, totals.totalInternalEdges)
        }))

        const laidOutGraph = await runElkLayoutOnMainThread(prepared.elkGraph)
        if (requestIdRef.current !== requestId) return

        completedRef.current = {
          ...completedRef.current,
          elkNodes: completedRef.current.elkNodes + chunk.nodeCount,
          elkEdges: completedRef.current.elkEdges + chunk.internalEdgeCount
        }

        setLayoutProgress((prev) => updateLayoutProgress(prev, 'elkLayout', {
          status: completedRef.current.elkEdges >= totals.totalInternalEdges ? 'done' : 'active',
          detail: createNodeEdgeDetail(completedRef.current.elkNodes, totals.totalNodes, completedRef.current.elkEdges, totals.totalInternalEdges)
        }))

        setLayoutProgress((prev) => updateLayoutProgress(prev, 'finalize', {
          status: 'active',
          detail: createNodeEdgeDetail(completedRef.current.finalizedNodes, totals.totalNodes, completedRef.current.finalizedEdges, totals.totalInternalEdges)
        }))

        const built = finalizeGraphLayout(prepared, laidOutGraph)
        finalizedChunksByIdRef.current.set(chunk.chunkId, { chunk, built })

        completedRef.current = {
          ...completedRef.current,
          finalizedNodes: completedRef.current.finalizedNodes + chunk.nodeCount,
          finalizedEdges: completedRef.current.finalizedEdges + chunk.internalEdgeCount
        }

        setLayoutProgress((prev) => updateLayoutProgress(
          updateLayoutProgress(prev, 'finalize', {
            status: completedRef.current.finalizedEdges >= totals.totalInternalEdges ? 'done' : 'active',
            detail: createNodeEdgeDetail(completedRef.current.finalizedNodes, totals.totalNodes, completedRef.current.finalizedEdges, totals.totalInternalEdges)
          }),
          'render',
          {
            status: 'pending',
            detail: createNodeEdgeDetail(0, totals.totalNodes, 0, totals.totalEdges)
          }
        ))
      }
    } catch (error) {
      if (requestIdRef.current !== requestId) return
      console.error('[NesViz graph] ELK/layout failure', {
        message: error?.message ?? String(error),
        stack: error?.stack || null,
        graphNodeCount: totalsRef.current.totalNodes,
        graphEdgeCount: totalsRef.current.totalEdges
      })
      setStatus(`Failed to build graph layout: ${error?.message ?? String(error)}`)
      setLayoutProgress((prev) => updateLayoutProgress(prev, 'elkLayout', {
        status: 'error',
        detail: error?.message ?? String(error)
      }))
      buildInFlightRef.current = false
      stopLayoutWorker()
    } finally {
      processingChunkRef.current = false
      finishBuildIfIdle(requestId, reload)
    }
  }, [finishBuildIfIdle, stopLayoutWorker])

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current
    queuedReloadRef.current = false
    buildInFlightRef.current = false
    stopLayoutWorker()
    resetBuildState()
    setLayoutProgress([])
    setStatus('')
    setIsProgressOverlayVisible(true)

    try {
      const res = await window.nesviz?.getGraphData?.()
      if (requestIdRef.current !== requestId) return

      if (!res?.ok) {
        setGraphData(null)
        setRawNodes([])
        setRawEdges([])
        setActiveBlockId(null)
        setLayoutProgress([])
        setStatus(res?.error || 'Failed to load graph data')
        setHasLoadedGraphDataOnce(true)
        return
      }

      setGraphData(res)
      setHasLoadedGraphDataOnce(true)
      if (!res?.hasAnalysis) {
        setRawNodes([])
        setRawEdges([])
        setActiveBlockId(null)
        setLayoutProgress([])
        return
      }

      const nextAnalysisNodes = Array.isArray(res.nodes) ? res.nodes : []
      const nextAnalysisEdges = Array.isArray(res.edges) ? res.edges : []
      const nextMeasurements = buildDeterministicMeasurements(nextAnalysisNodes)

      const cachedLayoutRes = await window.nesviz?.getGraphLayoutCache?.()
      if (requestIdRef.current !== requestId) return
      if (cachedLayoutRes?.ok && cachedLayoutRes?.hasCache && cachedLayoutRes?.layout) {
        const cachedNodes = Array.isArray(cachedLayoutRes.layout?.nodes) ? cachedLayoutRes.layout.nodes : []
        const cachedEdges = Array.isArray(cachedLayoutRes.layout?.edges) ? cachedLayoutRes.layout.edges : []
        if (isCachedLayoutCompatible(nextAnalysisNodes, nextAnalysisEdges, cachedNodes, cachedEdges, nextMeasurements, cachedLayoutRes.layout?.meta || null)) {
          visibleNodesByIdRef.current = new Map(cachedNodes.map((node) => [node.id, node]))
          visibleEdgesByIdRef.current = new Map(cachedEdges.map((edge) => [edge.id, edge]))
          completedRef.current = {
            ...completedRef.current,
            renderedNodes: cachedNodes.length,
            renderedEdges: cachedEdges.length
          }
          setRawNodes(cachedNodes)
          setRawEdges(cachedEdges)
          setActiveBlockId(null)
          setLayoutProgress([])
          return
        }

        console.warn('[NesViz graph] Ignoring stale or incompatible graph layout cache')
      }
      if (cachedLayoutRes && cachedLayoutRes.ok === false) {
        console.warn('[NesViz graph] Graph layout cache load failed:', cachedLayoutRes.error)
      }

      edgeByIdRef.current = new Map(nextAnalysisEdges.map((edge) => [edge.id, edge]))
      totalsRef.current = {
        totalNodes: nextAnalysisNodes.length,
        totalEdges: nextAnalysisEdges.length,
        totalInternalEdges: nextAnalysisEdges.length,
        totalChunks: 0
      }

      setRawNodes([])
      setRawEdges([])
      setActiveBlockId(null)
      setLayoutProgress(createInitialLayoutProgress(nextAnalysisNodes.length, nextAnalysisEdges.length))
      buildInFlightRef.current = true

      const worker = new Worker(new URL('./workers/graphLayoutWorker.js', import.meta.url), { type: 'module' })
      layoutWorkerRef.current = worker

      worker.onmessage = (event) => {
        const payload = event?.data || {}
        if (requestId !== requestIdRef.current) return

        if (payload?.type === 'progress' && payload?.progress?.stepId) {
          setLayoutProgress((prev) => updateLayoutProgress(prev, payload.progress.stepId, payload.progress))
          return
        }

        if (payload?.type === 'chunkPlan') {
          totalsRef.current = {
            ...totalsRef.current,
            totalChunks: payload?.chunkPlan?.totalChunkCount || 0,
            totalInternalEdges: Number.isFinite(payload?.chunkPlan?.totalInternalEdgeCount)
              ? payload.chunkPlan.totalInternalEdgeCount
              : totalsRef.current.totalInternalEdges
          }
          setLayoutProgress((prev) => updateLayoutProgress(
            updateLayoutProgress(
              updateLayoutProgress(prev, 'buildPorts', {
                detail: `0 / ${totalsRef.current.totalInternalEdges} edges`
              }),
              'elkGraph',
              {
                detail: `0 / ${totalsRef.current.totalNodes} nodes, 0 / ${totalsRef.current.totalInternalEdges} edges`
              }
            ),
            'elkLayout',
            {
              detail: createNodeEdgeDetail(0, totalsRef.current.totalNodes, 0, totalsRef.current.totalInternalEdges)
            }
          ))
          return
        }

        if (payload?.type === 'chunkPrepared') {
          preparedChunkQueueRef.current.push({
            chunk: payload.chunk,
            prepared: payload.prepared,
            chunkTotals: payload.chunkTotals
          })
          processPreparedChunkQueue(requestId, reload)
          return
        }

        if (payload?.type === 'chunksComplete') {
          if (!payload?.ok) {
            setStatus(`Failed to prepare graph layout: ${payload?.error || 'Unknown worker error'}`)
            setLayoutProgress((prev) => updateLayoutProgress(prev, 'elkGraph', {
              status: 'error',
              detail: payload?.error || 'Unknown worker error'
            }))
            buildInFlightRef.current = false
            stopLayoutWorker()
            return
          }

          workerCompleteRef.current = true
          finishBuildIfIdle(requestId, reload)
        }
      }

      worker.onerror = (event) => {
        if (requestId !== requestIdRef.current) return
        const message = event?.message || 'Unknown worker error'
        setStatus(`Failed to build graph layout: ${message}`)
        setLayoutProgress((prev) => updateLayoutProgress(prev, 'elkGraph', {
          status: 'error',
          detail: message
        }))
        buildInFlightRef.current = false
        stopLayoutWorker()
      }

      worker.postMessage({
        type: 'buildGraphLayout',
        graphNodes: nextAnalysisNodes,
        graphEdges: nextAnalysisEdges,
        nodeMeasurements: nextMeasurements,
        chunkThreshold: CHUNK_THRESHOLD
      })
    } catch (error) {
      if (requestIdRef.current !== requestId) return
      setGraphData(null)
      setRawNodes([])
      setRawEdges([])
      setActiveBlockId(null)
      setLayoutProgress([])
      setHasLoadedGraphDataOnce(true)
      setStatus(`Failed to load graph data: ${error?.message ?? String(error)}`)
    }
  }, [finishBuildIfIdle, processPreparedChunkQueue, resetBuildState, stopLayoutWorker])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (!window?.nesviz?.onGraphDataChanged) return undefined
    return window.nesviz.onGraphDataChanged(() => {
      if (buildInFlightRef.current) {
        queuedReloadRef.current = true
        return
      }
      reload()
    })
  }, [reload])

  useEffect(() => {
    return () => {
      stopLayoutWorker()
    }
  }, [stopLayoutWorker])

  useEffect(() => {
    function onKeyDown(event) {
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const tag = String(event.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) return

      const isZoomIn = event.code === 'NumpadAdd' || event.key === '+' || (event.code === 'Equal' && event.shiftKey)
      const isZoomOut = event.code === 'NumpadSubtract' || event.key === '-'
      if (!isZoomIn && !isZoomOut) return

      event.preventDefault()
      if (isZoomIn) reactFlowRef.current?.zoomIn?.({ duration: 120 })
      if (isZoomOut) reactFlowRef.current?.zoomOut?.({ duration: 120 })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!activeBlockId) return
    const stillExists = rawNodes.some((node) => node?.id === activeBlockId)
    if (!stillExists) setActiveBlockId(null)
  }, [activeBlockId, rawNodes])

  useEffect(() => {
    if (!isFlowReady) return undefined
    if (!rawNodes.length) return undefined

    const instance = reactFlowRef.current
    const viewportElement = canvasShellRef.current
    if (!instance || !viewportElement) return undefined

    const bounds = computeGraphBounds(rawNodes)
    if (!bounds) return undefined

    const viewportRect = viewportElement.getBoundingClientRect()
    const viewport = buildInitialGraphViewport(bounds, viewportRect.width, viewportRect.height)
    if (!viewport) return undefined

    const viewportKey = [
      rawNodes.length,
      Math.round(bounds.minX),
      Math.round(bounds.minY),
      Math.round(bounds.maxX),
      Math.round(bounds.maxY)
    ].join(':')

    if (autoViewportKeyRef.current === viewportKey) return undefined

    autoViewportKeyRef.current = viewportKey

    let raf1 = 0
    let raf2 = 0
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        const latestInstance = reactFlowRef.current
        const latestViewportElement = canvasShellRef.current
        if (!latestInstance || !latestViewportElement) return

        const latestRect = latestViewportElement.getBoundingClientRect()
        const latestViewport = buildInitialGraphViewport(bounds, latestRect.width, latestRect.height)
        if (!latestViewport) return

        if (typeof latestInstance.setViewport === 'function') {
          latestInstance.setViewport(latestViewport, { duration: 0 })
        }
      })
    })

    return () => {
      if (raf1) window.cancelAnimationFrame(raf1)
      if (raf2) window.cancelAnimationFrame(raf2)
    }
  }, [isFlowReady, rawNodes])

  const highlightState = useMemo(() => buildHighlightMaps(rawNodes, rawEdges, activeBlockId), [rawNodes, rawEdges, activeBlockId])

  const nodes = useMemo(() => {
    if (!highlightState.hasActiveSelection) return rawNodes

    return rawNodes.map((node) => {
      const isActive = node.id === activeBlockId
      const isConnected = highlightState.connectedNodeIds.has(node.id)
      const isDimmed = !isConnected
      return {
        ...node,
        data: {
          ...(node.data || {}),
          isActive,
          isConnected,
          isDimmed
        }
      }
    })
  }, [rawNodes, activeBlockId, highlightState])

  const edges = useMemo(() => {
    if (isPanning) return []
    if (!highlightState.hasActiveSelection) return rawEdges

    return rawEdges.map((edge) => {
      const isHighlighted = highlightState.highlightedEdgeIds.has(edge.id)
      const isDimmed = !isHighlighted
      return {
        ...edge,
        data: {
          ...(edge.data || {}),
          isHighlighted,
          isDimmed
        }
      }
    })
  }, [rawEdges, highlightState, isPanning])

  const handleNodeClick = useCallback((event, node) => {
    event?.preventDefault?.()
    setActiveBlockId(node?.id || null)
  }, [])

  const handlePaneClick = useCallback(() => {
    setActiveBlockId(null)
  }, [])

  const handleMoveStart = useCallback(() => {
    setIsPanning(true)
  }, [])

  const handleMoveEnd = useCallback(() => {
    setIsPanning(false)
  }, [])

  const handleNodeDoubleClick = useCallback((event, node) => {
    event?.preventDefault?.()
    const nodeId = node?.id || null
    if (!nodeId) return
    setActiveBlockId(nodeId)
    focusGraphNodeById(reactFlowRef.current, canvasShellRef.current, rawNodes, nodeId, {
      mode: 'fixed',
      zoom: DOUBLE_CLICK_ZOOM,
      minZoom: 0.2,
      maxZoom: 2.2,
      duration: 180,
      padding: 28
    })
  }, [rawNodes])

  const headerText = useMemo(() => {
    const filename = graphData?.rom?.filename || 'Graph'
    const nodeCount = Array.isArray(graphData?.nodes) ? graphData.nodes.length : 0
    const edgeCount = Array.isArray(graphData?.edges) ? graphData.edges.length : 0
    const mapperNum = typeof graphData?.rom?.mapperNumber === 'number' ? graphData.rom.mapperNumber : null
    if (!hasLoadedGraphDataOnce) return 'Loading graph…'
    if (!graphData?.hasRom) return 'No ROM loaded'
    if (!graphData?.hasAnalysis) return `${filename} · Run analysis to populate the graph`
    return `${filename} · Mapper ${mapperNum ?? '?'} · ${nodeCount} blocks · ${edgeCount} edges`
  }, [graphData, hasLoadedGraphDataOnce])

  if (!hasLoadedGraphDataOnce) {
    return <div className="graph-empty-view">{status || 'Loading graph…'}</div>
  }

  if (!graphData?.hasRom) {
    return <div className="graph-empty-view">{status || 'No ROM loaded'}</div>
  }

  return (
    <div className="graph-window-root">
      <div className="graph-toolbar">
        <div className="graph-toolbar-title">Graph</div>
        <div className="graph-toolbar-meta">{headerText}</div>
      </div>

      {status ? <div className="graph-status-banner">{status}</div> : null}
      {!graphData?.hasAnalysis ? (
        <div className="graph-empty-view">Run static analysis to populate the graph.</div>
      ) : (
        <div ref={canvasShellRef} className="graph-canvas-shell">
          {layoutProgress.length && isProgressOverlayVisible ? (
            <div className="graph-loading-overlay">
              <button
                type="button"
                className="graph-loading-close"
                aria-label="Close progress overlay"
                onPointerDown={(event) => {
                  event.stopPropagation()
                }}
                onMouseDown={(event) => {
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  setIsProgressOverlayVisible(false)
                }}
              >
                ×
              </button>
              <div className="graph-loading-title">Building graph layout…</div>
              <div className="graph-loading-list">
                {layoutProgress.map((step) => (
                  <div key={step.id} className={`graph-loading-item is-${step.status || 'pending'}`}>
                    <div className="graph-loading-item-status">{progressSymbol(step.status)}</div>
                    <div className="graph-loading-item-body">
                      <div className="graph-loading-item-label">{step.label}</div>
                      {step.detail ? <div className="graph-loading-item-detail">{step.detail}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            onInit={(instance) => {
              reactFlowRef.current = instance
              setIsFlowReady(true)
            }}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onPaneClick={handlePaneClick}
            onMoveStart={handleMoveStart}
            onMoveEnd={handleMoveEnd}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onlyRenderVisibleElements
            nodesConnectable={false}
            nodesDraggable={false}
            elementsSelectable={false}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            zoomOnDoubleClick={false}
            minZoom={0.1}
            maxZoom={2.2}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'routed' }}
            className="graph-reactflow"
          >
            <Background gap={28} size={1} />
          </ReactFlow>
        </div>
      )}
    </div>
  )
}
