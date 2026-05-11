import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'

import type { IncentivesClient } from '../clients/incentivesClient.js'
import { stringifyError, textContent, toPrettyJson } from '../utils/format.js'

type Params = {
  server: McpServer
  incentivesClient: IncentivesClient
}

const jsonObjectSchema = z.record(z.string(), z.unknown())
const sortSchema = z.record(z.string(), z.enum(['asc', 'desc']))

const pageSchema = z.number().int().positive().default(1)
const sizeSchema = z.number().int().positive()
const searchSchema = z.string().optional()
const useScrollSchema = z.boolean().default(false)
const filtersSchema = jsonObjectSchema.optional()
const sortInputSchema = sortSchema.optional()

const INCENTIVES_UNBAN_SIGNING_GUIDE = `## Admin signature
Generate the signature outside MCP with an allowed admin wallet, then pass the signed fields into this tool.

Signing workflow:
1. Choose a future **expiryTimestamp** in milliseconds since epoch.
2. Set **message = String(expiryTimestamp)**.
3. For a normal EOA wallet, compute **keccak256(utf8(message))**, convert that 32-byte hash to bytes, then call **signMessage(messageHashBytes)**.
4. Send the resulting hex signature as **signature**, the same timestamp as **expiryTimestamp**, and the signer wallet as **address**.

Equivalent ethers v6 flow:
\`const message = String(expiryTimestamp)\`
\`const messageHashBytes = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(message)))\`
\`const signature = await signer.signMessage(messageHashBytes)\`

Notes:
- **address** must be one of the node's allowed admin addresses.
- **expiryTimestamp** must still be in the future when the API receives it.
- Smart-contract wallets may validate through ERC-1271 instead of EOA recovery, but should still provide an address-compatible signature for the same timestamp.`

function commandResultPayload(command: string, result: unknown) {
  return textContent(
    toPrettyJson({
      command,
      result
    })
  )
}

function errorPayload(error: unknown) {
  return {
    ...textContent(stringifyError(error)),
    isError: true
  }
}

