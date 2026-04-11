let elkPromise = null

async function getElk() {
  if (!elkPromise) {
    elkPromise = Promise.all([
      import('elkjs/lib/elk-api'),
      import('elkjs/lib/elk-worker.min.js?url')
    ]).then(([apiModule, workerUrlModule]) => {
      const ELK = apiModule?.default || apiModule
      const workerUrl = workerUrlModule?.default || workerUrlModule
      if (typeof ELK !== 'function') {
        throw new Error('ELK API constructor unavailable')
      }
      if (typeof workerUrl !== 'string' || !workerUrl) {
        throw new Error('ELK worker URL unavailable')
      }
      return new ELK({ workerUrl })
    })
  }

  return elkPromise
}

function emitProgress(onProgress, stepId, patch = {}) {
  if (typeof onProgress !== 'function') return
  onProgress({ stepId, ...patch })
}

function summarizeElkEdge(edge) {
  const sections = Array.isArray(edge?.sections) ? edge.sections : []
  const firstSection = sections[0] || null
  const bendCount = Array.isArray(firstSection?.bendPoints) ? firstSection.bendPoints.length : 0
  return {
    id: edge?.id || null,
    sectionCount: sections.length,
    hasSections: sections.length > 0,
    firstSectionHasStart: Boolean(firstSection?.startPoint),
    firstSectionHasEnd: Boolean(firstSection?.endPoint),
    firstSectionBendCount: bendCount,
    sources: Array.isArray(edge?.sources) ? edge.sources : null,
    targets: Array.isArray(edge?.targets) ? edge.targets : null
  }
}

function logElkResultSummary(elkGraph, laidOutGraph) {
  const inputNodes = Array.isArray(elkGraph?.children) ? elkGraph.children : []
  const inputEdges = Array.isArray(elkGraph?.edges) ? elkGraph.edges : []
  const resultNodes = Array.isArray(laidOutGraph?.children) ? laidOutGraph.children : []
  const resultEdges = Array.isArray(laidOutGraph?.edges) ? laidOutGraph.edges : []
  const inputEdgeIds = new Set(inputEdges.map((edge) => edge?.id).filter(Boolean))
  const resultEdgeIds = new Set(resultEdges.map((edge) => edge?.id).filter(Boolean))
  const missingEdgeIds = []
  for (const id of inputEdgeIds) {
    if (!resultEdgeIds.has(id)) missingEdgeIds.push(id)
    if (missingEdgeIds.length >= 12) break
  }
  const edgesWithSections = resultEdges.filter((edge) => Array.isArray(edge?.sections) && edge.sections.length > 0)
  const edgesWithoutSections = resultEdges.filter((edge) => !Array.isArray(edge?.sections) || edge.sections.length === 0)

  console.groupCollapsed('[NesViz graph] ELK result summary')
  console.log('input', {
    nodeCount: inputNodes.length,
    edgeCount: inputEdges.length,
    sampleEdgeIds: inputEdges.slice(0, 8).map((edge) => edge?.id || null)
  })
  console.log('result', {
    nodeCount: resultNodes.length,
    edgeCount: resultEdges.length,
    edgesWithSections: edgesWithSections.length,
    edgesWithoutSections: edgesWithoutSections.length,
    missingReturnedEdgeIds: missingEdgeIds,
    sampleEdgeIds: resultEdges.slice(0, 8).map((edge) => edge?.id || null)
  })
  if (edgesWithSections.length) {
    console.log('sample edge with sections', summarizeElkEdge(edgesWithSections[0]))
  }
  if (edgesWithoutSections.length) {
    console.log('sample edge without sections', summarizeElkEdge(edgesWithoutSections[0]))
  }
  if (resultEdges.length) {
    console.log('raw first returned edge', resultEdges[0])
  }
  console.groupEnd()
}

export async function runElkLayoutOnMainThread(elkGraph, onProgress) {
  const nodeCount = Array.isArray(elkGraph?.children) ? elkGraph.children.length : 0
  const edgeCount = Array.isArray(elkGraph?.edges) ? elkGraph.edges.length : 0

  emitProgress(onProgress, 'elkLayout', {
    status: 'active',
    detail: `${nodeCount} nodes, ${edgeCount} edges`
  })

  const elk = await getElk()
  const laidOutGraph = await elk.layout(elkGraph)
  logElkResultSummary(elkGraph, laidOutGraph)

  emitProgress(onProgress, 'elkLayout', {
    status: 'done',
    detail: `${nodeCount} nodes, ${edgeCount} edges`
  })

  return laidOutGraph
}
