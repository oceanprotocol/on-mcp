import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'

import type { DocIndex } from '../docs/loader.js'
import type { EvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { textContent, toPrettyJson } from '../utils/format.js'
import { toJsonFriendly } from './evmToolUtils.js'
import { getResourceContent, listAllResources } from '../resources/resourceCatalog.js'

type Params = {
  server: McpServer
  evmRegistry: EvmProviderRegistry
  docsIndex: DocIndex
}

function commandResultPayload(command: string, result: unknown) {
  return textContent(
    toPrettyJson({
      command,
      result: toJsonFriendly(result)
    })
  )
}

export function registerResourceTools({ server, evmRegistry, docsIndex }: Params): void {
  server.registerTool(
    'list_resources',
    {
      title: 'List MCP resources (on-mcp)',
      description:
        'Lists all MCP resources exposed by on-mcp (useful for clients that only surface tools).'
    },
    // eslint-disable-next-line require-await
    () => {
      return commandResultPayload('list_resources', {
        resources: listAllResources({ evmRegistry, docsIndex })
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
        uri: z.string().describe('Resource URI to fetch.')
      }
    },
    async ({ uri }) => {
      const resource = await getResourceContent({ evmRegistry, docsIndex }, uri)
      if (!resource) {
        return {
          ...textContent(`Unknown resource URI: ${uri}`),
          isError: true
        }
      }

      return commandResultPayload('get_resource', {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.text
      })
    }
  )
}
