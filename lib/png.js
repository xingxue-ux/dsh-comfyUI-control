/**
 * Dependency-free PNG codec over node:zlib.
 *
 * `decodePng` expands every supported PNG to 8-bit RGB or RGBA: gray samples
 * are replicated, palette entries come from PLTE (+ tRNS alpha), 16-bit samples
 * keep their most significant byte, and 1/2/4-bit gray is scaled by 255/max.
 * The output has 4 channels exactly when the source carries alpha (colour type
 * 4/6, or a tRNS chunk); everything else is RGB. Adam7 interlacing is rejected
 * because a space-filling-curve permutation needs the whole pixel grid.
 *
 * `encodePng` writes one filter-0 IDAT and can re-attach the input's original
 * tEXt/iTXt/zTXt chunks verbatim, which is what `preserve_meta` needs. Only
 * 8-bit RGB/RGBA is written, matching the upstream PIL `convert('RGB')` path.
 */
import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEXT_TYPES = new Set(['tEXt', 'iTXt', 'zTXt'])
const METADATA_KEYS = new Set(['parameters', 'prompt', 'workflow', 'Comment', 'Description'])
/** Samples per pixel, and the bit depths this codec understands, per colour type. */
const SAMPLES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, payload) {
  const data = Buffer.from(payload)
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft
  const pa = Math.abs(p - left)
  const pb = Math.abs(p - up)
  const pc = Math.abs(p - upLeft)
  if (pa <= pb && pa <= pc) return left
  return pb <= pc ? up : upLeft
}

/** Undo the per-row PNG filters in place; `bpp` is at least one byte. */
function unfilter(raw, height, bytesPerRow, bpp) {
  const stride = bytesPerRow + 1
  for (let y = 0; y < height; y++) {
    const base = y * stride
    const filter = raw[base]
    if (filter === 0) continue
    const row = raw.subarray(base + 1, base + 1 + bytesPerRow)
    const prev = y === 0 ? undefined : raw.subarray(base - stride + 1, base - stride + 1 + bytesPerRow)
    if (filter === 1) {
      for (let i = bpp; i < bytesPerRow; i++) row[i] = (row[i] + row[i - bpp]) & 0xff
    } else if (filter === 2) {
      if (!prev) continue
      for (let i = 0; i < bytesPerRow; i++) row[i] = (row[i] + prev[i]) & 0xff
    } else if (filter === 3) {
      for (let i = 0; i < bytesPerRow; i++) {
        const left = i >= bpp ? row[i - bpp] : 0
        const up = prev ? prev[i] : 0
        row[i] = (row[i] + ((left + up) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let i = 0; i < bytesPerRow; i++) {
        const left = i >= bpp ? row[i - bpp] : 0
        const up = prev ? prev[i] : 0
        const upLeft = prev && i >= bpp ? prev[i - bpp] : 0
        row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff
      }
    } else {
      throw new Error(`unknown PNG filter type ${filter} on row ${y}`)
    }
  }
}

/** One filtered scanline to raw sample values (MSB first for sub-byte depths). */
function expandRow(row, width, bitDepth, samplesPerPixel) {
  const samples = new Uint16Array(width * samplesPerPixel)
  if (bitDepth === 8) {
    for (let i = 0; i < samples.length; i++) samples[i] = row[i]
    return samples
  }
  if (bitDepth === 16) {
    for (let i = 0; i < samples.length; i++) samples[i] = (row[i * 2] << 8) | row[i * 2 + 1]
    return samples
  }
  const perByte = 8 / bitDepth
  const mask = (1 << bitDepth) - 1
  for (let i = 0; i < samples.length; i++) {
    const shift = 8 - bitDepth - (i % perByte) * bitDepth
    samples[i] = (row[Math.floor(i / perByte)] >> shift) & mask
  }
  return samples
}

function gray8(value, bitDepth) {
  if (bitDepth === 16) return value >> 8
  if (bitDepth === 8) return value
  return (value * 255) / ((1 << bitDepth) - 1)
}

/** Walk the chunk stream; rejects a foreign or truncated file. Chunk CRCs are ignored on read. */
export function parsePng(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file (bad signature)')
  const chunks = []
  let pos = 8
  while (pos + 12 <= data.length) {
    const length = data.readUInt32BE(pos)
    const type = data.toString('latin1', pos + 4, pos + 8)
    if (pos + 12 + length > data.length) throw new Error(`truncated PNG ${type} chunk at byte ${pos}`)
    chunks.push({ type, data: data.subarray(pos + 8, pos + 8 + length) })
    pos += 12 + length
    if (type === 'IEND') break
  }
  const ihdr = chunks.find((entry) => entry.type === 'IHDR')
  if (!ihdr || ihdr.data.length < 13) throw new Error('PNG is missing its IHDR chunk')
  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const interlace = ihdr.data[12]
  if (interlace !== 0) throw new Error('interlaced (Adam7) PNG is not supported')
  return { width, height, bitDepth, colorType, interlace, chunks, textChunks: chunks.filter((entry) => TEXT_TYPES.has(entry.type)) }
}

export function decodePng(buffer) {
  const png = parsePng(buffer)
  const { width, height, bitDepth, colorType } = png
  const samplesPerPixel = SAMPLES[colorType]
  if (!samplesPerPixel) throw new Error(`unsupported PNG colour type ${colorType}`)
  if (!DEPTHS[colorType].includes(bitDepth)) throw new Error(`unsupported PNG bit depth ${bitDepth} for colour type ${colorType}`)
  if (width === 0 || height === 0) throw new Error(`PNG has an empty image (${width}x${height})`)

  const idat = png.chunks.filter((entry) => entry.type === 'IDAT').map((entry) => entry.data)
  if (idat.length === 0) throw new Error('PNG is missing its IDAT chunk')
  const raw = inflateSync(Buffer.concat(idat))
  const bytesPerRow = Math.ceil((width * samplesPerPixel * bitDepth) / 8)
  const stride = bytesPerRow + 1
  if (raw.length < stride * height) throw new Error(`PNG IDAT is truncated (${raw.length} of ${stride * height} bytes)`)
  unfilter(raw, height, bytesPerRow, Math.max(1, Math.ceil((samplesPerPixel * bitDepth) / 8)))

  const palette = png.chunks.find((entry) => entry.type === 'PLTE')?.data
  const trns = png.chunks.find((entry) => entry.type === 'tRNS')?.data
  if (colorType === 3 && !palette) throw new Error('palette PNG is missing its PLTE chunk')
  const alpha = colorType === 4 || colorType === 6 || trns !== undefined
  const channels = alpha ? 4 : 3
  const out = new Uint8Array(width * height * channels)
  // tRNS colour-key sample for gray (0) and RGB (2), two bytes per sample whatever
  // the bit depth; palette tRNS is a per-index alpha table instead.
  const grayKey = colorType === 0 && trns ? (trns[0] << 8) | trns[1] : -1
  const rgbKey = colorType === 2 && trns ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : undefined

  let o = 0
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride + 1, y * stride + 1 + bytesPerRow)
    const s = expandRow(row, width, bitDepth, samplesPerPixel)
    if (colorType === 0) {
      for (let x = 0; x < width; x++) {
        const value = s[x]
        const v = gray8(value, bitDepth)
        out[o++] = v
        out[o++] = v
        out[o++] = v
        if (channels === 4) out[o++] = value === grayKey ? 0 : 255
      }
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const i = x * 3
        const r = bitDepth === 16 ? s[i] >> 8 : s[i]
        const g = bitDepth === 16 ? s[i + 1] >> 8 : s[i + 1]
        const b = bitDepth === 16 ? s[i + 2] >> 8 : s[i + 2]
        out[o++] = r
        out[o++] = g
        out[o++] = b
        if (channels === 4) out[o++] = rgbKey && s[i] === rgbKey[0] && s[i + 1] === rgbKey[1] && s[i + 2] === rgbKey[2] ? 0 : 255
      }
    } else if (colorType === 3) {
      for (let x = 0; x < width; x++) {
        const index = s[x]
        const p = index * 3
        if (p + 3 > palette.length) throw new Error(`palette index ${index} is out of range`)
        out[o++] = palette[p]
        out[o++] = palette[p + 1]
        out[o++] = palette[p + 2]
        if (channels === 4) out[o++] = index < (trns?.length ?? 0) ? trns[index] : 255
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const v = gray8(s[x * 2], bitDepth)
        out[o++] = v
        out[o++] = v
        out[o++] = v
        out[o++] = bitDepth === 16 ? s[x * 2 + 1] >> 8 : s[x * 2 + 1]
      }
    } else {
      for (let x = 0; x < width; x++) {
        const i = x * 4
        if (bitDepth === 16) {
          out[o++] = s[i] >> 8
          out[o++] = s[i + 1] >> 8
          out[o++] = s[i + 2] >> 8
          out[o++] = s[i + 3] >> 8
        } else {
          out[o++] = s[i]
          out[o++] = s[i + 1]
          out[o++] = s[i + 2]
          out[o++] = s[i + 3]
        }
      }
    }
  }
  return { width, height, channels, data: out }
}

