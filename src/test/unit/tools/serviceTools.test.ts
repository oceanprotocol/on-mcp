import { expect } from 'chai'
import type { ComputeEnvironment } from '@oceanprotocol/lib'

import { NodeClient } from '../../../clients/nodeClient.js'
import { registerServiceTools, serviceEscrowGate } from '../../../tools/serviceTools.js'
import type { EscrowPreflightResult } from '../../../tools/escrowPreflight.js'

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

const NODE_ID = '16Uiu2HAmR9z4EhF9zoZcErrdcEJKCjfTpXJfBcmbNppbT3QYtBpi'
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const PAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ESCROW = '0x0000000000000000000000000000000000000099'

/** Unsigned JWT-shaped token — decodeAuthTokenAddress only base64url-decodes the payload. */
function fakeAuthToken(address = PAYER): string {
  const payload = Buffer.from(JSON.stringify({ address })).toString('base64url')
  return `header.${payload}.signature`
}

function env(overrides: Partial<ComputeEnvironment> = {}): ComputeEnvironment {
  return {
    id: 'env-1',
    consumerAddress: PAYEE,
    runningJobs: 0,
    fees: {
      '8453': [{ feeToken: TOKEN, prices: [{ id: 'cpu', price: 1 }] }]
    },
    resources: [{ id: 'cpu', kind: 'fungible', total: 8, inUse: 0, max: 8, min: 1 }],
    ...overrides
  } as ComputeEnvironment
}

function registerAndCollect(nodeClient: NodeClient, evmRegistry?: unknown) {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler)
    }
  }
  registerServiceTools({
    server: server as never,
    nodeClient,
    evmRegistry: evmRegistry as never
  })
  return handlers
}

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text)
}

/**
 * Minimal method stub with call recording. `sinon` is a devDependency but ships no type
 * declarations and no other suite uses it, so this keeps the tests dependency-free.
 */
type Stub = {
  called: boolean
  callCount: number
  calls: unknown[][]
  firstCallArgs: () => unknown[]
}
const restores: Array<() => void> = []

function stub<T extends object, K extends keyof T>(
  target: T,
  method: K,
  impl?: (...args: unknown[]) => unknown
): Stub {
  const original = target[method]
  const record: Stub = {
    called: false,
    callCount: 0,
    calls: [],
    firstCallArgs: () => record.calls[0] ?? []
  }
  const replacement = (...args: unknown[]) => {
    record.called = true
    record.callCount += 1
    record.calls.push(args)
    return impl ? impl(...args) : undefined
  }
  ;(target as Record<K, unknown>)[method] = replacement as T[K]
  restores.push(() => {
    ;(target as Record<K, unknown>)[method] = original
  })
  return record
}

/** Resolve to `value`, or to the i-th entry of `values` on the i-th call. */
function resolves(...values: unknown[]) {
  let i = 0
  return () => {
    const value = values[Math.min(i, values.length - 1)]
    i += 1
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
  }
}

function restoreAll() {
  while (restores.length) restores.pop()!()
}

