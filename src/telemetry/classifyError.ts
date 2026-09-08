/**
 * Maps any failure — a thrown error or an `{ isError: true }` tool result — onto a **bounded**
 * enum.
 *
 * The message is read here to classify and then **discarded**. It is never returned, never
 * attached to a span, and never used as a metric attribute: messages carry DIDs, addresses and
 * node URLs, and would explode label cardinality even if they did not.
 */
export type ErrorType =
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'p2p_timeout'
  | 'network'
  | 'onchain_revert'
  | 'internal'

/** Ordered most-specific first: the first matching rule wins. */
const RULES: Array<{ type: ErrorType; test: RegExp }> = [
  // First, deliberately. It has to beat `onchain_revert` (revert strings contain "unauthorized")
  // and `not_found` (an expired token commonly reads as "session not found"). ~44 tools take an
  // auth token, and "users cannot authenticate" needs a different fix from "the network is down" —
  // without this rule those failures vanish into `internal` and are unattributable.
  {
    type: 'auth',
    test: /\bunauthori[sz]ed\b|\bforbidden\b|\b40[13]\b|auth[_ ]?token|authentication|invalid signature|signature (verification )?failed|expired token|token (is )?(expired|invalid)|nonce (mismatch|too low|invalid)|missing (auth|credentials)|permission denied/i
  },
  {
    type: 'onchain_revert',
    test: /\brevert|call_exception|execution reverted|insufficient funds for (gas|intrinsic)/i
  },
  {
    type: 'validation',
    test: /\bzod|invalid[_ ]?(input|argument|params|type)|must be|expected .+ received|schema|is required\b/i
  },
  {
    type: 'not_found',
    test: /\bnot found\b|\bno such\b|\bunknown (asset|did|job|service|session)\b|\b404\b|\bddo (not|could not be) (found|resolved)/i
  },
  {
    type: 'p2p_timeout',
    test: /\btimed? ?out\b|\btimeout\b|\baborted\b|abort ?error|no providers? found|no peers? (found|available)|deadline exceeded/i
  },
  {
    type: 'network',
    test: /econnrefused|enotfound|econnreset|ehostunreach|etimedout|network|socket hang up|fetch failed|bad gateway|\b5\d\d\b|rpc\b/i
  }
]

function messageOf(err: unknown): string {
  if (err === null || err === undefined) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) {
    // ethers packs the useful discriminator into `code`/`shortMessage`, not always `message`.
    const extra = err as Error & { code?: unknown; shortMessage?: unknown }
    return [err.name, err.message, extra.shortMessage, extra.code]
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .join(' ')
  }
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>
    // An `{ isError: true }` tool result: the failure text is in content[0].text.
    const { content } = obj
    if (Array.isArray(content)) {
      const text = (content[0] as { text?: unknown } | undefined)?.text
      if (typeof text === 'string') return text
    }
    return [obj.name, obj.message, obj.error, obj.code]
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .join(' ')
  }
  return ''
}

export function classifyError(err: unknown): ErrorType {
  const message = messageOf(err)
  if (!message) return 'internal'

  // Truncate before regex work: tool error payloads can embed a whole JSON result.
  const haystack = message.slice(0, 2000)
  for (const rule of RULES) {
    if (rule.test.test(haystack)) return rule.type
  }
  return 'internal'
}
