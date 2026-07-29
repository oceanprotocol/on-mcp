import { expect } from 'chai'
import { ProviderInstance } from '@oceanprotocol/lib'
import type { ComputeEnvironment, NodeStatus, ServiceJob } from '@oceanprotocol/lib'

import { NodeClient } from '../../clients/nodeClient.js'
import { parseNodeTarget } from '../../tools/p2pSchemas.js'
import {
  buildServicePaymentInfo,
  decorateServiceJob,
  estimateServiceCost,
  resolveServiceResources,
  toRawAmount
} from '../../tools/serviceCost.js'
import { isServiceTerminal, serviceStatusLabel } from '../../tools/serviceSchemas.js'

/**
 * Opt-in end-to-end service lifecycle against a real post-#1408 ocean-node with
 * `serviceOnDemand` configured. Mirrors ocean-node `src/test/integration/services.test.ts` and
 * ocean-cli `test/serviceFlow.test.ts`.
 *
 * This one **spends escrow funds**, so it never runs by default. Enable with:
 *
 *   SERVICE_IT_NODE_ID=<peerId> \
 *   SERVICE_IT_AUTH_TOKEN=<jwt minted for that node> \
 *   SERVICE_IT_CHAIN_ID=8453 \
 *   SERVICE_IT_TOKEN=<feeToken exactly as the env advertises it> \
 *   SERVICE_IT_MULTIADDRESS=/ip4/127.0.0.1/tcp/9001   # optional \
 *   SERVICE_IT_BOOTSTRAP=/ip4/127.0.0.1/tcp/9001/p2p/<peerId>   # optional \
 *   npm run test:integration
 */
const NODE_ID = process.env.SERVICE_IT_NODE_ID
const AUTH_TOKEN = process.env.SERVICE_IT_AUTH_TOKEN
const CHAIN_ID = Number(process.env.SERVICE_IT_CHAIN_ID ?? '0')
const FEE_TOKEN = process.env.SERVICE_IT_TOKEN
const MULTIADDRESS = process.env.SERVICE_IT_MULTIADDRESS
const ENABLED = Boolean(NODE_ID && AUTH_TOKEN && CHAIN_ID && FEE_TOKEN)

/** Small, fast-pulling image that serves HTTP on a non-privileged port. */
const IMAGE = process.env.SERVICE_IT_IMAGE ?? 'hashicorp/http-echo'
const IMAGE_TAG = process.env.SERVICE_IT_IMAGE_TAG ?? 'latest'
const CONTAINER_PORT = Number(process.env.SERVICE_IT_PORT ?? '5678')
const DURATION_SECONDS = Number(process.env.SERVICE_IT_DURATION ?? '600')
const TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 5_000
const POLL_BUDGET_MS = Number(process.env.SERVICE_IT_POLL_BUDGET_MS ?? '600000')

const describeOrSkip = ENABLED ? describe : describe.skip