describe('registerServiceTools', () => {
  afterEach(restoreAll)

  it('registers all 11 service tools', () => {
    const handlers = registerAndCollect(new NodeClient())
    expect([...handlers.keys()]).to.deep.equal([
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
    ])
  })

  it('surfaces resolveAuth errors as isError instead of throwing', async () => {
    const handlers = registerAndCollect(new NodeClient())
    const both = await handlers.get('serviceStatus')!({
      nodeId: NODE_ID,
      authToken: fakeAuthToken(),
      completeSignature: { consumerAddress: PAYER, nonce: '1', signature: '0xsig' }
    })
    expect(both.isError).to.equal(true)
    expect(both.content[0].text).to.contain('not both')

    const neither = await handlers.get('serviceStatus')!({ nodeId: NODE_ID })
    expect(neither.isError).to.equal(true)
    expect(neither.content[0].text).to.contain('exactly one')
  })

  describe('serviceStart guards', () => {
    it('rejects more than one image mode locally', async () => {
      const nodeClient = new NodeClient()
      const start = stub(nodeClient, 'serviceStart')
      const handlers = registerAndCollect(nodeClient)
      const result = await handlers.get('serviceStart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        environment: 'env-1',
        image: 'nginx',
        tag: 'latest',
        checksum: 'sha256:' + 'a'.repeat(64),
        duration: 600,
        payment: { chainId: 8453, token: TOKEN }
      })
      expect(result.isError).to.equal(true)
      expect(result.content[0].text).to.contain('mutually exclusive')
      expect(start.called).to.equal(false)
    })

    it('refuses a privileged in-container port before charging for it', async () => {
      const nodeClient = new NodeClient()
      const start = stub(nodeClient, 'serviceStart')
      const handlers = registerAndCollect(nodeClient)
      const result = await handlers.get('serviceStart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        environment: 'env-1',
        image: 'nginx',
        tag: 'latest',
        exposedPorts: [80],
        duration: 600,
        payment: { chainId: 8453, token: TOKEN }
      })
      expect(result.isError).to.equal(true)
      expect(result.content[0].text).to.contain('below 1024')
      expect(start.called).to.equal(false)
    })

    it('refuses an env that sets features.services = false', async () => {
      const nodeClient = new NodeClient()
      stub(
        nodeClient,
        'getComputeEnvironments',
        resolves([env({ features: { services: false } })])
      )
      const start = stub(nodeClient, 'serviceStart')
      const handlers = registerAndCollect(nodeClient)
      const result = await handlers.get('serviceStart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        environment: 'env-1',
        image: 'nginx',
        tag: 'latest',
        duration: 600,
        payment: { chainId: 8453, token: TOKEN }
      })
      expect(result.isError).to.equal(true)
      expect(result.content[0].text).to.contain('features.services = false')
      expect(start.called).to.equal(false)
    })

    it('never echoes a userData value, only its keys', async () => {
      const secret = 'hf_super-secret-token-value'
      const nodeClient = new NodeClient()
      stub(nodeClient, 'getComputeEnvironments', resolves([env()]))
      stub(
        nodeClient,
        'serviceStart',
        resolves([
          {
            serviceId: 'svc-1',
            status: 10,
            statusText: 'Starting',
            endpoints: [],
            expiresAt: 0,
            payment: {},
            // The node strips userData from responses; assert we do not re-add it.
            image: 'nginx'
          }
        ])
      )
      const handlers = registerAndCollect(nodeClient)

      const result = await handlers.get('serviceStart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        environment: 'env-1',
        image: 'nginx',
        tag: 'latest',
        duration: 600,
        payment: { chainId: 8453, token: TOKEN },
        userData: { HF_TOKEN: secret }
      })

      // Assert on the SERIALIZED payload — a nested echo would still leak.
      const serialized = result.content[0].text
      expect(serialized).to.not.contain(secret)
      expect(serialized).to.contain('HF_TOKEN')
      const body = parse(result)
      expect(body.result).to.have.nested.property('userDataKeys')
      expect((body.result as { userDataKeys: string[] }).userDataKeys).to.deep.equal([
        'HF_TOKEN'
      ])
    })

    it('tells the caller to poll rather than implying the service is up', async () => {
      const nodeClient = new NodeClient()
      stub(nodeClient, 'getComputeEnvironments', resolves([env()]))
      stub(
        nodeClient,
        'serviceStart',
        resolves([
          { serviceId: 'svc-1', status: 10, statusText: '', endpoints: [], payment: {} }
        ])
      )
      const handlers = registerAndCollect(nodeClient)
      const result = await handlers.get('serviceStart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        environment: 'env-1',
        image: 'nginx',
        tag: 'latest',
        duration: 600,
        payment: { chainId: 8453, token: TOKEN }
      })
      const body = parse(result) as { result: { nextStep: string } }
      expect(body.result.nextStep).to.contain('NOT up yet')
      expect(body.result.nextStep).to.contain('serviceStatus')
    })
  })

  describe('serviceRestart RESPEC guard', () => {
    it('rejects dockerCmd without image, explaining REUSE vs RESPEC', async () => {
      const nodeClient = new NodeClient()
      const restart = stub(nodeClient, 'serviceRestart')
      const handlers = registerAndCollect(nodeClient)
      const result = await handlers.get('serviceRestart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        serviceId: 'svc-1',
        dockerCmd: ['--flag']
      })
      expect(result.isError).to.equal(true)
      expect(result.content[0].text).to.contain('all-old or all-new')
      expect(result.content[0].text).to.contain('dockerCmd')
      // The point of the local guard: no pointless round-trip to a bare node 400.
      expect(restart.called).to.equal(false)
    })

    it('rejects userData without image (the secret-rotation trap)', async () => {
      const nodeClient = new NodeClient()
      const restart = stub(nodeClient, 'serviceRestart')
      const handlers = registerAndCollect(nodeClient)
      const result = await handlers.get('serviceRestart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        serviceId: 'svc-1',
        userData: { HF_TOKEN: 'rotated-secret' }
      })
      expect(result.isError).to.equal(true)
      expect(result.content[0].text).to.contain('re-send the FULL')
      expect(result.content[0].text).to.not.contain('rotated-secret')
      expect(restart.called).to.equal(false)
    })

    it('passes no params in REUSE mode (serviceId only)', async () => {
      const nodeClient = new NodeClient()
      const restart = stub(
        nodeClient,
        'serviceRestart',
        resolves([
          { serviceId: 'svc-1', status: 45, statusText: '', endpoints: [], payment: {} }
        ])
      )
      const handlers = registerAndCollect(nodeClient)
      const result = await handlers.get('serviceRestart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        serviceId: 'svc-1'
      })
      expect(restart.callCount).to.equal(1)
      expect(restart.firstCallArgs()[4]).to.equal(undefined)
      const body = parse(result) as { result: { mode: string } }
      expect(body.result.mode).to.equal('REUSE')
    })

    it('forwards the full spec in RESPEC mode', async () => {
      const nodeClient = new NodeClient()
      const restart = stub(
        nodeClient,
        'serviceRestart',
        resolves([
          { serviceId: 'svc-1', status: 45, statusText: '', endpoints: [], payment: {} }
        ])
      )
      const handlers = registerAndCollect(nodeClient)
      const result = await handlers.get('serviceRestart')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        serviceId: 'svc-1',
        image: 'nginx',
        tag: '1.27',
        userData: { A: 'b' }
      })
      expect(restart.firstCallArgs()[4]).to.deep.equal({
        image: 'nginx',
        tag: '1.27',
        userData: { A: 'b' }
      })
      const body = parse(result) as { result: { mode: string } }
      expect(body.result.mode).to.equal('RESPEC')
    })
  })

  describe('getServices', () => {
    it("labels the result node-wide so it is not presented as the user's own", async () => {
      const nodeClient = new NodeClient()
      stub(
        nodeClient,
        'getServices',
        resolves([
          {
            serviceId: 'other-1',
            owner: '0x' + '11'.repeat(20),
            status: 40,
            statusText: '',
            endpoints: [],
            payment: {},
            updatedAt: 1700000000000
          },
          {
            serviceId: 'other-2',
            owner: '0x' + '22'.repeat(20),
            status: 40,
            statusText: '',
            endpoints: [],
            payment: {},
            updatedAt: 1700000005000
          }
        ])
      )
      const handlers = registerAndCollect(nodeClient)
      const body = parse(
        await handlers.get('getServices')!({
          nodeId: NODE_ID,
          authToken: fakeAuthToken()
        })
      ) as {
        result: { scope: string; ownerScoped: boolean; note: string; syncCursor: string }
      }
      expect(body.result.scope).to.equal('node-wide')
      expect(body.result.ownerScoped).to.equal(false)
      expect(body.result.note).to.contain('ALL owners')
      // updatedSince cursor = max updatedAt seen
      expect(body.result.syncCursor).to.equal('1700000005000')
    })
  })

  describe('serviceLogs', () => {
    it('defaults `since` to a bounded window rather than full history', async () => {
      const nodeClient = new NodeClient()
      const logs = stub(
        nodeClient,
        'serviceLogs',
        resolves({ text: 'hello', byteLength: 5, truncated: false })
      )
      const handlers = registerAndCollect(nodeClient)
      await handlers.get('serviceLogs')!({
        nodeId: NODE_ID,
        authToken: fakeAuthToken(),
        serviceId: 'svc-1'
      })
      expect(logs.firstCallArgs()[4]).to.equal('5m')
      expect(logs.firstCallArgs()[5]).to.be.a('number')
    })

    it("translates since '0' into an unbounded request", async () => {
      const nodeClient = new NodeClient()
      const logs = stub(
        nodeClient,
        'serviceLogs',
        resolves({ text: '', byteLength: 0, truncated: false })
      )
      const handlers = registerAndCollect(nodeClient)
      const body = parse(
        await handlers.get('serviceLogs')!({
          nodeId: NODE_ID,
          authToken: fakeAuthToken(),
          serviceId: 'svc-1',
          since: '0'
        })
      ) as { result: { since: string } }
      expect(logs.firstCallArgs()[4]).to.equal(undefined)
      expect(body.result.since).to.equal('full history')
    })

    it('explains a truncated payload instead of silently dropping the tail', async () => {
      const nodeClient = new NodeClient()
      stub(
        nodeClient,
        'serviceLogs',
        resolves({
          text: 'partial',
          byteLength: 7,
          truncated: true,
          bytesAvailableAtLeast: 900
        })
      )
      const handlers = registerAndCollect(nodeClient)
      const body = parse(
        await handlers.get('serviceLogs')!({
          nodeId: NODE_ID,
          authToken: fakeAuthToken(),
          serviceId: 'svc-1'
        })
      ) as { result: { truncationNote: string } }
      expect(body.result.truncationNote).to.contain('maxBytes')
    })
  })

  describe('findServiceEnvironments', () => {
    it('reports why an env was skipped rather than silently narrowing', async () => {
      const nodeClient = new NodeClient()
      stub(
        nodeClient,
        'getComputeEnvironments',
        resolves([
          env({ id: 'ok' }),
          env({ id: 'flag-off', features: { services: false } }),
          env({ id: 'no-price', fees: {} }),
          env({
            id: 'no-capacity',
            resources: [{ id: 'cpu', kind: 'fungible', total: 2, inUse: 2, max: 2 }]
          })
        ])
      )
      const handlers = registerAndCollect(nodeClient)
      const body = parse(
        await handlers.get('findServiceEnvironments')!({
          nodeId: NODE_ID,
          chainId: 8453,
          token: TOKEN,
          resources: [{ id: 'cpu', amount: 2 }]
        })
      ) as {
        result: {
          eligibleCount: number
          environments: { id: string; eligible: boolean; mismatchReason?: string }[]
        }
      }

      const byId = new Map(body.result.environments.map((e) => [e.id, e]))
      expect(byId.get('ok')!.eligible).to.equal(true)
      expect(byId.get('flag-off')!.mismatchReason).to.contain('features.services = false')
      expect(byId.get('no-price')!.mismatchReason).to.contain('no fee schedule')
      expect(byId.get('no-capacity')!.mismatchReason).to.contain('cpu: need 2, have 0')
      expect(body.result.eligibleCount).to.equal(1)
    })

    it('matches the fee token case-insensitively when filtering', async () => {
      const nodeClient = new NodeClient()
      stub(nodeClient, 'getComputeEnvironments', resolves([env()]))
      const handlers = registerAndCollect(nodeClient)
      const body = parse(
        await handlers.get('findServiceEnvironments')!({
          nodeId: NODE_ID,
          chainId: 8453,
          token: TOKEN.toLowerCase()
        })
      ) as { result: { eligibleCount: number } }
      expect(body.result.eligibleCount).to.equal(1)
    })
  })

  describe('findServiceNodes', () => {
    it('skips unreachable peers without failing the whole call', async () => {
      const nodeClient = new NodeClient()
      stub(
        nodeClient,
        'listDiscoveredPeers',
        resolves([
          { peerId: 'peer-good', multiaddrs: [] },
          { peerId: 'peer-bad', multiaddrs: [] }
        ])
      )
      // First peer answers, second fails to dial.
      stub(
        nodeClient,
        'getComputeEnvironments',
        resolves([env()], new Error('dial failed'))
      )
      const handlers = registerAndCollect(nodeClient)

      const body = parse(await handlers.get('findServiceNodes')!({})) as {
        result: {
          nodes: { peerId: string }[]
          skipped: { peerId: string; error: string }[]
          probedCount: number
        }
      }
      expect(body.result.nodes.map((n) => n.peerId)).to.deep.equal(['peer-good'])
      expect(body.result.skipped[0].peerId).to.equal('peer-bad')
      expect(body.result.skipped[0].error).to.contain('dial failed')
      expect(body.result.probedCount).to.equal(2)
    })

    it('reports truncation instead of silently capping coverage', async () => {
      const nodeClient = new NodeClient()
      stub(nodeClient, 'getComputeEnvironments', resolves([env()]))
      const handlers = registerAndCollect(nodeClient)
      const body = parse(
        await handlers.get('findServiceNodes')!({
          peerIds: ['a', 'b', 'c'],
          maxPeers: 2
        })
      ) as { result: { truncated?: string; probedCount: number } }
      expect(body.result.probedCount).to.equal(2)
      expect(body.result.truncated).to.contain('first 2 of 3')
    })
  })

  describe('getServiceTemplates', () => {
    it('never reports an empty catalogue as services being unavailable', async () => {
      const nodeClient = new NodeClient()
      stub(nodeClient, 'getServiceTemplates', resolves([]))
      const handlers = registerAndCollect(nodeClient)
      const body = parse(
        await handlers.get('getServiceTemplates')!({ nodeId: NODE_ID })
      ) as { result: { count: number; note: string } }
      expect(body.result.count).to.equal(0)
      expect(body.result.note).to.contain('normal state')
    })
  })
})

