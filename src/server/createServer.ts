import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerPrompts } from '../prompts/registerPrompts.js'
import { registerResources } from '../resources/registerResources.js'
import { registerTools } from '../tools/registerTools.js'
import type { ServerContext } from './serverContext.js'

export function createServer(context: ServerContext): McpServer {
  const server = new McpServer({
    name: 'ocean-mcp',
    version: '0.1.0'
  })

  registerTools({ server, ...context })
  registerResources({ server, ...context })
  registerPrompts(server)

  return server
}
