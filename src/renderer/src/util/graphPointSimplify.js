function isFinitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y)
}

function isExactlyCollinearMiddle(prev, current, next) {
  if (!isFinitePoint(prev) || !isFinitePoint(current) || !isFinitePoint(next)) return false

  const abx = current.x - prev.x
  const aby = current.y - prev.y
  const bcx = next.x - current.x
  const bcy = next.y - current.y
  const cross = (abx * bcy) - (aby * bcx)
  if (cross !== 0) return false

  const acx = next.x - prev.x
  const acy = next.y - prev.y
  const betweenDot = ((current.x - prev.x) * (current.x - next.x)) + ((current.y - prev.y) * (current.y - next.y))
  if (betweenDot > 0) return false

  return acx !== 0 || acy !== 0
}

export function collapseExactlyCollinearPoints(points, options = {}) {
  const pointList = Array.isArray(points) ? points.filter(isFinitePoint) : []
  if (pointList.length < 3) {
    return {
      points: pointList,
      collapsedCount: 0
    }
  }

  const simplified = [pointList[0]]
  let collapsedCount = 0

  for (let index = 1; index < pointList.length - 1; index++) {
    const prev = simplified[simplified.length - 1]
    const current = pointList[index]
    const next = pointList[index + 1]
    if (isExactlyCollinearMiddle(prev, current, next)) {
      collapsedCount += 1
      continue
    }
    simplified.push(current)
  }

  simplified.push(pointList[pointList.length - 1])

  if (collapsedCount > 0) {
    console.log('[NesViz graph] collapsed collinear edge points', {
      edgeId: options?.edgeId || null,
      context: options?.context || null,
      beforeCount: pointList.length,
      afterCount: simplified.length,
      collapsedCount
    })
  }

  return {
    points: simplified,
    collapsedCount
  }
}
