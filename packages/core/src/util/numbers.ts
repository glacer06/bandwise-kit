// Small numeric helpers shared by the band rules, conditions and money math.

/** round_half_up(x) = floor(x + 0.5), the rounding used for money and score levels. */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/**
 * Threshold arithmetic without float drift: 0.85 - 0.1 is 0.7499999999999999 in binary floating
 * point, which would move a noul of exactly 0.75 out of the medium band. Thresholds are given to at
 * most a few decimals, so rounding to 1e-9 restores the intended edge.
 */
export function edge(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}
