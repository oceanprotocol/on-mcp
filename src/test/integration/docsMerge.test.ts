import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect } from 'chai'

import { loadDocs, type DocIndex } from '../../docs/loader.js'
import { registerPrompts } from '../../prompts/registerPrompts.js'
import { getResourceContent } from '../../resources/resourceCatalog.js'
import { registerResources } from '../../resources/registerResources.js'
import { createServer } from '../../server/createServer.js'
import { registerTools } from '../../tools/registerTools.js'

type RegisteredTool = {
  name: string
}

type RegisteredResource = {
  name: string
  uri: string
}

type RegisteredPrompt = {
  name: string
}

function createFakeServer() {
  const tools: RegisteredTool[] = []
  const resources: RegisteredResource[] = []
  const prompts: RegisteredPrompt[] = []

  const server = {
    registerTool(name: string) {
      tools.push({ name })
    },
    registerResource(name: string, uri: string) {
      resources.push({ name, uri })
    },
    registerPrompt(name: string) {
      prompts.push({ name })
    }
  }

  return {
    server: server as unknown as McpServer,
    tools,
    resources,
    prompts
  }
}

describe('docs MCP merge', () => {
  const envKeys = [
    'ON_DOCS_PATH',
    'OCEAN_NODE_PATH',
    'NODES_DASHBOARD_PATH',
    'NODES_INCENTIVES_MONITOR_PATH',
    'VSCODE_EXTENSION_PATH',
    'OCEAN_CONTRACTS_PATH',
    'OCEAN_JS_PATH',
    'OCEAN_CLI_PATH'
  ] as const

  let tempDir = ''

  function writeFile(relativePath: string, content: string) {
    const targetPath = path.join(tempDir, relativePath)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, content)
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-mcp-docs-'))

    writeFile(
      'ON-Docs-MCP/README.md',
      '# Guide Root\n\nOcean guide content about compute jobs and docs search.'
    )
    writeFile(
      'ocean-node/docs/getting-started.md',
      '# Ocean Node Quickstart\n\nConfigure a node with GPU support.'
    )

    process.env.ON_DOCS_PATH = path.join(tempDir, 'ON-Docs-MCP')
    process.env.OCEAN_NODE_PATH = path.join(tempDir, 'ocean-node')
  })

  afterEach(() => {
    for (const envKey of envKeys) {
      delete process.env[envKey]
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('loads docs and creates the merged server successfully', async () => {
    const docsIndex = await loadDocs()
    expect(docsIndex.map((entry) => entry.uri)).to.include('ocean://docs/guide/README.md')

    const server = createServer({
      nodeClient: {} as any,
      incentivesClient: {} as any,
      evmRegistry: {
        getConfiguredChainIds: (): number[] => [],
        getProvider: (): undefined => undefined
      } as any,
      docsIndex
    })

    expect(server).to.not.equal(undefined)
  })

  it('registers existing and docs tools together', () => {
    const docsIndex: DocIndex = [
      {
        uri: 'ocean://docs/guide/README.md',
        title: 'Guide Root',
        filePath: '/tmp/README.md',
        content: '# Guide Root',
        mimeType: 'text/markdown',
        section: 'guide',
        keywords: ['guide', 'root']
      }
    ]

    const fake = createFakeServer()
    registerTools({
      server: fake.server,
      nodeClient: {} as any,
      incentivesClient: {} as any,
      evmRegistry: {} as any,
      docsIndex
    })

    expect(fake.tools.map((tool) => tool.name)).to.include.members([
      'get_balance',
      'list_resources',
      'get_resource',
      'search_docs',
      'get_doc',
      'list_topics',
      'get_workflow',
      'validate_algo_structure',
      'check_node_eligibility'
    ])
  })

  it('registers built-in and dynamic docs resources and resolves docs by URI', async () => {
    const docsIndex: DocIndex = [
      {
        uri: 'ocean://docs/guide/README.md',
        title: 'Guide Root',
        filePath: '/tmp/README.md',
        content: '# Guide Root\n\nMerged docs resource body.',
        mimeType: 'text/markdown',
        section: 'guide',
        keywords: ['guide', 'root']
      }
    ]

    const fake = createFakeServer()
    registerResources({
      server: fake.server,
      nodeClient: {} as any,
      incentivesClient: {} as any,
      evmRegistry: {
        getConfiguredChainIds: (): number[] => [],
        getProvider: (): undefined => undefined
      } as any,
      docsIndex
    })

    expect(fake.resources.map((resource) => resource.uri)).to.include.members([
      'ocean://docs/c2d-find-provider-search',
      'ocean://evm/supported-chains',
      'ocean://docs/guide/README.md'
    ])

    const resolved = await getResourceContent(
      {
        evmRegistry: {
          getConfiguredChainIds: (): number[] => [],
          getProvider: (): undefined => undefined
        } as any,
        docsIndex
      },
      'ocean://docs/guide/README.md'
    )

    expect(resolved?.text).to.contain('Merged docs resource body.')
  })

  it('registers docs prompts on the main server', () => {
    const fake = createFakeServer()
    registerPrompts(fake.server)

    expect(fake.prompts.map((prompt) => prompt.name)).to.deep.equal([
      'new_c2d_algo_python',
      'new_c2d_algo_js',
      'setup_node',
      'run_compute_job',
      'publish_asset',
      'debug_node'
    ])
  })
})
