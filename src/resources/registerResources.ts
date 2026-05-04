import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NodeClient } from '../clients/nodeClient.js'
import { C2D_FIND_PROVIDER_RESOURCE_MARKDOWN } from '../utils/c2dProviderSearchString.js'

type RegisterResourcesParams = {
  server: McpServer
  nodeClient: NodeClient
}

const C2D_FIND_PROVIDER_URI = 'ocean://docs/c2d-find-provider-search'

export function registerResources({
  server,
  nodeClient: _nodeClient
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
}
