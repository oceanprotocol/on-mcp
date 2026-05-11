import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getEvmProviderRegistry } from '../evm/evmProviderRegistry.js'
import { NodeClient } from '../clients/nodeClient.js'
import { registerResources } from '../resources/registerResources.js'
import { registerTools } from '../tools/registerTools.js'

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ocean-mcp',
    version: '0.1.0'
  })

  const nodeClient = new NodeClient()
  const evmRegistry = getEvmProviderRegistry()

  registerTools({ server, nodeClient, evmRegistry })
  registerResources({ server, nodeClient, evmRegistry })

  return server
}
