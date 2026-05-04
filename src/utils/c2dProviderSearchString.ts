/** Markdown for MCP resource `ocean://docs/c2d-find-provider-search`. */
export const C2D_FIND_PROVIDER_RESOURCE_MARKDOWN = `## C2D provider discovery (\`find_provider\`)

Ocean nodes advertise compute capacity with strings shaped like \`JSON.stringify({ c2d: { ... } })\` (see ocean-node \`p2pAnnounceC2D\`). The DHT hashes the **exact** UTF-8 string (SHA-256 → CID); \`find_provider\` only finds peers that advertised **identical** text.

### Use \`buildFindProviderC2dContent\`
Prefer the MCP tool **buildFindProviderC2dContent** to avoid JSON/key-order mistakes.

### Inner object (\`c2d\`)
- **free**: \`true\` (free tier) or \`false\` (paid).
- Exactly one resource dimension per search:
  - **cpu** / **gpu**: integer **core count**
  - **ram** / **disk**: integer **gigabytes** (use \`ramGb\` / \`diskGb\` in the builder; output keys are \`ram\` / \`disk\`)
- **GPU only** (matches second variant nodes emit):
  - Paid (\`free: false\`): optional **description** (node uses \`resource.description\`)
  - Free (\`free: true\`): optional **kind** (node uses resource \`kind\`)

### Examples (exact \`content\` strings)
- Paid 4 CPUs: \`{"c2d":{"free":false,"cpu":4}}\`
- Free 8 GB RAM: \`{"c2d":{"free":true,"ram":8}}\`
- Paid GPU 1 core + description: \`{"c2d":{"free":false,"gpu":1,"description":"…"}}\`

### Compound requirements (AND across dimensions)

Each \`find_provider\` call matches **one** exact \`{ c2d: ... }\` advertisement. There is **no** single string meaning “2 CPUs **and** 8 GB RAM”. You simulate AND by **multiple queries** and **set logic on peer ids**.

**Example — paid tier, 2 CPUs and 8 GB RAM**

1. Use the **same** \`free\` value for every dimension (here \`false\` for paid).
2. Build two contents:
   - \`buildFindProviderC2dContent({ free: false, cpu: 2 })\` → \`contentCpu\`
   - \`buildFindProviderC2dContent({ free: false, ramGb: 8 })\` → \`contentRam\`
3. Run **find_provider** with \`contentCpu\` and again with \`contentRam\`.
4. **Intersect** the two result arrays by provider **\`id\`** (libp2p PeerId string). Only peers present in **both** lists advertised **both** capability strings.
5. Optionally merge **\`multiaddrs\`** for each surviving \`id\` (same peer may return different address lists per query; dedupe addresses if needed).

**OR (any of several capabilities):** union results by \`id\`, then dedupe (keep one row per peer).

**“At least N CPUs” on one dimension only:** each \`cpu: k\` is a different CID. Take the **union** of \`find_provider\` results for \`k = N, N+1, …\` up to the max you care about, then dedupe by \`id\` — **do not** intersect those CPU-only queries (that would require a peer to have advertised every count at once, which does not happen).

After narrowing by \`id\`, use **getComputeEnvironments** / **node_status** on that peer’s multiaddrs for full structured limits.

### Limits
- One DHT key = one exact string; combine dimensions only by **filter + merge** on \`id\`, not by inventing a multi-field \`c2d\` object unless nodes actually advertise that exact JSON.
- Asset DIDs use different advertised strings (plain DID), not the \`c2d\` wrapper.
`

/**
 * Build the exact UTF-8 string ocean-nodes advertise for C2D capacity discovery
 * (see ocean-node `p2pAnnounceC2D` + `advertiseString(JSON.stringify({ c2d: obj }))`).
 * `find_provider` / DHT lookup requires a byte-identical string (same CID).
 */

export type BuildC2dProviderSearchInput = {
  free: boolean
  cpu?: number
  gpu?: number
  ramGb?: number
  diskGb?: number
  /** Paid-tier GPU only: second advertised variant includes `description`. */
  description?: string
  /** Free-tier GPU only: second advertised variant includes `kind`. */
  kind?: string
}

export type BuildC2dProviderSearchResult = {
  content: string
  inner: Record<string, unknown>
}

function assertIntPositive(name: string, v: number | undefined): void {
  if (v === undefined) return
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/**
 * @throws Error if arguments are inconsistent with ocean-node announcement rules
 */
export function buildC2dProviderSearchContent(
  input: BuildC2dProviderSearchInput
): BuildC2dProviderSearchResult {
  const { free, cpu, gpu, ramGb, diskGb, description, kind } = input

  const dims = [
    cpu !== undefined,
    gpu !== undefined,
    ramGb !== undefined,
    diskGb !== undefined
  ].filter(Boolean)
  if (dims.length !== 1) {
    throw new Error('Specify exactly one of: cpu, gpu, ramGb, diskGb')
  }

  assertIntPositive('cpu', cpu)
  assertIntPositive('gpu', gpu)
  assertIntPositive('ramGb', ramGb)
  assertIntPositive('diskGb', diskGb)

  if (description !== undefined && description.length === 0) {
    throw new Error('description, if set, must be non-empty')
  }
  if (kind !== undefined && kind.length === 0) {
    throw new Error('kind, if set, must be non-empty')
  }

  if (description !== undefined && gpu === undefined) {
    throw new Error('description is only valid with gpu')
  }
  if (kind !== undefined && gpu === undefined) {
    throw new Error('kind is only valid with gpu')
  }
  if (description !== undefined && free) {
    throw new Error('description is used for paid GPU tiers only (free: false)')
  }
  if (kind !== undefined && !free) {
    throw new Error('kind is used for free GPU tiers only (free: true)')
  }

  const inner: Record<string, unknown> = { free }
  if (cpu !== undefined) inner.cpu = cpu
  if (gpu !== undefined) inner.gpu = gpu
  if (ramGb !== undefined) inner.ram = ramGb
  if (diskGb !== undefined) inner.disk = diskGb
  if (description !== undefined) inner.description = description
  if (kind !== undefined) inner.kind = kind

  const content = JSON.stringify({ c2d: inner })
  return { content, inner }
}
