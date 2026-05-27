import { z } from 'zod/v4'
import { multiaddr } from '@multiformats/multiaddr'
import type { Multiaddr } from '@multiformats/multiaddr'
import {
  PROTOCOL_COMMANDS,
  type CompleteSignature,
  type SignerOrAuthTokenOrSignature
} from '@oceanprotocol/lib'

export type NodeP2PInput = {
  nodeId: string | null
  multiaddress?: Multiaddr[]
}

/** Shared doc block for tools that accept ocean.js SignerOrAuthTokenOrSignature via MCP. */
export const P2P_AUTH_SIGNING_GUIDE = `## Authentication
Provide **exactly one** of:
- **authToken**: JWT string from the node (createAuthToken / generateAuthToken in ocean.js). Sent as the request authorization header; the node derives your consumer address from the token.
- **completeSignature**: Use when the wallet signs outside this MCP server. Object fields:
  - **consumerAddress**: Checksummed or lower-case 0x-prefixed address of the signer.
  - **nonce**: String decimal integer equal to **(nonce returned by getNonce) + 1**. ocean.js \`getSignedCommandParams\` fetches the current nonce from the node, adds 1, and uses that string when signing.
  - **signature**: Hex signature string from your wallet.

### Plaintext string to sign (before hashing)
Build **one string with no separators** (same as BaseProvider \`getSignature\` in ocean.js):
\`message = String(consumerAddress) + String(nonce) + String(protocolCommand)\`

\`protocolCommand\` must be the exact command string for this call (see PROTOCOL_COMMANDS in @oceanprotocol/lib), e.g. \`${PROTOCOL_COMMANDS.COMPUTE_START}\` for paid compute start.

### Nonce workflow
1. Call **getNonce** with the same target node and your **consumerAddress**.
2. Let \`n\` be the returned integer. Set **nonce** in completeSignature to **String(n + 1)** (not \`n\`).

### How ocean.js hashes and signs (SignatureUtils.signRequest)
1. \`consumerMessage = solidityPackedKeccak256(['bytes'], [hexlify(toUtf8Bytes(message))])\` — i.e. Keccak-256 over the UTF-8 bytes of \`message\`.
2. \`messageHashBytes = toBeArray(consumerMessage)\` (32 bytes).
3. \`signer.signMessage(messageHashBytes)\` — EIP-191 personal signature over that 32-byte payload.

If you reimplement signing without ocean.js, your wallet must produce the same EIP-191 signature as ethers v6 \`signMessage\` on those 32 bytes.

### Protocol command strings for this API
| Operation | protocolCommand |
|-----------|-----------------|
| validateDdo | \`${PROTOCOL_COMMANDS.VALIDATE_DDO}\` |
| computeStart | \`${PROTOCOL_COMMANDS.COMPUTE_START}\` |
| freeComputeStart | \`${PROTOCOL_COMMANDS.FREE_COMPUTE_START}\` |
| computeStop | \`${PROTOCOL_COMMANDS.COMPUTE_STOP}\` |
| getComputeResult | \`${PROTOCOL_COMMANDS.COMPUTE_GET_RESULT}\` |
| downloadNodeLogs | \`${PROTOCOL_COMMANDS.GET_LOGS}\` |
| createPersistentStorageBucket | \`${PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET}\` |
| getPersistentStorageBuckets | \`${PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_BUCKETS}\` |
| listPersistentStorageFiles | \`${PROTOCOL_COMMANDS.PERSISTENT_STORAGE_LIST_FILES}\` |
| getPersistentStorageFileObject | \`${PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_FILE_OBJECT}\` |
| deletePersistentStorageFile | \`${PROTOCOL_COMMANDS.PERSISTENT_STORAGE_DELETE_FILE}\` |
| uploadPersistentStorageFile | \`${PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE}\` |
| encrypt (p2p_encrypt) | \`${PROTOCOL_COMMANDS.ENCRYPT}\` |
| download_asset_file | \`${PROTOCOL_COMMANDS.DOWNLOAD}\` |
| create_auth_token | \`${PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN}\` |

**computeStatus** still requires authToken or completeSignature (ocean.js passes consumerAddress and authorization); there is no separate extra signature field in the body beyond what the library adds.`

