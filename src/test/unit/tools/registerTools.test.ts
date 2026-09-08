import { expect } from 'chai'

import { registerTools } from '../../../tools/registerTools.js'

const INCENTIVES_TOOL_NAMES = [
  'incentives_list_nodes',
  'incentives_run_query',
  'incentives_get_node_system_stats',
  'incentives_get_node_benchmark_history',
  'incentives_get_ban_status',
  'incentives_request_unban',
  'incentives_list_unban_requests',
  'incentives_get_node_benchmark',
  'incentives_list_owner_compute_jobs',
  'incentives_get_owner_env_info',
  'incentives_get_owner_nodes_stats',
  'incentives_get_consumer_jobs_success_rate',
  'incentives_list_admin_nodes',
  'incentives_list_envs'
]

const SERVICE_TOOL_NAMES = [
  'findServiceEnvironments',
  'findServiceNodes',
  'getServiceTemplates',
  'estimateServiceCost',
  'serviceStart',
  'serviceStatus',
  'getServices',
  'serviceExtend',
  'serviceRestart',
  'serviceStop',
  'serviceLogs'
]

type Registered = {
  names: string[]
  configs: Map<string, { title?: string; description?: string; inputSchema?: object }>
}

function registerAll(): Registered {
  const names: string[] = []
  const configs = new Map<string, never>()
  const server = {
    registerTool(name: string, config: never) {
      names.push(name)
      configs.set(name, config)
    }
  }

  registerTools({
    server: server as never,
    nodeClient: {} as never,
    incentivesClient: {} as never,
    evmRegistry: {} as never,
    docsIndex: []
  })

  return { names, configs }
}

describe('registerTools', () => {
  it('registers the incentives tool group', () => {
    expect(
      registerAll().names.filter((name) => name.startsWith('incentives_'))
    ).to.deep.equal(INCENTIVES_TOOL_NAMES)
  })

  it('registers the service tool group', () => {
    const { names } = registerAll()
    for (const tool of SERVICE_TOOL_NAMES) {
      expect(names, `${tool} registered`).to.include(tool)
    }
  })

  it('registers every tool name exactly once', () => {
    const { names } = registerAll()
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i)
    expect(duplicates).to.deep.equal([])
  })

  describe('service tool schemas', () => {
    const { configs } = registerAll()

    it('gives every service tool a title and description', () => {
      for (const tool of SERVICE_TOOL_NAMES) {
        const config = configs.get(tool)!
        expect(config.title, `${tool} title`).to.be.a('string')
        expect(config.description, `${tool} description`).to.be.a('string')
        expect(
          (config.description as string).length,
          `${tool} description length`
        ).to.be.greaterThan(200)
      }
    })

    it('targets a node on every tool except the peer fan-out', () => {
      for (const tool of SERVICE_TOOL_NAMES) {
        const schema = configs.get(tool)!.inputSchema as Record<string, unknown>
        if (tool === 'findServiceNodes') {
          expect(schema).to.have.property('peerIds')
          continue
        }
        expect(schema, `${tool} nodeId`).to.have.property('nodeId')
        expect(schema, `${tool} multiaddress`).to.have.property('multiaddress')
      }
    })

    it('requires auth on exactly the authenticated commands', () => {
      const authenticated = [
        'serviceStart',
        'serviceStatus',
        'getServices',
        'serviceExtend',
        'serviceRestart',
        'serviceStop',
        'serviceLogs'
      ]
      const unauthenticated = [
        'findServiceEnvironments',
        'findServiceNodes',
        'getServiceTemplates',
        'estimateServiceCost'
      ]
      for (const tool of authenticated) {
        const schema = configs.get(tool)!.inputSchema as Record<string, unknown>
        expect(schema, `${tool} authToken`).to.have.property('authToken')
        expect(schema, `${tool} completeSignature`).to.have.property('completeSignature')
      }
      for (const tool of unauthenticated) {
        const schema = configs.get(tool)!.inputSchema as Record<string, unknown>
        expect(schema, `${tool} has no authToken`).to.not.have.property('authToken')
      }
    })

    it('exposes the escrow bypass only on the two paying tools', () => {
      for (const tool of SERVICE_TOOL_NAMES) {
        const schema = configs.get(tool)!.inputSchema as Record<string, unknown>
        const expected = tool === 'serviceStart' || tool === 'serviceExtend'
        expect(
          Object.prototype.hasOwnProperty.call(schema, 'skipEscrowPreflight'),
          `${tool} skipEscrowPreflight`
        ).to.equal(expected)
      }
    })

    it('accepts the container spec on serviceStart and serviceRestart', () => {
      for (const tool of ['serviceStart', 'serviceRestart']) {
        const schema = configs.get(tool)!.inputSchema as Record<string, unknown>
        for (const field of [
          'image',
          'tag',
          'checksum',
          'dockerfile',
          'additionalDockerFiles',
          'dockerCmd',
          'dockerEntrypoint',
          'userData'
        ]) {
          expect(schema, `${tool}.${field}`).to.have.property(field)
        }
      }
    })

    it('does not offer a templateId on serviceStart (templates are informational)', () => {
      const schema = configs.get('serviceStart')!.inputSchema as Record<string, unknown>
      expect(schema).to.not.have.property('templateId')
      expect(schema).to.have.property('environment')
      expect(schema).to.have.property('duration')
      expect(schema).to.have.property('payment')
    })

    it('warns about the node-wide scope of getServices in its description', () => {
      const description = configs.get('getServices')!.description as string
      expect(description).to.contain('NOT owner-scoped')
    })

    it('states that serviceStop keeps the paid reservation', () => {
      const description = configs.get('serviceStop')!.description as string
      expect(description).to.contain('does not save money')
      expect(description).to.contain('Expired')
    })
  })
})
