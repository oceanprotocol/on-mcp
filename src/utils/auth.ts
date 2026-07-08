import { Wallet, getAddress } from 'ethers'

/**
 * Decode the `address` claim from an ocean-node auth-token JWT **without verifying** the
 * signature. The token is HS256-signed with the node's own secret, so this MCP server cannot
 * verify it — we only base64url-decode the payload to learn the consumer address for read-only
 * escrow checks. The node re-validates the token itself when the job actually starts. Treat the
 * returned address as a hint, never as authenticated identity.
 */
export function decodeAuthTokenAddress(authToken: string): string {
  const parts = authToken.split('.')
  if (parts.length < 2) {
    throw new Error('Invalid auth token: not a JWT (expected header.payload.signature)')
  }
  let payload: Record<string, unknown>
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    payload = JSON.parse(json)
  } catch {
    throw new Error('Invalid auth token: payload is not valid base64url JSON')
  }
  const { address } = payload
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error('Invalid auth token: missing `address` claim')
  }
  return getAddress(address)
}

/**
 * Resolve the consumer (payer) ethereum address from one of the supported identity inputs.
 * Precedence: `privateKey` (the signer) → explicit `consumerAddress` → `authToken` (decoded).
 * Throws when none is supplied.
 */
export function resolveConsumerAddress(opts: {
  authToken?: string
  privateKey?: string
  consumerAddress?: string
}): string {
  const { authToken, privateKey, consumerAddress } = opts
  if (privateKey && privateKey.length > 0) {
    try {
      return new Wallet(privateKey).address
    } catch {
      // Never surface the raw ethers error — it embeds the supplied key value.
      throw new Error(
        'Invalid private key format (must be a 0x-prefixed 32-byte hex string)'
      )
    }
  }
  if (consumerAddress && consumerAddress.length > 0) return getAddress(consumerAddress)
  if (authToken && authToken.length > 0) return decodeAuthTokenAddress(authToken)
  throw new Error('Provide an identity: one of consumerAddress, privateKey, or authToken')
}
