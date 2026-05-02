export function lerpChannel(a, b, t) {
  return Math.round(a + ((b - a) * t));
}