export function registerIncentivesTools({ server, incentivesClient }: Params): void {
  server.registerTool(
    'incentives_list_nodes',
    {
      title: 'List incentive nodes',
      description:
        'Lists incentive-monitor nodes from the incentives API, including optional node lookup, search, filters, sort, and pagination.',
      inputSchema: {
        nodeId: z
          .string()
          .optional()
          .describe('Optional exact node id query forwarded as `nodeId`.'),
        page: pageSchema.describe('Results page number (default 1).'),
        size: sizeSchema.default(10).describe('Page size (default 10).'),
        search: searchSchema.describe('Optional free-text node search term.'),
        useScroll: useScrollSchema.describe(
          'Whether to request scroll pagination. This is only effective for `/nodes`.'
        ),
        filters: filtersSchema.describe(
          'Filter object forwarded as nested query params, matching the incentives `/nodes` route.'
        ),
        sort: sortInputSchema.describe(
          'Sort map forwarded as JSON, for example `{ "friendlyName": "asc" }`.'
        )
      }
    },
    async ({ nodeId, page, size, search, useScroll, filters, sort }) => {
      try {
        const result = await incentivesClient.listNodes({
          nodeId,
          page,
          size,
          search,
          useScroll,
          filters,
          sort
        })
        return commandResultPayload('incentives_list_nodes', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_run_query',
    {
      title: 'Run incentives Elasticsearch query',
      description:
        'Runs the raw incentives `POST /query` Elasticsearch proxy. Use only when the higher-level incentives tools are not sufficient.',
      inputSchema: {
        query: jsonObjectSchema.describe(
          'Raw Elasticsearch query payload forwarded to the incentives API.'
        )
      }
    },
    async ({ query }) => {
      try {
        const result = await incentivesClient.runQuery(query)
        return commandResultPayload('incentives_run_query', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_get_node_system_stats',
    {
      title: 'Get node system stats',
      description:
        'Returns aggregate CPU, OS, and architecture counts for incentive nodes.'
    },
    async () => {
      try {
        const result = await incentivesClient.getNodeSystemStats()
        return commandResultPayload('incentives_get_node_system_stats', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_get_node_benchmark_history',
    {
      title: 'Get node benchmark history',
      description:
        'Returns benchmark history for a specific node, with optional filters, search, sort, and pagination.',
      inputSchema: {
        nodeId: z.string().describe('Node id path parameter.'),
        page: pageSchema.describe('Results page number (default 1).'),
        size: sizeSchema.default(10).describe('Page size (default 10).'),
        search: searchSchema.describe('Optional benchmark history search term.'),
        useScroll: useScrollSchema.describe(
          'Whether to request scroll pagination. The backend currently accepts this flag but may ignore it.'
        ),
        filters: filtersSchema.describe(
          'Benchmark-history filters forwarded as JSON, for example score or time ranges.'
        ),
        sort: sortInputSchema.describe(
          'Sort map forwarded as JSON, for example `{ "startTime": "desc" }`.'
        )
      }
    },
    async ({ nodeId, page, size, search, useScroll, filters, sort }) => {
      try {
        const result = await incentivesClient.getNodeBenchmarkHistory(nodeId, {
          page,
          size,
          search,
          useScroll,
          filters,
          sort
        })
        return commandResultPayload('incentives_get_node_benchmark_history', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_get_ban_status',
    {
      title: 'Get node ban status',
      description:
        'Returns whether a specific node is currently banned and any associated ban info.',
      inputSchema: {
        nodeId: z.string().describe('Node id path parameter.')
      }
    },
    async ({ nodeId }) => {
      try {
        const result = await incentivesClient.getBanStatus(nodeId)
        return commandResultPayload('incentives_get_ban_status', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_request_unban',
    {
      title: 'Request node unban',
      description: `Submits a signed unban request for a banned or suspended node via the incentives API.

${INCENTIVES_UNBAN_SIGNING_GUIDE}`,
      inputSchema: {
        nodeId: z.string().describe('Node id path parameter.'),
        signature: z
          .string()
          .describe(
            '0x-hex admin wallet signature produced from the expiryTimestamp signing flow described in the tool description.'
          ),
        expiryTimestamp: z
          .number()
          .positive()
          .describe(
            'Future timestamp in milliseconds since epoch. Sign exactly String(expiryTimestamp).'
          ),
        address: z
          .string()
          .describe(
            'Allowed admin wallet address that produced the signature or will validate via ERC-1271.'
          )
      }
    },
    async ({ nodeId, signature, expiryTimestamp, address }) => {
      try {
        const result = await incentivesClient.requestUnban(nodeId, {
          signature,
          expiryTimestamp,
          address
        })
        return commandResultPayload('incentives_request_unban', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_list_unban_requests',
    {
      title: 'List node unban requests',
      description: 'Lists recent unban requests for a specific node.',
      inputSchema: {
        nodeId: z.string().describe('Node id path parameter.'),
        page: pageSchema.describe('Results page number (default 1).'),
        size: sizeSchema.default(5).describe('Page size (default 5).')
      }
    },
    async ({ nodeId, page, size }) => {
      try {
        const result = await incentivesClient.listUnbanRequests(nodeId, {
          page,
          size
        })
        return commandResultPayload('incentives_list_unban_requests', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_get_node_benchmark',
    {
      title: 'Get node benchmark summary',
      description:
        'Returns the latest benchmark scores for a node together with current network min and max values.',
      inputSchema: {
        nodeId: z.string().describe('Node id path parameter.')
      }
    },
    async ({ nodeId }) => {
      try {
        const result = await incentivesClient.getNodeBenchmark(nodeId)
        return commandResultPayload('incentives_get_node_benchmark', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_list_owner_compute_jobs',
    {
      title: 'List owner compute jobs',
      description:
        'Lists compute jobs for an owner, with optional search, filters, sort, scroll flag, and pagination.',
      inputSchema: {
        owner: z.string().describe('Owner path parameter.'),
        page: pageSchema.describe('Results page number (default 1).'),
        size: sizeSchema.default(10).describe('Page size (default 10).'),
        search: searchSchema.describe('Optional compute-job search term.'),
        useScroll: useScrollSchema.describe(
          'Whether to request scroll pagination. The backend currently accepts this flag but may ignore it.'
        ),
        filters: filtersSchema.describe('Compute-job filters forwarded as JSON.'),
        sort: sortInputSchema.describe('Sort map forwarded as JSON.')
      }
    },
    async ({ owner, page, size, search, useScroll, filters, sort }) => {
      try {
        const result = await incentivesClient.listOwnerComputeJobs(owner, {
          page,
          size,
          search,
          useScroll,
          filters,
          sort
        })
        return commandResultPayload('incentives_list_owner_compute_jobs', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_get_owner_env_info',
    {
      title: 'Get owner environment info',
      description:
        'Returns unique compute environment definitions observed for an owner.',
      inputSchema: {
        owner: z.string().describe('Owner path parameter.')
      }
    },
    async ({ owner }) => {
      try {
        const result = await incentivesClient.getOwnerEnvInfo(owner)
        return commandResultPayload('incentives_get_owner_env_info', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_get_owner_nodes_stats',
    {
      title: 'Get owner node stats',
      description:
        'Returns active, inactive, and total node counts for an owner/admin identifier.',
      inputSchema: {
        owner: z.string().describe('Owner path parameter.')
      }
    },
    async ({ owner }) => {
      try {
        const result = await incentivesClient.getOwnerNodesStats(owner)
        return commandResultPayload('incentives_get_owner_nodes_stats', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_get_consumer_jobs_success_rate',
    {
      title: 'Get consumer jobs success rate',
      description:
        'Returns total, successful, and failed job counts for a consumer identifier.',
      inputSchema: {
        consumer: z.string().describe('Consumer path parameter.')
      }
    },
    async ({ consumer }) => {
      try {
        const result = await incentivesClient.getConsumerJobsSuccessRate(consumer)
        return commandResultPayload('incentives_get_consumer_jobs_success_rate', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_list_admin_nodes',
    {
      title: 'List admin nodes',
      description:
        'Lists nodes for a given admin address, with optional search, filters, sort, scroll flag, and pagination.',
      inputSchema: {
        admin: z.string().describe('Admin path parameter.'),
        page: pageSchema.describe('Results page number (default 1).'),
        size: sizeSchema.default(10).describe('Page size (default 10).'),
        search: searchSchema.describe('Optional admin-node search term.'),
        useScroll: useScrollSchema.describe(
          'Whether to request scroll pagination. The backend currently accepts this flag but may ignore it.'
        ),
        filters: filtersSchema.describe('Admin-node filters forwarded as JSON.'),
        sort: sortInputSchema.describe('Sort map forwarded as JSON.')
      }
    },
    async ({ admin, page, size, search, useScroll, filters, sort }) => {
      try {
        const result = await incentivesClient.listAdminNodes(admin, {
          page,
          size,
          search,
          useScroll,
          filters,
          sort
        })
        return commandResultPayload('incentives_list_admin_nodes', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )

  server.registerTool(
    'incentives_list_envs',
    {
      title: 'List incentive environments',
      description:
        'Lists flattened compute environments from the incentives API, with optional filters, sort, scroll flag, and pagination.',
      inputSchema: {
        page: pageSchema.describe('Results page number (default 1).'),
        size: sizeSchema.default(10).describe('Page size (default 10).'),
        useScroll: useScrollSchema.describe(
          'Whether to request scroll pagination. The backend currently accepts this flag but may ignore it.'
        ),
        filters: filtersSchema.describe('Environment filters forwarded as JSON.'),
        sort: sortInputSchema.describe('Sort map forwarded as JSON.')
      }
    },
    async ({ page, size, useScroll, filters, sort }) => {
      try {
        const result = await incentivesClient.listEnvs({
          page,
          size,
          useScroll,
          filters,
          sort
        })
        return commandResultPayload('incentives_list_envs', result)
      } catch (error) {
        return errorPayload(error)
      }
    }
  )
}
