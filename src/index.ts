import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { Wallet } from 'ethers'
import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'

import { ProviderInstance } from '@oceanprotocol/lib'
import { IncentivesClient } from './clients/incentivesClient.js'
import { NodeClient } from './clients/nodeClient.js'
import { loadDocs } from './docs/loader.js'
import {
  getEvmProviderRegistry,
  initEvmProviderRegistryFromEnv
} from './evm/evmProviderRegistry.js'
import { createServer } from './server/createServer.js'
import type { ServerContext } from './server/serverContext.js'

import fs from 'fs'
import util from 'util'

const logFile = fs.createWriteStream('debug.log', { flags: 'a' })

// Overwrite console.error to go to a file
console.error = (...args) => {
  logFile.write(util.format(...args) + '\n')
}

// Also catch the libp2p DEBUG logs
process.stderr.write = (chunk) => {
  logFile.write(chunk)
  return true
}

console.error('LOGGING INITIALIZED')

const transportMode = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase()
const ssePort = process.env.MCP_PORT ? Number(process.env.MCP_PORT) : 3000
const sseHost = process.env.MCP_HOST ?? '127.0.0.1'

let isShuttingDown = false
async function shutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  try {
    await getEvmProviderRegistry().destroy()
  } catch (error) {
    console.error(`[${signal}] Failed to destroy EVM provider registry:`, error)
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => console.error('[SIGINT] Shutdown failed:', error))
})
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => console.error('[SIGTERM] Shutdown failed:', error))
})

async function startStdioServer(serverContext: ServerContext) {
  const server = createServer(serverContext)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function startSseServer(serverContext: ServerContext) {
  const app = createMcpExpressApp({ host: sseHost })
  const transports: Record<string, StreamableHTTPServerTransport> = {}

  const getHeaderValue = (header: string | string[] | undefined): string | undefined =>
    typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined

  const isInitializeRequest = (body: unknown): boolean =>
    !!body &&
    typeof body === 'object' &&
    'method' in body &&
    (body as { method?: unknown }).method === 'initialize'

  const mcpHandler = async (req: Request, res: Response) => {
    const sessionId = getHeaderValue(req.headers['mcp-session-id'])

    try {
      let transport: StreamableHTTPServerTransport

      if (sessionId) {
        const existingTransport = transports[sessionId]
        if (!existingTransport) {
          res.status(404).send('Session not found')
          return
        }
        transport = existingTransport
      } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport
          }
        })

        transport.onclose = () => {
          const id = transport.sessionId
          if (id) {
            delete transports[id]
          }
        }

        const server = createServer(serverContext)
        await server.connect(transport)
      } else {
        res.status(400).send('Missing or invalid MCP session')
        return
      }

      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error('Error handling MCP request:', error)
      if (!res.headersSent) {
        res.status(500).send('Error handling MCP request')
      }
    }
  }

  app.post('/mcp', mcpHandler)
  app.get('/mcp', mcpHandler)
  app.delete('/mcp', mcpHandler)
  app.post('/', mcpHandler)
  app.get('/', mcpHandler)
  app.delete('/', mcpHandler)

  await new Promise<void>((resolve, reject) => {
    app.listen(ssePort, sseHost, (error?: Error) => {
      if (error) {
        reject(error)
        return
      }

      console.error(
        `MCP Streamable HTTP server listening on http://${sseHost}:${ssePort}/mcp`
      )
      resolve()
    })
  })
}

async function createServerContext(): Promise<ServerContext> {
  const evmRegistry = getEvmProviderRegistry()
  const nodeClient = new NodeClient()
  const incentivesClient = new IncentivesClient()
  const docsIndex = await loadDocs()

  return {
    nodeClient,
    incentivesClient,
    evmRegistry,
    docsIndex
  }
}

async function main(): Promise<void> {
  if (!process.env.PRIVATE_KEY) {
    process.env.PRIVATE_KEY = Wallet.createRandom().privateKey
    console.warn(
      'PRIVATE_KEY was not provided; generated an ephemeral random key for this session.'
    )
  }

  initEvmProviderRegistryFromEnv()

  const extra = process.env.BOOTSTRAP_PEERS?.split(',').filter(Boolean) || []

  // Default Ocean bootstrap nodes (must be included explicitly since passing
  // bootstrapPeers to setupP2P replaces the built-in defaults)
  const oceanDefaults = [
    '/dns4/bootstrap1.oncompute.ai/tcp/9001/ws/p2p/16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP',
    '/dns4/bootstrap2.oncompute.ai/tcp/9001/ws/p2p/16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4',
    '/dns4/bootstrap3.oncompute.ai/tcp/9001/ws/p2p/16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U',
    '/dns4/bootstrap4.oncompute.ai/tcp/9001/ws/p2p/16Uiu2HAmSTVTArioKm2wVcyeASHYEsnx2ZNq467Z4GMDU4ErEPom'
  ]

  const bootstrapPeers = [...extra, ...oceanDefaults]
  // console.info('P2P mode detected. Initializing libp2p...')
  // console.info(`Bootstrap peers: ${bootstrapPeers.length}`)

  // Allow localhost connections / local nodes
  await ProviderInstance.setupP2P({
    bootstrapPeers,
    libp2p: {
      connectionGater: {
        denyDialMultiaddr: () => false
      }
    }
  } as any)
  // console.info('libp2p node started. Waiting for peer connections...')

  const serverContext = await createServerContext()

  if (transportMode === 'sse') {
    await startSseServer(serverContext)
    return
  }

  await startStdioServer(serverContext)
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : `${error}`
  console.error('Failed to start ocean-mcp server:', message)
  process.exit(1)
})
