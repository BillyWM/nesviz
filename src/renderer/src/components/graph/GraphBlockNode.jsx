import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'

import { GRAPH_NODE_CSS_VARS } from '../../util/graphGeometry.js'
import { fmtHex } from '../../../../shared/utils/numberUtils.js'

function positionForSide(side, fallback) {
  if (side === 'NORTH') return Position.Top
  if (side === 'SOUTH') return Position.Bottom
  return fallback
}

function portStyle(port, side) {
  const style = {}
  if ((side === 'EAST' || side === 'WEST') && typeof port?.top === 'number' && Number.isFinite(port.top)) {
    style.top = `${port.top}px`
  }
  if ((side === 'NORTH' || side === 'SOUTH') && typeof port?.left === 'number' && Number.isFinite(port.left)) {
    style.left = `${port.left}px`
  }
  return style
}

function GraphBlockNode({ data }) {
  const lines = Array.isArray(data?.lines) ? data.lines : []
  const sourcePorts = Array.isArray(data?.sourcePorts) ? data.sourcePorts : []
  const targetPorts = Array.isArray(data?.targetPorts) ? data.targetPorts : []
  const isActive = data?.isActive === true
  const isDimmed = data?.isDimmed === true

  return (
    <div
      className={`graph-node ${isActive ? 'is-active' : ''} ${isDimmed ? 'is-dimmed' : ''}`}
      style={GRAPH_NODE_CSS_VARS}
    >
      {targetPorts.map((port) => {
        const side = typeof port?.side === 'string' ? port.side : 'WEST'
        return (
          <Handle
            key={port.id}
            id={port.id}
            type="target"
            position={positionForSide(side, Position.Left)}
            isConnectable={false}
            className="graph-node-handle graph-node-handle--target"
            style={portStyle(port, side)}
          />
        )
      })}
      {sourcePorts.map((port) => {
        const side = typeof port?.side === 'string' ? port.side : 'EAST'
        return (
          <Handle
            key={port.id}
            id={port.id}
            type="source"
            position={positionForSide(side, Position.Right)}
            isConnectable={false}
            className="graph-node-handle graph-node-handle--source"
            style={portStyle(port, side)}
          />
        )
      })}

      <div className="graph-node-header">
        <div className="graph-node-title">{data?.title || data?.id}</div>
      </div>
      <div className="graph-node-subtitle">{data?.subtitle || ''}</div>

      <div className="graph-node-lines">
        {lines.map((line, index) => (
          <div
            key={`${data?.id || 'node'}:${typeof line?.romOff === 'number' ? `rom:${line.romOff}` : 'line'}:${index}`}
            className="graph-node-line"
          >
            <div className="graph-node-line-cpu">{typeof line?.cpuAddr === 'number' ? `$${fmtHex(line.cpuAddr, 4)}` : '—'}</div>
            <div className="graph-node-line-asm">{line?.asm || ''}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default memo(GraphBlockNode)