describeOrSkip('service-on-demand lifecycle (opt-in, spends escrow)', function () {
  this.timeout(POLL_BUDGET_MS + 120_000)

  const nodeClient = new NodeClient()
  const node = parseNodeTarget(NODE_ID, MULTIADDRESS ? [MULTIADDRESS] : undefined)
  let env: ComputeEnvironment
  let status: NodeStatus
  let serviceId: string

  async function poll(
    predicate: (job: ServiceJob) => boolean,
    label: string
  ): Promise<ServiceJob> {
    const deadline = Date.now() + POLL_BUDGET_MS
    let last: ServiceJob | undefined
    while (Date.now() < deadline) {
      const jobs = await nodeClient.getServiceStatus(
        node,
        AUTH_TOKEN!,
        TIMEOUT_MS,
        serviceId
      )
      last = jobs.find((j) => j.serviceId === serviceId)
      if (last) {
        // eslint-disable-next-line no-console
        console.log(
          `  ${serviceId}: ${serviceStatusLabel(last.status, last.statusText)} (${last.status})`
        )
        if (predicate(last)) return last
        // A terminal failure will never satisfy the predicate — fail fast with the reason.
        if (isServiceTerminal(last.status) && last.status !== 40) {
          throw new Error(
            `service ${serviceId} ended at ${serviceStatusLabel(last.status, last.statusText)} ` +
              `(${last.status}) while waiting for ${label}`
          )
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    throw new Error(
      `timed out waiting for ${label}; last status ${last?.status ?? 'unknown'}`
    )
  }

  before(async () => {
    await ProviderInstance.setupP2P(
      process.env.SERVICE_IT_BOOTSTRAP
        ? { bootstrapPeers: [process.env.SERVICE_IT_BOOTSTRAP] }
        : {}
    )
    status = await nodeClient.status<NodeStatus>(node, TIMEOUT_MS)
    const envs = await nodeClient.getComputeEnvironments<ComputeEnvironment[]>(
      node,
      TIMEOUT_MS
    )
    const eligible = (envs ?? []).find(
      (e) =>
        e.features?.services !== false &&
        (e.fees?.[String(CHAIN_ID)] ?? []).some(
          (f) => f.feeToken.toLowerCase() === FEE_TOKEN!.toLowerCase()
        )
    )
    expect(
      eligible,
      `no service-capable env priced in ${FEE_TOKEN} on chain ${CHAIN_ID}`
    ).to.not.equal(undefined)
    env = eligible!
  })

  it('lists templates without treating an empty catalogue as a failure', async () => {
    const templates = await nodeClient.getServiceTemplates(node, TIMEOUT_MS, CHAIN_ID)
    expect(templates).to.be.an('array')
  })

  it('estimates a cost that produces an escrow-shaped payment', () => {
    const resources = resolveServiceResources(undefined, env)
    const estimate = estimateServiceCost(
      env,
      CHAIN_ID,
      FEE_TOKEN!,
      resources,
      DURATION_SECONDS
    )
    expect(estimate, 'env should price these resources').to.not.equal(null)
    // The node compares feeToken with ===, so we must echo its own spelling.
    expect((env.fees[String(CHAIN_ID)] ?? []).map((f) => f.feeToken)).to.include(
      estimate!.feeToken
    )

    const built = buildServicePaymentInfo({
      escrowAddressByChain: status.escrowAddress,
      payee: env.consumerAddress,
      chainId: CHAIN_ID,
      feeToken: estimate!.feeToken,
      rawAmount: toRawAmount(estimate!.costHuman, 18),
      durationSeconds: DURATION_SECONDS
    })
    if (built.escrowRequired) {
      expect(built.payment.minLockSeconds).to.be.greaterThan(DURATION_SECONDS)
    }
  })

  it('starts a service and returns immediately with a Starting record', async () => {
    const started = await nodeClient.serviceStart(
      node,
      AUTH_TOKEN!,
      {
        environment: env.id,
        image: IMAGE,
        tag: IMAGE_TAG,
        exposedPorts: [CONTAINER_PORT],
        duration: DURATION_SECONDS,
        payment: { chainId: CHAIN_ID, token: FEE_TOKEN! }
      },
      TIMEOUT_MS
    )
    expect(started).to.have.length(1)
    ;({ serviceId } = started[0])
    expect(serviceId).to.be.a('string')
    expect(serviceId.length).to.be.greaterThan(0)
    // Start is asynchronous — it must NOT already be running.
    expect(started[0].status).to.be.lessThan(40)
  })

  it('reaches Running and publishes a reachable endpoint', async () => {
    const running = await poll((job) => job.status === 40, 'Running (40)')
    expect(running.endpoints, 'endpoints assigned').to.have.length.greaterThan(0)

    const decorated = decorateServiceJob(running)
    expect(decorated.statusLabel).to.be.a('string')
    expect(decorated.expiresAtIso).to.be.a('string')

    // The endpoint host is whatever the operator configured as serviceOnDemand.nodeHost, so the
    // only meaningful check is whether it actually answers from where this test runs.
    const response = await fetch(running.endpoints[0].url, {
      signal: AbortSignal.timeout(10_000)
    })
    expect(response.status).to.be.lessThan(500)
  })

  it('reads container logs with a bounded window', async () => {
    const logs = await nodeClient.serviceLogs(
      node,
      AUTH_TOKEN!,
      serviceId,
      TIMEOUT_MS,
      '5m',
      64 * 1024
    )
    expect(logs.byteLength).to.be.a('number')
    expect(logs.text ?? logs.dataBase64).to.be.a('string')
  })

  it('appears in the node-wide listing', async () => {
    const listed = await nodeClient.getServices(node, AUTH_TOKEN!, TIMEOUT_MS)
    expect(listed.map((j) => j.serviceId)).to.include(serviceId)
  })

  it('restarts in REUSE mode on the stored spec', async () => {
    const restarted = await nodeClient.serviceRestart(
      node,
      AUTH_TOKEN!,
      serviceId,
      TIMEOUT_MS
    )
    expect(restarted).to.have.length(1)
    // Restart is asynchronous too — 45 Restarting, then back through the pipeline.
    await poll((job) => job.status === 40, 'Running (40) after restart')
  })

  it('extends the paid window', async () => {
    const before = (
      await nodeClient.getServiceStatus(node, AUTH_TOKEN!, TIMEOUT_MS, serviceId)
    ).find((j) => j.serviceId === serviceId)!
    const extended = await nodeClient.serviceExtend(
      node,
      AUTH_TOKEN!,
      serviceId,
      300,
      { chainId: CHAIN_ID, token: FEE_TOKEN! },
      TIMEOUT_MS
    )
    expect(extended).to.have.length(1)
    expect(extended[0].expiresAt).to.be.greaterThan(before.expiresAt)
  })

  it('stops the service but keeps the reservation until expiry', async () => {
    const stopped = await nodeClient.serviceStop(node, AUTH_TOKEN!, serviceId, TIMEOUT_MS)
    expect(stopped).to.have.length(1)
    // 50 Stopping is in flight, not an end state — poll through to 70.
    const final = await poll((job) => job.status === 70, 'Stopped (70)')
    // The paid window is untouched by stopping: no refund, no released capacity.
    expect(final.expiresAt).to.be.greaterThan(Date.now())
  })
})
