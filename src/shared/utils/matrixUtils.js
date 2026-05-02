export function makeIdentityMatrix(size) {
  return Array.from({ length: size }, (_row, rowIndex) => (
    Array.from({ length: size }, (_col, colIndex) => (rowIndex === colIndex ? 1 : 0))
  ));
}

export function cloneMatrix(matrix) {
  return Array.isArray(matrix) ? matrix.map((row) => Array.isArray(row) ? row.slice() : []) : [];
}

export function invertMatrix(matrix) {
  const size = Array.isArray(matrix) ? matrix.length : 0;
  if (!size) return null;
  const a = cloneMatrix(matrix);
  const inv = makeIdentityMatrix(size);

  for (let col = 0; col < size; col += 1) {
    let pivotRow = col;
    let pivotValue = Math.abs(a[pivotRow]?.[col] || 0);
    for (let row = col + 1; row < size; row += 1) {
      const candidate = Math.abs(a[row]?.[col] || 0);
      if (candidate > pivotValue) {
        pivotValue = candidate;
        pivotRow = row;
      }
    }
    if (!(pivotValue > 1e-12)) return null;
    if (pivotRow !== col) {
      [a[col], a[pivotRow]] = [a[pivotRow], a[col]];
      [inv[col], inv[pivotRow]] = [inv[pivotRow], inv[col]];
    }

    const pivot = a[col][col];
    for (let j = 0; j < size; j += 1) {
      a[col][j] /= pivot;
      inv[col][j] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      if (!factor) continue;
      for (let j = 0; j < size; j += 1) {
        a[row][j] -= factor * a[col][j];
        inv[row][j] -= factor * inv[col][j];
      }
    }
  }

  return inv;
}

export function computeCovarianceMatrix(rows) {
  const sampleCount = Array.isArray(rows) ? rows.length : 0;
  const featureCount = sampleCount ? rows[0].length : 0;
  const cov = Array.from({ length: featureCount }, () => Array.from({ length: featureCount }, () => 0));
  if (!sampleCount || !featureCount) return cov;
  if (sampleCount === 1) {
    for (let i = 0; i < featureCount; i += 1) cov[i][i] = 1;
    return cov;
  }
  for (const row of rows) {
    for (let i = 0; i < featureCount; i += 1) {
      const xi = row[i] || 0;
      for (let j = i; j < featureCount; j += 1) {
        cov[i][j] += xi * (row[j] || 0);
      }
    }
  }
  const denom = sampleCount - 1;
  for (let i = 0; i < featureCount; i += 1) {
    for (let j = i; j < featureCount; j += 1) {
      const value = cov[i][j] / denom;
      cov[i][j] = value;
      cov[j][i] = value;
    }
  }
  return cov;
}

export function addDiagonalRegularization(matrix, lambda) {
  const out = cloneMatrix(matrix);
  for (let i = 0; i < out.length; i += 1) {
    out[i][i] = (out[i][i] || 0) + lambda;
  }
  return out;
}
