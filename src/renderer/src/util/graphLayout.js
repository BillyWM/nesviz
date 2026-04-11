import { GRAPH_NODE_WIDTH } from './graphGeometry.js'

const DEFAULTS = {
  columnGap: 340,
  rowGap: 32,
  componentGap: 180,
  nodeWidth: GRAPH_NODE_WIDTH
};

function getOrderedNodes(nodesById) {
  return Array.from(nodesById.values()).sort((a, b) => {
    const aRom = Number.isFinite(a?.data?.romStart) ? a.data.romStart : Number.MAX_SAFE_INTEGER;
    const bRom = Number.isFinite(b?.data?.romStart) ? b.data.romStart : Number.MAX_SAFE_INTEGER;
    if (aRom !== bRom) return aRom - bRom;
    const aCpu = Number.isFinite(a?.data?.cpuStart) ? a.data.cpuStart : Number.MAX_SAFE_INTEGER;
    const bCpu = Number.isFinite(b?.data?.cpuStart) ? b.data.cpuStart : Number.MAX_SAFE_INTEGER;
    if (aCpu !== bCpu) return aCpu - bCpu;
    return String(a.id).localeCompare(String(b.id));
  });
}

function buildComponent(startId, adjacency) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const next = adjacency.get(id);
    if (!next) continue;
    for (const other of next) {
      if (!visited.has(other)) queue.push(other);
    }
  }
  return visited;
}

export function layoutGraphNodes(nodes, edges, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const nodesById = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  const orderedNodes = getOrderedNodes(nodesById);
  const outgoing = new Map();
  const incomingCount = new Map();
  const undirected = new Map();

  for (const node of orderedNodes) {
    outgoing.set(node.id, []);
    incomingCount.set(node.id, 0);
    undirected.set(node.id, new Set());
  }

  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;
    outgoing.get(edge.source).push(edge.target);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) || 0) + 1);
    undirected.get(edge.source).add(edge.target);
    undirected.get(edge.target).add(edge.source);
  }

  const unassigned = new Set(orderedNodes.map((node) => node.id));
  const positioned = [];
  let componentX = 0;

  while (unassigned.size) {
    const seed = orderedNodes.find((node) => unassigned.has(node.id));
    if (!seed) break;

    const componentIds = buildComponent(seed.id, undirected);
    for (const id of componentIds) unassigned.delete(id);

    const componentNodes = orderedNodes.filter((node) => componentIds.has(node.id));
    const roots = componentNodes.filter((node) => (incomingCount.get(node.id) || 0) === 0);
    const startQueue = (roots.length ? roots : [componentNodes[0]]).map((node) => node.id);

    const depth = new Map();
    const queue = [...startQueue];
    for (const id of startQueue) depth.set(id, 0);

    while (queue.length) {
      const id = queue.shift();
      const baseDepth = depth.get(id) || 0;
      const nextIds = outgoing.get(id) || [];
      for (const nextId of nextIds) {
        if (!componentIds.has(nextId)) continue;
        if (!depth.has(nextId)) {
          depth.set(nextId, baseDepth + 1);
          queue.push(nextId);
        }
      }
    }

    for (const node of componentNodes) {
      if (!depth.has(node.id)) depth.set(node.id, 0);
    }

    const columns = new Map();
    for (const node of componentNodes) {
      const col = depth.get(node.id) || 0;
      if (!columns.has(col)) columns.set(col, []);
      columns.get(col).push(node);
    }

    const orderedColumns = Array.from(columns.keys()).sort((a, b) => a - b);
    let componentRight = componentX;

    for (const col of orderedColumns) {
      const columnNodes = columns.get(col).slice().sort((a, b) => {
        const aRom = Number.isFinite(a?.data?.romStart) ? a.data.romStart : Number.MAX_SAFE_INTEGER;
        const bRom = Number.isFinite(b?.data?.romStart) ? b.data.romStart : Number.MAX_SAFE_INTEGER;
        if (aRom !== bRom) return aRom - bRom;
        const aCpu = Number.isFinite(a?.data?.cpuStart) ? a.data.cpuStart : Number.MAX_SAFE_INTEGER;
        const bCpu = Number.isFinite(b?.data?.cpuStart) ? b.data.cpuStart : Number.MAX_SAFE_INTEGER;
        if (aCpu !== bCpu) return aCpu - bCpu;
        return String(a.id).localeCompare(String(b.id));
      });

      let y = 0;
      for (const node of columnNodes) {
        const width = Number.isFinite(node?.width) ? node.width : cfg.nodeWidth;
        const height = Number.isFinite(node?.height) ? node.height : 120;
        positioned.push({
          ...node,
          position: {
            x: componentX + col * (cfg.nodeWidth + cfg.columnGap),
            y
          }
        });
        y += height + cfg.rowGap;
        componentRight = Math.max(componentRight, componentX + col * (cfg.nodeWidth + cfg.columnGap) + width);
      }
    }

    componentX = componentRight + cfg.componentGap;
  }

  return positioned;
}
