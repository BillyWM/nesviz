function sortIdsByDegree(unassignedIds, degreeById) {
  return Array.from(unassignedIds).sort((a, b) => {
    const degreeDiff = (degreeById.get(b) || 0) - (degreeById.get(a) || 0)
    if (degreeDiff !== 0) return degreeDiff
    return String(a).localeCompare(String(b))
  })
}

function uniqueNeighborsFor(nodeId, adjacency) {
  return adjacency.get(nodeId) || new Set()
}

function growSeedNeighborhood(seedNodeId, unassigned, adjacency, threshold) {
  const groupNodeIds = new Set([seedNodeId])
  let frontier = new Set([seedNodeId])
  let hopCount = 0

  while (frontier.size) {
    const nextFrontier = new Set()
    for (const nodeId of frontier) {
      for (const neighborId of uniqueNeighborsFor(nodeId, adjacency)) {
        if (!unassigned.has(neighborId) || groupNodeIds.has(neighborId)) continue
        nextFrontier.add(neighborId)
      }
    }

    if (!nextFrontier.size) break
    hopCount += 1
    for (const nodeId of nextFrontier) {
      groupNodeIds.add(nodeId)
    }
    frontier = nextFrontier
    if (groupNodeIds.size >= threshold) break
  }

  return {
    seedNodeId,
    hopCount,
    nodeIds: Array.from(groupNodeIds)
  }
}

export function planGraphChunks(graphNodes, graphEdges, options = {}) {
  const threshold = Number.isFinite(options?.threshold) ? Math.max(1, Math.trunc(options.threshold)) : 100
  const nodeIds = Array.isArray(graphNodes) ? graphNodes.map((node) => node?.id).filter(Boolean) : []
  const adjacency = new Map()
  const degreeById = new Map()
  const nodeToChunkId = new Map()

  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, new Set())
    degreeById.set(nodeId, 0)
  }

  for (const edge of Array.isArray(graphEdges) ? graphEdges : []) {
    const source = edge?.source
    const target = edge?.target
    if (!source || !target || source === target) continue
    if (!adjacency.has(source) || !adjacency.has(target)) continue
    adjacency.get(source).add(target)
    adjacency.get(target).add(source)
  }

  for (const nodeId of nodeIds) {
    degreeById.set(nodeId, uniqueNeighborsFor(nodeId, adjacency).size)
  }

  const unassigned = new Set(nodeIds)
  const chunks = []

  while (unassigned.size) {
    const chunkNodeIds = new Set()
    const seedNodeIds = []
    let totalHopCount = 0

    while (unassigned.size && chunkNodeIds.size < threshold) {
      const [seedNodeId] = sortIdsByDegree(unassigned, degreeById)
      if (!seedNodeId) break

      const grown = growSeedNeighborhood(seedNodeId, unassigned, adjacency, threshold)
      seedNodeIds.push(seedNodeId)
      totalHopCount += grown.hopCount

      for (const nodeId of grown.nodeIds) {
        chunkNodeIds.add(nodeId)
        unassigned.delete(nodeId)
      }
    }

    const chunkId = `chunk:${chunks.length + 1}`
    const sortedNodeIds = Array.from(chunkNodeIds).sort((a, b) => String(a).localeCompare(String(b)))
    for (const nodeId of sortedNodeIds) {
      nodeToChunkId.set(nodeId, chunkId)
    }

    chunks.push({
      chunkId,
      chunkIndex: chunks.length,
      seedNodeId: seedNodeIds[0] || null,
      seedNodeIds,
      groupCount: seedNodeIds.length,
      hopCount: totalHopCount,
      nodeIds: sortedNodeIds
    })
  }

  const edgeIdsByChunkId = new Map(chunks.map((chunk) => [chunk.chunkId, { internalEdgeIds: [], boundaryEdges: [] }]))
  const internalEdgeIds = []
  const boundaryEdgeIds = []

  for (const edge of Array.isArray(graphEdges) ? graphEdges : []) {
    const sourceChunkId = nodeToChunkId.get(edge?.source)
    const targetChunkId = nodeToChunkId.get(edge?.target)
    if (!sourceChunkId || !targetChunkId) continue
    if (sourceChunkId === targetChunkId) {
      edgeIdsByChunkId.get(sourceChunkId).internalEdgeIds.push(edge.id)
      internalEdgeIds.push(edge.id)
      continue
    }

    boundaryEdgeIds.push(edge.id)
    edgeIdsByChunkId.get(sourceChunkId).boundaryEdges.push({ edgeId: edge.id, otherChunkId: targetChunkId })
    edgeIdsByChunkId.get(targetChunkId).boundaryEdges.push({ edgeId: edge.id, otherChunkId: sourceChunkId })
  }

  const finalizedChunks = chunks.map((chunk, index) => {
    const edgeLists = edgeIdsByChunkId.get(chunk.chunkId) || { internalEdgeIds: [], boundaryEdges: [] }
    return {
      ...chunk,
      chunkIndex: index,
      totalChunks: chunks.length,
      internalEdgeIds: edgeLists.internalEdgeIds,
      boundaryEdges: edgeLists.boundaryEdges,
      nodeCount: chunk.nodeIds.length,
      internalEdgeCount: edgeLists.internalEdgeIds.length,
      boundaryEdgeCount: edgeLists.boundaryEdges.length
    }
  })

  return {
    chunks: finalizedChunks,
    nodeToChunkId,
    totalNodeCount: nodeIds.length,
    totalInternalEdgeCount: internalEdgeIds.length,
    totalBoundaryEdgeCount: boundaryEdgeIds.length,
    totalChunkCount: finalizedChunks.length
  }
}
