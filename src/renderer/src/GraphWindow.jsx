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
import {
  buildCrossChunkEdgesForChunk,
  createChunkPackingState,
  placeChunkLayout
} from './util/graphChunkLayoutPipeline.js'

const DOUBLE_CLICK_ZOOM = 0.92
const CHUNK_THRESHOLD = 100
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

export default function GraphWindow() {
  const [graphData, setGraphData] = useState(null)
  const [status, setStatus] = useState('')
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
  const packingStateRef = useRef(createChunkPackingState())
  const visibleNodesByIdRef = useRef(new Map())
  const visibleEdgesByIdRef = useRef(new Map())
  const renderedEdgeIdsRef = useRef(new Set())
  const completedChunkIdsRef = useRef(new Set())
  const edgeByIdRef = useRef(new Map())
  const totalsRef = useRef({ totalNodes: 0, totalEdges: 0, totalInternalEdges: 0, totalChunks: 0 })
  const completedRef = useRef({ elkNodes: 0, elkEdges: 0, finalizedEdges: 0, renderedNodes: 0, renderedEdges: 0 })

  const stopLayoutWorker = useCallback(() => {
    if (layoutWorkerRef.current) {
      layoutWorkerRef.current.terminate()
      layoutWorkerRef.current = null
    }
  }, [])

  const resetBuildState = useCallback(() => {
    preparedChunkQueueRef.current = []
    processingChunkRef.current = false
    workerCompleteRef.current = false
    packingStateRef.current = createChunkPackingState()
    visibleNodesByIdRef.current = new Map()
    visibleEdgesByIdRef.current = new Map()
    renderedEdgeIdsRef.current = new Set()
    completedChunkIdsRef.current = new Set()
    edgeByIdRef.current = new Map()
    totalsRef.current = { totalNodes: 0, totalEdges: 0, totalInternalEdges: 0, totalChunks: 0 }
    completedRef.current = { elkNodes: 0, elkEdges: 0, finalizedEdges: 0, renderedNodes: 0, renderedEdges: 0 }
  }, [])

  const finishBuildIfIdle = useCallback((requestId, reload) => {
    if (requestIdRef.current !== requestId) return
    if (!workerCompleteRef.current) return
    if (processingChunkRef.current) return
    if (preparedChunkQueueRef.current.length) return

    const totals = totalsRef.current
    const completed = completedRef.current

    setLayoutProgress((prev) => updateLayoutProgress(
      updateLayoutProgress(
        updateLayoutProgress(prev, 'elkLayout', {
          status: 'done',
          detail: createNodeEdgeDetail(completed.elkNodes, totals.totalNodes, completed.elkEdges, totals.totalInternalEdges)
        }),
        'finalize',
        {
          status: 'done',
          detail: createNodeEdgeDetail(completed.renderedNodes, totals.totalNodes, completed.finalizedEdges, totals.totalInternalEdges)
        }
      ),
      'render',
      {
        status: 'done',
        detail: createNodeEdgeDetail(completed.renderedNodes, totals.totalNodes, completed.renderedEdges, totals.totalEdges)
      }
    ))

    buildInFlightRef.current = false
    stopLayoutWorker()
    if (queuedReloadRef.current) {
      queuedReloadRef.current = false
      reload()
    }
  }, [stopLayoutWorker])

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
          detail: createNodeEdgeDetail(completedRef.current.renderedNodes, totals.totalNodes, completedRef.current.finalizedEdges, totals.totalInternalEdges)
        }))

        const built = finalizeGraphLayout(prepared, laidOutGraph)
        const placed = placeChunkLayout(built, packingStateRef.current)
        completedChunkIdsRef.current.add(chunk.chunkId)

        for (const node of placed.nodes) {
          visibleNodesByIdRef.current.set(node.id, node)
        }
        for (const edge of placed.edges) {
          visibleEdgesByIdRef.current.set(edge.id, edge)
          renderedEdgeIdsRef.current.add(edge.id)
        }

        const crossEdges = buildCrossChunkEdgesForChunk(chunk, {
          completedChunkIds: completedChunkIdsRef.current,
          nodesById: visibleNodesByIdRef.current,
          edgeById: edgeByIdRef.current,
          renderedEdgeIds: renderedEdgeIdsRef.current
        })
        for (const edge of crossEdges) {
          visibleEdgesByIdRef.current.set(edge.id, edge)
          renderedEdgeIdsRef.current.add(edge.id)
        }

        completedRef.current = {
          ...completedRef.current,
          finalizedEdges: completedRef.current.finalizedEdges + chunk.internalEdgeCount,
          renderedNodes: visibleNodesByIdRef.current.size,
          renderedEdges: visibleEdgesByIdRef.current.size
        }

        setRawNodes((prev) => prev.concat(placed.nodes))
        setRawEdges((prev) => prev.concat(placed.edges, crossEdges))

        setLayoutProgress((prev) => updateLayoutProgress(
          updateLayoutProgress(prev, 'finalize', {
            status: completedRef.current.finalizedEdges >= totals.totalInternalEdges ? 'done' : 'active',
            detail: createNodeEdgeDetail(completedRef.current.renderedNodes, totals.totalNodes, completedRef.current.finalizedEdges, totals.totalInternalEdges)
          }),
          'render',
          {
            status: completedRef.current.renderedEdges >= totals.totalEdges ? 'done' : 'active',
            detail: createNodeEdgeDetail(completedRef.current.renderedNodes, totals.totalNodes, completedRef.current.renderedEdges, totals.totalEdges)
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
        return
      }

      setGraphData(res)
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
    if (!graphData?.hasRom) return 'No ROM loaded'
    if (!graphData?.hasAnalysis) return `${filename} · Run analysis to populate the graph`
    return `${filename} · Mapper ${mapperNum ?? '?'} · ${nodeCount} blocks · ${edgeCount} edges`
  }, [graphData])

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
                onClick={() => setIsProgressOverlayVisible(false)}
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
