import type { NodeClient } from '../clients/nodeClient.js'
import type { DocIndex } from '../docs/loader.js'
import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'

export type ServerContext = {
  nodeClient: NodeClient
  evmRegistry: EvmProviderRegistry
  docsIndex: DocIndex
}
