export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/**
 * Compact (no-whitespace) JSON for tool/result envelopes. MCP clients parse these, not humans,
 * so the pretty-print indentation was pure token overhead on every call. Use `toPrettyJson` only
 * where a human reads the raw text (e.g. a doc/chains resource body).
 */
export function toCompactJson(value: unknown): string {
  return JSON.stringify(value)
}

export function textContent(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text
      }
    ]
  }
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

export type SlicedText = {
  text: string
  /** Total size of the full content in UTF-8 bytes. */
  totalBytes: number
  /** Byte offset this slice started at. */
  offset: number
  /** Bytes returned in this slice. */
  returnedBytes: number
  /** True when the slice does not cover the whole content (more remains, or offset > 0). */
  truncated: boolean
  /** Byte offset to pass next to continue reading, when truncated past the end of this slice. */
  nextOffset?: number
}

/**
 * Byte-bounded window over a text payload, so whole-file reads (docs, resources) can be capped and
 * paged instead of flooding the model's context. Slicing on UTF-8 byte boundaries can clip a
 * multibyte character at an edge (it decodes to the replacement char) — acceptable for the plain
 * text/markdown these guards protect. `maxBytes === undefined` returns everything from `offset`.
 */
export function sliceUtf8(text: string, offset = 0, maxBytes?: number): SlicedText {
  const buf = Buffer.from(text, 'utf8')
  const totalBytes = buf.byteLength
  const start = Math.max(0, Math.min(offset, totalBytes))
  const end = maxBytes === undefined ? totalBytes : Math.min(start + maxBytes, totalBytes)
  const returnedBytes = end - start
  const truncated = start > 0 || end < totalBytes
  return {
    text: buf.subarray(start, end).toString('utf8'),
    totalBytes,
    offset: start,
    returnedBytes,
    truncated,
    ...(end < totalBytes ? { nextOffset: end } : {})
  }
}
