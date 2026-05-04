import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NodeClient } from '../clients/nodeClient.js'
import { registerResources } from '../resources/registerResources.js'
import { registerTools } from '../tools/registerTools.js'

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ocean-mcp',
    version: '0.1.0'
  })

  const nodeClient = new NodeClient()

  registerTools({ server, nodeClient })
  registerResources({ server, nodeClient })

  return server
}
