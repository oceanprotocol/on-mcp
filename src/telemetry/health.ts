/**
 * Reliability gauges sampled from the running process.
 *
 * Only libp2p connectivity lives here. **Heap headroom deliberately has no custom instrument**:
 * `@opentelemetry/host-metrics` already exports V8 heap used and the heap size limit (which
 * reflects `--max-old-space-size=28784`), so the used/limit ratio belongs in a Grafana recording
 * rule, not a bespoke gauge that would duplicate it.
 */
import { ProviderInstance } from '@oceanprotocol/lib'

import { connectedPeers } from './metrics.js'
import { telemetryLog } from './log.js'

/**
 * Live libp2p **connections**, not `peerStore.all()`.
 *
 * The distinction matters: `peerStore` is everything ever *discovered* and only grows, so it would
 * read as healthy connectivity long after the node went dark. DDO resolution depends on actual
 * open connections.
 */
function countConnections(): number | undefined {
  try {
    const node: any = (ProviderInstance as any).getLibp2pNode?.()
    if (!node) return undefined
    if (typeof node.getConnections === 'function') return node.getConnections().length
    if (typeof node.getPeers === 'function') return node.getPeers().length
    return undefined
  } catch {
    return undefined
  }
}

let registered = false

export function registerHealthGauges(): void {
  if (registered) return
  registered = true

  connectedPeers.addCallback((result) => {
    const count = countConnections()
    // Observing nothing leaves a gap in the series, which is the honest representation of "the
    // libp2p node is not reachable" — a zero would be indistinguishable from a real disconnect.
    if (typeof count === 'number') result.observe(count)
  })

  telemetryLog('health gauges registered (mcp.p2p.connected_peers)')
}