export const P2P_ADMIN_CONFIG_WARNING = `**Operator-only:** Misuse can break or leak node configuration. Payload must match ocean-node signing expectations for \`fetchConfig\` / \`pushConfig\`.`

/** Returned alongside an ephemeral consumer key so the user understands its throwaway nature. */
export const EPHEMERAL_CONSUMER_KEY_DISCLAIMER =
  'This is a throwaway consumer key generated for this job. The server does not persist it — keep the returned privateKey if you want to reuse it. It starts with no funds; fund its address if you need it for paid jobs. Ocean Network is not responsible for any leaked, drained, or lost keys.'

/** Shared payment/duration semantics for initializeCompute + computeStart. Field names verified against ocean-node @types/Fees.ts and C2D.ts. */
export const P2P_COMPUTE_PAYMENT_GUIDE = `## Duration vs escrow lock — NOT the same thing
- **maxJobDuration** (computeStart) / **validUntil** (initializeCompute): seconds the algorithm **container** may run. The node clamps it into the env's [\`minJobDuration\`, \`maxJobDuration\`] and bills at least \`minJobDuration\`. For a quick test use **env.minJobDuration** (often 60).
- **payment.minLockSeconds** (initializeCompute response): how long the **escrow lock** must stay valid = \`maxJobDuration + queueMaxWaitTime + the node's claimDurationTimeout\` (a config buffer, default **3600s**). It is the run time plus a buffer, so it is usually larger than the job duration — and much larger on nodes configured with a big claimDurationTimeout. Your escrow authorization's \`maxLockSeconds\` must be **≥** this; do not shrink job duration to match it.

## Cost — do not compute it yourself
Cost ≈ Σ over resources of (per-minute price × allocated amount) × \`ceil(maxJobDuration / 60)\`. The node enforces **resource minimums** (\`resources[].min\` for cpu/ram/disk), so requesting \`cpu: 1\` may bill for the env minimum (e.g. \`cpu: 8\`). Trust **payment.amount** from initializeCompute (**raw** token units, not human-readable) — never your own math.

## Typical paid flow
1. **getComputeEnvironments** → pick env; note \`minJobDuration\` and each \`resources[].min\`.
2. **initializeCompute** with \`validUntil = env.minJobDuration\` → read \`payment.amount\`, \`payment.minLockSeconds\`, \`payment.token\`, \`payment.payee\`.
3. Verify escrow before starting: \`escrow_get_authorizations(payer, payee, token)\` returns an **array** of auth tuples (usually one), each in ABI order \`[payee, maxLockedAmount, currentLockedAmount, maxLockSeconds, maxLockCounts, currentLocks]\` — so read \`result[0][1]\` for maxLockedAmount, etc. Require \`maxLockedAmount ≥ payment.amount\` and \`maxLockSeconds ≥ payment.minLockSeconds\`; and \`escrow_get_user_funds ≥ payment.amount\`. Deposit/authorize (dashboard or escrow tools) if short.
4. **computeStart** with \`maxJobDuration = env.minJobDuration\`.`

