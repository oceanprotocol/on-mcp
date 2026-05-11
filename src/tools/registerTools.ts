import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServerContext } from '../server/serverContext.js'
import { registerAssetTools } from './assets.js'
import { registerDocsTools } from './registerDocsTools.js'
import { registerEvmContractTools } from './evmContractTools.js'
import { registerP2pProviderTools } from './p2pProviderTools.js'
import { registerResourceTools } from './resourcesTools.js'

type RegisterToolsParams = {
  server: McpServer
} & ServerContext

export function registerTools({
  server,
  nodeClient,
  evmRegistry,
  docsIndex
}: RegisterToolsParams): void {
  registerP2pProviderTools({ server, nodeClient })
  registerEvmContractTools({ server, evmRegistry })
  registerAssetTools({ server, evmRegistry })
  registerResourceTools({ server, evmRegistry, docsIndex })
  registerDocsTools({ server, docsIndex })

  /*
  server.registerTool(
    'node_list_supported_commands',
    {
      title: 'List supported ocean-node commands',
      description: 'Returns all protocol command names and their grouped categories.'
    },
    async () =>
      textContent(
        toPrettyJson({
          commands: PROTOCOL_COMMANDS,
          groups: COMMAND_GROUPS
        })
      )
  )

  server.registerTool(
    'ocean_direct_command',
    {
      title: 'Run ocean-node direct command',
      description: 'Runs a low-level protocol command against ocean-node /directCommand.',
      inputSchema: {
        command: protocolCommandSchema,
        payload: z.record(z.string(), z.unknown()).optional(),
        node: z.string().optional(),
        multiAddrs: z.union([z.string(), z.array(z.string())]).optional()
      }
    },
    async ({ command, payload, node, multiAddrs }) => {
      try {
        const result = await nodeClient.directCommand(
          command as ProtocolCommand,
          payload ?? {},
          { node, multiAddrs }
        )
        return commandResultPayload(command, result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  

  server.registerTool(
    'node_detailed_status',
    {
      title: 'Get detailed node status',
      description:
        'Gets detailed ocean-node status via the "detailedStatus" protocol command.'
    },
    async () => {
      try {
        const result = await nodeClient.directCommand('detailedStatus')
        return commandResultPayload('detailedStatus', result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'node_get_ddo',
    {
      title: 'Get DDO using node command',
      description: 'Fetches a DDO using ocean-node "getDDO".',
      inputSchema: {
        id: z.string().describe('Asset DID')
      }
    },
    async ({ id }) => {
      try {
        const result = await nodeClient.directCommand('getDDO', { id })
        return commandResultPayload('getDDO', result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'node_query_assets',
    {
      title: 'Query assets using node command',
      description: 'Runs ocean-node "query" command with a query payload.',
      inputSchema: {
        query: z.record(z.string(), z.unknown())
      }
    },
    async ({ query }) => {
      try {
        const result = await nodeClient.directCommand('query', { query })
        return commandResultPayload('query', result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'node_get_p2p_peers',
    {
      title: 'Get P2P peers',
      description: 'Returns peers connected to the node using "getP2PPeers".'
    },
    async () => {
      try {
        const result = await nodeClient.directCommand('getP2PPeers')
        return commandResultPayload('getP2PPeers', result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'node_get_compute_status',
    {
      title: 'Get compute status',
      description: 'Gets compute status using ocean-node "getComputeStatus".',
      inputSchema: {
        payload: z
          .record(z.string(), z.unknown())
          .describe('Command-specific payload, e.g. consumerAddress and jobId.')
      }
    },
    async ({ payload }) => {
      try {
        const result = await nodeClient.directCommand('getComputeStatus', payload)
        return commandResultPayload('getComputeStatus', result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'node_start_compute',
    {
      title: 'Start compute job',
      description: 'Starts a compute job via ocean-node "startCompute".',
      inputSchema: {
        payload: z
          .record(z.string(), z.unknown())
          .describe('Command-specific payload for startCompute.')
      }
    },
    async ({ payload }) => {
      try {
        const result = await nodeClient.directCommand('startCompute', payload)
        return commandResultPayload('startCompute', result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'node_create_auth_token',
    {
      title: 'Create auth token',
      description: 'Creates node auth token via "createAuthToken".',
      inputSchema: {
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional command payload.')
      }
    },
    async ({ payload }) => {
      try {
        const result = await nodeClient.directCommand('createAuthToken', payload ?? {})
        return commandResultPayload('createAuthToken', result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'node_collect_fees',
    {
      title: 'Collect node fees',
      description: 'Runs "collectFees" admin command.',
      inputSchema: {
        payload: z
          .record(z.string(), z.unknown())
          .describe('Command-specific payload for collectFees.')
      }
    },
    async ({ payload }) => {
      try {
        const result = await nodeClient.directCommand('collectFees', payload)
        return commandResultPayload('collectFees', result)
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'ocean_resolve_ddo',
    {
      title: 'Resolve DDO via ocean.js',
      description: 'Resolves an asset DID using @oceanprotocol/lib Aquarius client.',
      inputSchema: {
        did: z.string().describe('Asset DID')
      }
    },
    async ({ did }) => {
      try {
        const result = await oceanLibClient.resolveDdo(did)
        return textContent(toPrettyJson(result))
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'ocean_query_assets',
    {
      title: 'Query assets via ocean.js',
      description: 'Searches assets using @oceanprotocol/lib Aquarius querySearch API.',
      inputSchema: {
        query: z
          .record(z.string(), z.unknown())
          .describe('Aquarius query object with at least a "query" field.')
      }
    },
    async ({ query }) => {
      try {
        const result = await oceanLibClient.queryAssets(query as any)
        return textContent(toPrettyJson(result))
      } catch (error) {
        return {
          ...textContent(stringifyError(error)),
          isError: true
        }
      }
    }
  )
    */
}
