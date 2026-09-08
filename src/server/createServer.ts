import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerPrompts } from '../prompts/registerPrompts.js'
import { registerResources } from '../resources/registerResources.js'
import { registerTools } from '../tools/registerTools.js'
import type { ServerContext } from './serverContext.js'

/**
 * @param onCreated Runs after construction but **before** any tool is registered. The SSE path
 * passes `wrapMcpServer` here so the telemetry monkeypatch is installed while `registerTool` is
 * still unused; the stdio path passes nothing and therefore emits no telemetry at all.
 */
export function createServer(
  context: ServerContext,
  onCreated?: (server: McpServer) => void
): McpServer {
  const server = new McpServer({
    name: 'ocean-mcp',
    version: '0.1.0'
  })

  onCreated?.(server)

  registerTools({ server, ...context })
  registerResources({ server, ...context })
  registerPrompts(server)

  return server
}
