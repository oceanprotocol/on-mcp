/** Env var: JSON object mapping chain id strings to ordered RPC URL lists (primary first). */
export const EVM_CHAIN_RPCS_ENV = 'EVM_CHAIN_RPCS'

function validateRpcUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid RPC URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`RPC URL must use http or https: ${url}`)
  }
}

/**
 * Parses `EVM_CHAIN_RPCS` JSON: `{ "1": ["https://a", "https://b"], "137": ["..."] }`.
 * Empty or unset input returns an empty map (no providers).
 * Invalid JSON or invalid shape throws (fail fast at startup).
 */
export function parseEvmChainRpcsJson(raw: string | undefined): Map<number, string[]> {
  if (raw === undefined || raw.trim() === '') {
    return new Map()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : `${e}`
    throw new Error(`EVM_CHAIN_RPCS is not valid JSON: ${msg}`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'EVM_CHAIN_RPCS must be a JSON object mapping chain id strings to RPC URL arrays'
    )
  }

  const result = new Map<number, string[]>()

  for (const [key, value] of Object.entries(parsed)) {
    const chainId = Number(key)
    if (!Number.isFinite(chainId) || !Number.isInteger(chainId)) {
      throw new Error(`EVM_CHAIN_RPCS has invalid chain id key: ${JSON.stringify(key)}`)
    }

    if (!Array.isArray(value)) {
      throw new Error(`EVM_CHAIN_RPCS[${key}] must be an array of RPC URL strings`)
    }

    const urls: string[] = []
    for (const item of value) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error(`EVM_CHAIN_RPCS[${key}] contains a non-string or empty URL`)
      }
      const trimmed = item.trim()
      validateRpcUrl(trimmed)
      urls.push(trimmed)
    }

    if (urls.length === 0) {
      console.warn(`EVM_CHAIN_RPCS: skipping chain ${chainId} (empty URL array)`)
      continue
    }

    result.set(chainId, urls)
  }

  return result
}

export function parseEvmChainRpcsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Map<number, string[]> {
  return parseEvmChainRpcsJson(env[EVM_CHAIN_RPCS_ENV])
}