describe('serviceEscrowGate', () => {
  const GATE_ARGS = {
    command: 'serviceStart',
    node: { nodeId: NODE_ID },
    timeout: 10000,
    env: env(),
    chainId: 8453,
    token: TOKEN,
    resources: [{ id: 'cpu', amount: 1 }],
    durationSeconds: 600
  }

  function preflightResult(canStartThisJob: boolean): EscrowPreflightResult {
    return {
      ready: canStartThisJob,
      canStartThisJob,
      reason: canStartThisJob ? undefined : 'insufficient_funds',
      payer: PAYER,
      payee: PAYEE,
      token: TOKEN,
      chainId: 8453,
      escrowAddress: ESCROW,
      required: {
        amount: '10',
        parallelJobs: 3,
        maxLockedAmount: '30',
        maxLockSeconds: '87000',
        maxLockCounts: '3',
        minLockSeconds: '4200'
      },
      current: { funds: '0', authorization: { exists: false } },
      shortfalls: ['escrow funds 0 < 30'],
      action: { url: 'https://example.invalid', instructions: 'deposit' }
    }
  }

  function stubbedClient() {
    const nodeClient = new NodeClient()
    stub(nodeClient, 'status', resolves({ escrowAddress: { '8453': ESCROW } }))
    return nodeClient
  }

  /**
   * Minimal ethers ContractRunner that answers the ERC-20 `decimals()` view with 18, so the
   * gate's real cost path (including getTokenDecimals) runs without an RPC endpoint.
   */
  const fakeEvmRegistry = {
    getProvider: () => ({ call: () => Promise.resolve(`0x${'0'.repeat(62)}12`) })
  } as never

  afterEach(restoreAll)

  it('blocks with a diagnosable payload when the job cannot be paid for', async () => {
    const gate = await serviceEscrowGate({
      ...GATE_ARGS,
      nodeClient: stubbedClient(),
      evmRegistry: fakeEvmRegistry,
      args: { authToken: fakeAuthToken() },
      runPreflight: () => Promise.resolve(preflightResult(false))
    })
    expect(gate).to.not.equal(undefined)
    expect(gate!.isError).to.equal(true)
    const body = JSON.parse(gate!.content[0].text)
    expect(body.error).to.equal('escrow_preflight_failed')
    expect(body.message).to.contain('skipEscrowPreflight')
    expect(body.message).to.contain('estimate')
    expect(body.preflight.canStartThisJob).to.equal(false)
  })

  it('proceeds when the job can be paid for', async () => {
    const gate = await serviceEscrowGate({
      ...GATE_ARGS,
      nodeClient: stubbedClient(),
      evmRegistry: fakeEvmRegistry,
      args: { authToken: fakeAuthToken() },
      runPreflight: () => Promise.resolve(preflightResult(true))
    })
    expect(gate).to.equal(undefined)
  })

  it('is bypassed by skipEscrowPreflight', async () => {
    let called = false
    const gate = await serviceEscrowGate({
      ...GATE_ARGS,
      nodeClient: stubbedClient(),
      evmRegistry: fakeEvmRegistry,
      args: { authToken: fakeAuthToken(), skipEscrowPreflight: true },
      runPreflight: () => {
        called = true
        return Promise.resolve(preflightResult(false))
      }
    })
    expect(gate).to.equal(undefined)
    expect(called).to.equal(false)
  })

  it('proceeds (best-effort) when no evmRegistry is configured', async () => {
    const gate = await serviceEscrowGate({
      ...GATE_ARGS,
      nodeClient: stubbedClient(),
      evmRegistry: undefined,
      args: { authToken: fakeAuthToken() },
      runPreflight: () => Promise.resolve(preflightResult(false))
    })
    expect(gate).to.equal(undefined)
  })

  it('proceeds when the payer cannot be resolved from the auth inputs', async () => {
    const gate = await serviceEscrowGate({
      ...GATE_ARGS,
      nodeClient: stubbedClient(),
      evmRegistry: fakeEvmRegistry,
      args: { authToken: 'not-a-jwt' },
      runPreflight: () => Promise.resolve(preflightResult(false))
    })
    expect(gate).to.equal(undefined)
  })

  it('proceeds when an internal step throws, letting the node decide', async () => {
    const nodeClient = new NodeClient()
    stub(nodeClient, 'status', resolves(new Error('rpc down')))
    const gate = await serviceEscrowGate({
      ...GATE_ARGS,
      nodeClient,
      evmRegistry: fakeEvmRegistry,
      args: { authToken: fakeAuthToken() },
      runPreflight: () => Promise.resolve(preflightResult(false))
    })
    expect(gate).to.equal(undefined)
  })

  it('skips the gate entirely for a zero-cost service instead of building an invalid payment', async () => {
    let called = false
    const gate = await serviceEscrowGate({
      ...GATE_ARGS,
      // Priced at 0 → escrow_preflight's strictly-positive paymentSchema would reject it.
      env: env({
        fees: { '8453': [{ feeToken: TOKEN, prices: [{ id: 'cpu', price: 0 }] }] }
      }),
      nodeClient: stubbedClient(),
      evmRegistry: fakeEvmRegistry,
      args: { authToken: fakeAuthToken() },
      runPreflight: () => {
        called = true
        return Promise.resolve(preflightResult(false))
      }
    })
    expect(gate).to.equal(undefined)
    expect(called).to.equal(false)
  })

  it('proceeds when the env has no fee schedule for the pair (node will 400 authoritatively)', async () => {
    const gate = await serviceEscrowGate({
      ...GATE_ARGS,
      env: env({ fees: {} }),
      nodeClient: stubbedClient(),
      evmRegistry: fakeEvmRegistry,
      args: { authToken: fakeAuthToken() },
      runPreflight: () => Promise.resolve(preflightResult(false))
    })
    expect(gate).to.equal(undefined)
  })
})
