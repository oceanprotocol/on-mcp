import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { NodeClient } from '../clients/nodeClient.js'
import { C2D_FIND_PROVIDER_RESOURCE_MARKDOWN } from '../utils/c2dProviderSearchString.js'

type RegisterResourcesParams = {
  server: McpServer
  nodeClient: NodeClient
  evmRegistry: EvmProviderRegistry
}

const C2D_FIND_PROVIDER_URI = 'ocean://docs/c2d-find-provider-search'
const EVM_SUPPORTED_CHAINS_URI = 'ocean://evm/supported-chains'

export function registerResources({
  server,
  nodeClient: _nodeClient,
  evmRegistry
}: RegisterResourcesParams): void {
  server.registerResource(
    'c2d-find-provider-search',
    C2D_FIND_PROVIDER_URI,
    {
      title: 'C2D find_provider search strings',
      description:
        'How ocean-node advertises compute capacity for DHT discovery and how to use buildFindProviderC2dContent + find_provider.',
      mimeType: 'text/markdown'
    },
    () => ({
      contents: [
        {
          uri: C2D_FIND_PROVIDER_URI,
          mimeType: 'text/markdown',
          text: C2D_FIND_PROVIDER_RESOURCE_MARKDOWN
        }
      ]
    })
  )

  server.registerResource(
    'evm-supported-chains',
    EVM_SUPPORTED_CHAINS_URI,
    {
      title: 'EVM supported chains',
      description:
        'Configured EVM chains with latest observed block number and timestamp from each chain fallback provider.',
      mimeType: 'application/json'
    },
    async () => {
      const chains = await Promise.all(
        evmRegistry.getConfiguredChainIds().map(async (chainId) => {
          const provider = evmRegistry.getProvider(chainId)
          if (!provider) {
            return {
              chainId,
              ready: false,
              error: 'Provider not found'
            }
          }

          try {
            const latestBlock = await provider.getBlock('latest')
            if (!latestBlock) {
              return {
                chainId,
                ready: false,
                error: 'No latest block returned'
              }
            }

            return {
              chainId,
              ready: true,
              blockNumber: latestBlock.number,
              blockTimestamp: latestBlock.timestamp,
              blockTimestampIso: new Date(latestBlock.timestamp * 1000).toISOString()
            }
          } catch (error) {
            return {
              chainId,
              ready: false,
              error: error instanceof Error ? error.message : `${error}`
            }
          }
        })
      )

      return {
        contents: [
          {
            uri: EVM_SUPPORTED_CHAINS_URI,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                generatedAt: new Date().toISOString(),
                chains
              },
              null,
              2
            )
          }
        ]
      }
    }
  )
}