export function encodePng({ width, height, channels, data }, { textChunks = [] } = {}) {
  if (channels !== 3 && channels !== 4) throw new Error(`encodePng writes 3 (RGB) or 4 (RGBA) channels, got ${channels}`)
  const stride = width * channels
  if (data.length < stride * height) throw new Error(`pixel buffer is short (${data.length} of ${stride * height} bytes)`)
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr)]
  for (const entry of textChunks) parts.push(chunk(entry.type, entry.data))
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/** Split a text chunk payload into its keyword and value, inflating zTXt/iTXt. */
function textChunkValue({ type, data }) {
  const nul = data.indexOf(0)
  if (nul < 0) return { key: '', value: data.toString('utf8') }
  const key = data.toString('latin1', 0, nul)
  if (type === 'tEXt') return { key, value: data.toString('utf8', nul + 1) }
  if (type === 'zTXt') {
    if (data[nul + 1] !== 0) return undefined
    try {
      return { key, value: inflateSync(data.subarray(nul + 2)).toString('utf8') }
    } catch {
      return undefined
    }
  }
  const compressed = data[nul + 1] === 1
  let cursor = data.indexOf(0, nul + 3)
  if (cursor < 0) return undefined
  cursor = data.indexOf(0, cursor + 1)
  if (cursor < 0) return { key, value: '' }
  const text = data.subarray(cursor + 1)
  try {
    return { key, value: compressed ? inflateSync(text).toString('utf8') : text.toString('utf8') }
  } catch {
    return undefined
  }
}

/**
 * The metadata dict `comfyui_extract_image_info` reports: ComfyUI writes
 * `prompt`/`workflow` tEXt pairs, WebUI/NovelAI a single `parameters` chunk.
 * `prompt`/`workflow` stay whole so the caller can parse them; the rest are
 * trimmed to 2000 characters, as upstream does.
 */
export function readTextMetadata(buffer) {
  const metadata = {}
  for (const entry of parsePng(buffer).textChunks) {
    const decoded = textChunkValue(entry)
    if (!decoded || !METADATA_KEYS.has(decoded.key)) continue
    metadata[decoded.key] = decoded.key === 'prompt' || decoded.key === 'workflow' ? decoded.value : decoded.value.slice(0, 2000)
  }
  return metadata
}
