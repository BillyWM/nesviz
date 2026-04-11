import { memo } from 'react'

function buildPathFromPoints(points) {
  const pathPoints = Array.isArray(points) ? points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)) : []
  if (pathPoints.length < 2) return ''

  let path = `M ${pathPoints[0].x} ${pathPoints[0].y}`
  for (let index = 1; index < pathPoints.length; index++) {
    const point = pathPoints[index]
    path += ` L ${point.x} ${point.y}`
  }
  return path
}

function RoutedGraphEdge({ id, sourceX, sourceY, targetX, targetY, data }) {
  const routedPoints = Array.isArray(data?.points) && data.points.length >= 2
    ? data.points
    : [
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY }
      ]

  const path = buildPathFromPoints(routedPoints)
  if (!path) return null

  const isHighlighted = data?.isHighlighted === true
  const isDimmed = data?.isDimmed === true

  const isFallthrough = data?.kind === 'fallthrough'

  return (
    <g
      className={`graph-edge ${isFallthrough ? 'is-fallthrough' : ''} ${isHighlighted ? 'is-highlighted' : ''} ${isDimmed ? 'is-dimmed' : ''}`}
      data-edgeid={id}
    >
      <path className="graph-edge-path" d={path} fill="none" />
    </g>
  )
}

export default memo(RoutedGraphEdge)
