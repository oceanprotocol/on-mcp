import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'

import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { textContent, toPrettyJson } from '../utils/format.js'
import { C2D_FIND_PROVIDER_RESOURCE_MARKDOWN } from '../utils/c2dProviderSearchString.js'
import { toJsonFriendly } from './evmToolUtils.js'

type Params = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
}

const C2D_FIND_PROVIDER_URI = 'ocean://docs/c2d-find-provider-search'
const EVM_SUPPORTED_CHAINS_URI = 'ocean://evm/supported-chains'

function commandResultPayload(command: string, result: unknown) {
  return textContent(
    toPrettyJson({
      command,
      result: toJsonFriendly(result)
    })
  )
}

export function registerResourceTools({ server, evmRegistry }: Params): void {
  server.registerTool(
    'list_resources',
    {
      title: 'List MCP resources (on-mcp)',
      description:
        'Lists all MCP resources exposed by on-mcp (useful for clients that only surface tools).'
    },
    async () => {
      return commandResultPayload('list_resources', {
        resources: [
          {
            name: 'c2d-find-provider-search',
            uri: C2D_FIND_PROVIDER_URI,
            title: 'C2D find_provider search strings',
            mimeType: 'text/markdown'
          },
          {
            name: 'evm-supported-chains',
            uri: EVM_SUPPORTED_CHAINS_URI,
            title: 'EVM supported chains',
            mimeType: 'application/json'
          }
        ]
      })
    }
  )

  server.registerTool(
    'get_resource',
    {
      title: 'Get MCP resource content (on-mcp)',
      description:
        'Returns the content for a given resource URI. This mirrors MCP resources for clients that only surface tools.',
      inputSchema: {
        uri: z
          .enum([C2D_FIND_PROVIDER_URI, EVM_SUPPORTED_CHAINS_URI])
          .describe('Resource URI to fetch.')
      }
    },
    async ({ uri }) => {
      if (uri === C2D_FIND_PROVIDER_URI) {
        return commandResultPayload('get_resource', {
          uri,
          mimeType: 'text/markdown',
          text: C2D_FIND_PROVIDER_RESOURCE_MARKDOWN
        })
      }

      const chains = await Promise.all(
        evmRegistry.getConfiguredChainIds().map(async (chainId) => {
          const provider = evmRegistry.getProvider(chainId)
          if (!provider) {
            return { chainId, ready: false, error: 'Provider not found' }
          }

          try {
            const latestBlock = await provider.getBlock('latest')
            if (!latestBlock) {
              return { chainId, ready: false, error: 'No latest block returned' }
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

      return commandResultPayload('get_resource', {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            chains
          },
          null,
          2
        )
      })
    }
  )
}

