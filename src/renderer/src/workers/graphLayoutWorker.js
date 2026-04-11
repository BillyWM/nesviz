import { planGraphChunks } from '../util/graphChunkPlanner.js'
import { prepareChunkLayouts } from '../util/graphChunkLayoutPipeline.js'

self.onmessage = async (event) => {
  const payload = event?.data || {}
  if (payload?.type !== 'buildGraphLayout') return

  const graphNodes = Array.isArray(payload?.graphNodes) ? payload.graphNodes : []
  const graphEdges = Array.isArray(payload?.graphEdges) ? payload.graphEdges : []
  const measurementsByNode = new Map(Object.entries(payload?.nodeMeasurements || {}))

  try {
    const chunkPlan = planGraphChunks(graphNodes, graphEdges, {
      threshold: Number.isFinite(payload?.chunkThreshold) ? payload.chunkThreshold : 100
    })

    self.postMessage({
      type: 'chunkPlan',
      chunkPlan: {
        totalChunkCount: chunkPlan.totalChunkCount,
        totalNodeCount: chunkPlan.totalNodeCount,
        totalInternalEdgeCount: chunkPlan.totalInternalEdgeCount,
        totalBoundaryEdgeCount: chunkPlan.totalBoundaryEdgeCount
      }
    })

    prepareChunkLayouts(graphNodes, graphEdges, measurementsByNode, chunkPlan, {
      onProgress: (progress) => {
        self.postMessage({ type: 'progress', progress })
      },
      onChunkPrepared: ({ chunk, prepared, chunkTotals }) => {
        self.postMessage({
          type: 'chunkPrepared',
          chunk,
          prepared,
          chunkTotals
        })
      }
    })

    self.postMessage({ type: 'chunksComplete', ok: true })
  } catch (error) {
    self.postMessage({
      type: 'chunksComplete',
      ok: false,
      error: error?.message ?? String(error),
      stack: error?.stack || null
    })
  }
}
