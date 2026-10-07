/**
 * 小番茄混淆 (Gilbert curve pixel permutation) — port of xfq_tool.py.
 *
 * `gilbertCurve(w, h)` enumerates every pixel of the w×h grid exactly once. The
 * golden-ratio offset `L = round((sqrt(5)-1)/2 * w*h)` shifts that enumeration,
 * and one pass either writes pixel `u[s]` to `u[(s+L) % d]` (`enc`) or reads it
 * from there (`dec`), so `dec` is the exact inverse of `enc`. Repeating the
 * permutation `times` times matches `xfq_tool.py --times N`.
 */

export function gilbertCurve(w, h) {
  // A zero or negative extent has no pixels; without this the recursion never
  // reaches its base case. Such an image is rejected before it gets here, but
  // the helper is exported.
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return []
  const points = []
  const walk = (t, n, e, o, c, a) => {
    const m = Math.abs(e + o)
    const l = Math.abs(c + a)
    const u = Math.sign(e)
    const d = Math.sign(o)
    const L = Math.sign(c)
    const s = Math.sign(a)
    if (l === 1) {
      for (let i = 0; i < m; i++) {
        points.push([t, n])
        t += u
        n += d
      }
      return
    }
    if (m === 1) {
      for (let i = 0; i < l; i++) {
        points.push([t, n])
        t += L
        n += s
      }
      return
    }
    let ph = Math.floor(e / 2)
    let pg = Math.floor(o / 2)
    let pi = Math.floor(c / 2)
    let pf = Math.floor(a / 2)
    if (2 * m > 3 * l) {
      if (Math.abs(ph + pg) % 2 === 1 && m > 2) {
        ph += u
        pg += d
      }
      walk(t, n, ph, pg, c, a)
      walk(t + ph, n + pg, e - ph, o - pg, c, a)
    } else {
      if (Math.abs(pi + pf) % 2 === 1 && l > 2) {
        pi += L
        pf += s
      }
      walk(t, n, pi, pf, ph, pg)
      walk(t + pi, n + pf, e, o, c - pi, a - pf)
      walk(t + (e - u) + (pi - L), n + (o - d) + (pf - s), -pi, -pf, -(e - ph), -(o - pg))
    }
  }
  if (w >= h) walk(0, 0, w, 0, 0, h)
  else walk(0, 0, 0, h, w, 0)
  return points
}

/** One enc/dec pass. `image` is `{width, height, channels, data}` (row major). */
export function xfqTransform({ width, height, channels, data }, mode) {
  if (mode !== 'enc' && mode !== 'dec') throw new Error(`mode must be 'enc' or 'dec', got ${mode}`)
  const pixels = width * height
  // Python's round() is half-to-even, but (sqrt(5)-1)/2 * d never lands on an
  // exact .5 for any pixel count, so Math.round gives the same L.
  const offset = Math.round(((Math.sqrt(5) - 1) / 2) * pixels)
  const curve = gilbertCurve(width, height)
  if (curve.length !== pixels) throw new Error(`Gilbert curve covered ${curve.length} of ${pixels} pixels for ${width}x${height}`)
  const order = new Uint32Array(pixels)
  for (let s = 0; s < pixels; s++) order[s] = curve[s][0] + curve[s][1] * width
  const out = new Uint8Array(data.length)
  let shifted = offset % pixels
  if (mode === 'enc') {
    for (let s = 0; s < pixels; s++) {
      const from = order[s] * channels
      const to = order[shifted] * channels
      for (let k = 0; k < channels; k++) out[to + k] = data[from + k]
      if (++shifted === pixels) shifted = 0
    }
  } else {
    for (let s = 0; s < pixels; s++) {
      const to = order[s] * channels
      const from = order[shifted] * channels
      for (let k = 0; k < channels; k++) out[to + k] = data[from + k]
      if (++shifted === pixels) shifted = 0
    }
  }
  return { width, height, channels, data: out }
}

/** `xfq_tool.py --times N`: N passes in the same direction. */
export function transformTimes(image, mode, times) {
  let current = image
  for (let i = 0; i < times; i++) current = xfqTransform(current, mode)
  return current
}