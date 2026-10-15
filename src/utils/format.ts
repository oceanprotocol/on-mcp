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
 * paged instead of flooding the model's context. The page end is pulled back to a UTF-8 character
 * boundary so a multibyte character is never split across pages — paging from offset 0 and
 * concatenating the decoded pages therefore reconstructs the original text exactly, with no
 * replacement characters at the seams. `maxBytes === undefined` returns everything from `offset`.
 *
 * (Callers are expected to resume at `nextOffset`, which is always a character boundary. A hand-
 * picked `offset` landing mid-character is not realigned and would decode that leading partial
 * character to U+FFFD.)
 */
export function sliceUtf8(text: string, offset = 0, maxBytes?: number): SlicedText {
  const buf = Buffer.from(text, 'utf8')
  const totalBytes = buf.byteLength
  const start = Math.max(0, Math.min(offset, totalBytes))
  let end = maxBytes === undefined ? totalBytes : Math.min(start + maxBytes, totalBytes)
  // Don't end a page inside a character. A UTF-8 continuation byte is 0x80–0xBF; if the first
  // EXCLUDED byte is one, the character straddling the boundary would be split. Back `end` off to
  // the character's start so the page holds only whole characters (and `nextOffset` begins the next
  // one cleanly).
  if (end < totalBytes) {
    while (end > start && (buf[end] & 0xc0) === 0x80) end -= 1
    // Budget too small to hold even the first character: include that whole character anyway, so
    // paging still advances (otherwise `nextOffset === offset` would stall a reader).
    if (end === start) {
      end = Math.min(start + 1, totalBytes)
      while (end < totalBytes && (buf[end] & 0xc0) === 0x80) end += 1
    }
  }
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