/** Instructs MCP clients to confirm the node exposes persistent storage via status before calling PS tools. Mirrors ocean-node statusHandler (persistentStorage only when config.persistentStorage is set). */
export const P2P_PERSISTENT_STORAGE_PREREQUISITE = `## Node capability check (required first)
Before **createPersistentStorageBucket**, **getPersistentStorageBuckets**, **listPersistentStorageFiles**, **getPersistentStorageFileObject**, or **deletePersistentStorageFile**, call **node_status** on the **same** target (\`nodeId\` / \`multiaddress\`).

Ocean-node only adds **\`persistentStorage\`** to the status JSON when **\`config.persistentStorage\`** is enabled: the handler sets \`nodeStatus.persistentStorage\` to an object and may attach **\`accessLists\`** from config. If **\`persistentStorage\`** is **missing** from the status response, persistent storage is **not** available on that node—do not call the tools above for that peer.

**Bucket ownership is scoped to the consumer of the \`authToken\` used.** Reuse the **same** \`authToken\` for create/upload/list/read/delete and for the compute job that consumes the bucket — a different token means a different consumer and access errors. Inside a C2D container, \`nodePersistentStorage\` inputs mount at \`/data/persistentStorage/<bucketId>/<fileName>\` (not \`/data/inputs/\`).`

export const nodeTargetSchema = {
  nodeId: z
    .string()
    .optional()
    .describe(
      'Libp2p PeerId string for the target ocean-node. Best to use with multiaddress if you have them already.'
    ),
  multiaddress: z
    .array(z.string())
    .optional()
    .describe(
      'Dial addresses for the node, e.g. ["/ip4/127.0.0.1/tcp/9001"]. Parsed with @multiformats/multiaddr.'
    ),
  timeout: z
    .number()
    .optional()
    .describe(
      'Max wait in **seconds** for the P2P round-trip (converted to AbortSignal.timeout). Default: 10.'
    )
}

/** find_provider / DHT search — same timeout semantics as node target tools. */
export const findProviderInputSchema = {
  content: z
    .string()
    .describe(
      'Exact UTF-8 key for DHT lookup (SHA-256 → CID). For C2D use buildFindProviderC2dContent. Multi-dimensional needs (e.g. CPU and RAM): one find_provider per dimension, then intersect peers by result item **id**. See ocean://docs/c2d-find-provider-search.'
    ),
  timeout: nodeTargetSchema.timeout
}

export const completeSignatureSchema = z.object({
  consumerAddress: z
    .string()
    .describe(
      'Ethereum address of the consumer; must match the key used to produce signature.'
    ),
  nonce: z
    .string()
    .describe(
      'Decimal nonce string: **String((getNonce result) + 1)**. Must match the nonce used inside the signed message.'
    ),
  signature: z
    .string()
    .describe(
      '0x-hex EIP-191 signature from signMessage(keccak256(utf8(message))) workflow described in the tool description.'
    )
})

/** Optional fields; callers must pass exactly one to resolveAuth() for secured tools. */
export const p2pAuthFieldSchemas = {
  authToken: z
    .string()
    .optional()
    .describe('JWT from user or dashboard; use alone or with completeSignature omitted.'),
  completeSignature: completeSignatureSchema
    .optional()
    .describe('Pre-built signature object; omit authToken when using this.')
}

export function parseNodeTarget(
  nodeId: string | undefined,
  multiaddress: string[] | undefined
): NodeP2PInput {
  const multiaddressList = multiaddress?.map((addr) => multiaddr(addr))
  return {
    nodeId: nodeId ?? null,
    ...(multiaddressList?.length ? { multiaddress: multiaddressList } : {})
  }
}

export function timeoutMs(timeoutSeconds: number | undefined): number {
  return (timeoutSeconds ?? 10) * 1000
}

export function resolveAuth(
  authToken: string | undefined,
  completeSignature: CompleteSignature | undefined
): SignerOrAuthTokenOrSignature {
  const hasToken = authToken !== undefined && authToken.length > 0
  const hasSig = completeSignature !== undefined
  if (hasToken && hasSig) {
    throw new Error('Provide either authToken or completeSignature, not both')
  }
  if (!hasToken && !hasSig) {
    throw new Error('Provide exactly one of authToken or completeSignature')
  }
  if (hasToken) return authToken
  return completeSignature as CompleteSignature
}
