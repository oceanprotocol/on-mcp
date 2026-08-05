import { expect } from 'chai'

import {
  classifyComputeJob,
  classifyServiceJob,
  inspectResult,
  payload,
  resetDedupForTest
} from '../../../telemetry/inspectResult.js'
import {
  attributeKeys,
  counterValue,
  histogramCount,
  histogramSum
} from '../../utils/hooks.js'

/** The real envelope every tool returns: a JSON *string*, not a live object. */
const envelope = (command: string, result: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify({ command, result }, null, 2) }]
})

describe('telemetry/inspectResult', () => {
  beforeEach(() => resetDedupForTest())

  describe('payload unwrapping', () => {
    it('unwraps the JSON string envelope', () => {
      expect(payload(envelope('computeStatus', { ok: true }))).to.deep.equal({ ok: true })
    })

    it('returns undefined for the plain-text error shape instead of throwing', () => {
      // `serviceTools.ts:78` returns `{ ...textContent(message), isError: true }` — no envelope.
      const plain = {
        content: [{ type: 'text', text: 'Node unreachable' }],
        isError: true
      }
      expect(() => payload(plain)).to.not.throw()
      expect(payload(plain)).to.equal(undefined)
    })

    it('returns undefined for a missing or malformed result', () => {
      expect(payload(undefined)).to.equal(undefined)
      expect(payload({})).to.equal(undefined)
      expect(payload({ content: [] })).to.equal(undefined)
    })
  })

  describe('status vocabularies are independent', () => {
    it('treats 70 and 71 as compute success', () => {
      expect(classifyComputeJob({ status: 70 })).to.equal('success')
      expect(classifyComputeJob({ status: 71 })).to.equal('success')
    })

    it('detects compute failure by statusText keyword, not a numeric range', () => {
      // The failure codes are scattered (11, 13, 32, 41, 61, 62) — a range test would be wrong.
      expect(classifyComputeJob({ status: 13, statusText: 'Job failed' })).to.equal(
        'failed'
      )
      expect(
        classifyComputeJob({ status: 32, statusText: 'Algorithm expired' })
      ).to.equal('failed')
      expect(
        classifyComputeJob({ status: 61, statusText: 'Image has vulnerabilities' })
      ).to.equal('failed')
      expect(
        classifyComputeJob({ status: 41, statusText: 'disk quota exceeded' })
      ).to.equal('failed')
    })

    it('skips a compute job that is still running', () => {
      expect(
        classifyComputeJob({ status: 30, statusText: 'Running algorithm' })
      ).to.equal(undefined)
    })

    it('treats 70 as STOPPED for a service — the opposite of compute', () => {
      // This is the collision the two-classifier design exists to prevent.
      expect(classifyServiceJob({ status: 70 })).to.equal('stopped')
      expect(classifyComputeJob({ status: 70 })).to.equal('success')
    })

    it('maps the rest of the service vocabulary', () => {
      expect(classifyServiceJob({ status: 40 })).to.equal('running')
      expect(classifyServiceJob({ status: 75 })).to.equal('expired')
      for (const failed of [12, 14, 15, 99]) {
        expect(classifyServiceJob({ status: failed }), `status ${failed}`).to.equal(
          'failed'
        )
      }
    })

    it('treats Starting, Restarting and Stopping as in flight', () => {
      // 50 Stopping is deliberately not terminal: it still holds resources.
      for (const inFlight of [10, 11, 13, 20, 30, 45, 50]) {
        expect(classifyServiceJob({ status: inFlight }), `status ${inFlight}`).to.equal(
          undefined
        )
      }
    })
  })

  describe('polling dedup', () => {
    it('counts a terminal compute job once across many polls', async () => {
      const res = envelope('computeStatus', [
        { jobId: 'job-dedup-1', status: 70, statusText: 'Job finished' }
      ])
      for (let i = 0; i < 20; i++) inspectResult('computeStatus', {}, res)

      expect(
        await counterValue('mcp.compute.jobs.observed', { 'job.status': 'success' })
      ).to.equal(1)
    })

    it('counts a terminal service once across many polls', async () => {
      const res = envelope('serviceStatus', {
        services: [{ serviceId: 'svc-dedup-1', status: 70 }]
      })
      for (let i = 0; i < 20; i++) inspectResult('serviceStatus', {}, res)

      expect(
        await counterValue('mcp.service.observed', { 'service.status': 'stopped' })
      ).to.equal(1)
    })

    it('records reaching Running and later stopping as separate milestones', async () => {
      // observed{running} / started is the start-success rate, so "came up" and "ended" must
      // both be countable for the same service.
      const beforeRunning = await counterValue('mcp.service.observed', {
        'service.status': 'running'
      })
      const beforeStopped = await counterValue('mcp.service.observed', {
        'service.status': 'stopped'
      })

      const running = envelope('serviceStatus', {
        services: [{ serviceId: 'svc-life-1', status: 40 }]
      })
      const stopped = envelope('serviceStatus', {
        services: [{ serviceId: 'svc-life-1', status: 70 }]
      })
      inspectResult('serviceStatus', {}, running)
      inspectResult('serviceStatus', {}, running)
      inspectResult('serviceStatus', {}, stopped)
      inspectResult('serviceStatus', {}, stopped)

      expect(
        await counterValue('mcp.service.observed', { 'service.status': 'running' })
      ).to.equal(beforeRunning + 1)
      expect(
        await counterValue('mcp.service.observed', { 'service.status': 'stopped' })
      ).to.equal(beforeStopped + 1)
    })

    it('skips a terminal job with no id rather than over-counting every poll', async () => {
      const before = await counterValue('mcp.compute.jobs.observed')
      const res = envelope('computeStatus', [{ status: 70, statusText: 'done' }])
      for (let i = 0; i < 5; i++) inspectResult('computeStatus', {}, res)
      expect(await counterValue('mcp.compute.jobs.observed')).to.equal(before)
    })
  })

  describe('compute and service starts', () => {
    it('records a paid compute start with its chain', async () => {
      inspectResult('computeStart', { chainId: 8453 }, envelope('computeStart', {}))
      expect(
        await counterValue('mcp.compute.jobs.started', { paid: true, 'chain.id': 8453 })
      ).to.equal(1)
    })

    it('records a free compute start with no chain', async () => {
      inspectResult('freeComputeStart', {}, envelope('freeComputeStart', {}))
      expect(await counterValue('mcp.compute.jobs.started', { paid: false })).to.equal(1)
    })

    it('does not count a failed start', async () => {
      const before = await counterValue('mcp.compute.jobs.started', { paid: true })
      inspectResult(
        'computeStart',
        { chainId: 1 },
        {
          content: [{ type: 'text', text: 'nope' }],
          isError: true
        }
      )
      expect(await counterValue('mcp.compute.jobs.started', { paid: true })).to.equal(
        before
      )
    })

    it('derives image.mode without recording the image itself', async () => {
      inspectResult(
        'serviceStart',
        { tag: 'ubuntu:22.04', chainId: 8453 },
        envelope('serviceStart', { services: [] })
      )
      inspectResult(
        'serviceStart',
        { checksum: 'sha256:secret' },
        envelope('serviceStart', { services: [] })
      )
      inspectResult(
        'serviceStart',
        { dockerfile: 'FROM ubuntu\nRUN curl secret' },
        envelope('serviceStart', { services: [] })
      )

      expect(await counterValue('mcp.service.started', { 'image.mode': 'tag' })).to.equal(
        1
      )
      expect(
        await counterValue('mcp.service.started', { 'image.mode': 'checksum' })
      ).to.equal(1)
      expect(
        await counterValue('mcp.service.started', { 'image.mode': 'dockerfile' })
      ).to.equal(1)
    })
  })

  describe('other domain hooks', () => {
    it('records docs searches by hit and miss from prose output', async () => {
      // `search_docs` returns prose, not an envelope. The query is never recorded.
      inspectResult(
        'search_docs',
        { query: 'compute' },
        {
          content: [{ type: 'text', text: 'Found 3 result(s) for "compute":\n\n…' }]
        }
      )
      inspectResult(
        'search_docs',
        { query: 'zzz' },
        {
          content: [{ type: 'text', text: 'No results found for: "zzz"' }]
        }
      )

      expect(await counterValue('mcp.docs.search', { 'result.hit': true })).to.equal(1)
      expect(await counterValue('mcp.docs.search', { 'result.hit': false })).to.equal(1)
    })

    it('records provider lookup hit and miss', async () => {
      inspectResult('find_provider', {}, envelope('find_provider', ['peer-a']))
      inspectResult('find_provider', {}, envelope('find_provider', []))

      expect(await counterValue('mcp.p2p.provider_lookup', { found: true })).to.equal(1)
      expect(await counterValue('mcp.p2p.provider_lookup', { found: false })).to.equal(1)
    })

    it('records auth token creation without the token', async () => {
      inspectResult(
        'create_auth_token',
        {},
        envelope('create_auth_token', { token: 'eyJ' })
      )
      expect(await counterValue('mcp.auth.tokens_created')).to.equal(1)
    })

    it('records the incentives family and node eligibility', async () => {
      inspectResult('incentives_list_nodes', {}, envelope('incentives_list_nodes', []))
      inspectResult('check_node_eligibility', {}, envelope('check_node_eligibility', {}))

      expect(
        await counterValue('mcp.incentives.calls', {
          'tool.name': 'incentives_list_nodes'
        })
      ).to.equal(1)
      expect(
        await counterValue('mcp.incentives.calls', {
          'tool.name': 'check_node_eligibility'
        })
      ).to.equal(1)
    })

    it('records service lifecycle actions under one bounded counter', async () => {
      for (const [name, action] of [
        ['serviceExtend', 'extend'],
        ['serviceRestart', 'restart'],
        ['serviceStop', 'stop'],
        ['serviceLogs', 'logs'],
        ['getServices', 'list']
      ] as const) {
        inspectResult(name, {}, envelope(name, {}))
        expect(await counterValue('mcp.service.lifecycle', { action })).to.equal(1)
      }
    })

    it('records cost estimates and flags the no-registry case', async () => {
      inspectResult(
        'estimateServiceCost',
        { chainId: 8453 },
        envelope('estimateServiceCost', { costHuman: 1.5 })
      )
      inspectResult(
        'estimateServiceCost',
        {},
        {
          content: [{ type: 'text', text: 'no registry' }],
          isError: true
        }
      )

      expect(
        await counterValue('mcp.service.cost_estimates', { estimated: true })
      ).to.equal(1)
      expect(
        await counterValue('mcp.service.cost_estimates', { estimated: false })
      ).to.equal(1)
    })
  })

  describe('asset consumption', () => {
    it('tracks the order_asset state machine by funnel status', async () => {
      // The tool is multi-step: it returns a step, the caller signs and broadcasts, then calls
      // back. `status` gives drop-off INSIDE one tool — how many flows reach `complete`.
      for (const status of ['needs_broadcast', 'waiting', 'complete']) {
        inspectResult(
          'order_asset',
          { chainId: 8453 },
          envelope('order_asset', { status })
        )
      }

      expect(
        await counterValue('mcp.asset.order', { status: 'needs_broadcast' })
      ).to.equal(1)
      expect(await counterValue('mcp.asset.order', { status: 'waiting' })).to.equal(1)
      expect(
        await counterValue('mcp.asset.order', { status: 'complete', 'chain.id': 8453 })
      ).to.equal(1)
    })

    it('records the order revert path as an error, not a stalled step', async () => {
      // `order_asset` THROWS on an on-chain revert, so the wrapper surfaces isError.
      inspectResult(
        'order_asset',
        { chainId: 1 },
        {
          content: [{ type: 'text', text: 'Transaction 0xabc reverted on-chain.' }],
          isError: true
        }
      )
      expect(await counterValue('mcp.asset.order', { status: 'error' })).to.equal(1)
    })

    it('bounds an unexpected status rather than passing it through', async () => {
      inspectResult('order_asset', {}, envelope('order_asset', { status: 12345 }))
      expect(await counterValue('mcp.asset.order', { status: 'unknown' })).to.equal(1)
    })

    it('records downloads and fee quotes', async () => {
      inspectResult('download_asset_file', {}, envelope('download_asset_file', {}))
      inspectResult('get_download_fees', {}, envelope('get_download_fees', {}))
      inspectResult(
        'download_asset_file',
        {},
        {
          content: [{ type: 'text', text: 'nope' }],
          isError: true
        }
      )

      expect(await counterValue('mcp.asset.downloads', { status: 'ok' })).to.equal(1)
      expect(await counterValue('mcp.asset.downloads', { status: 'error' })).to.equal(1)
      expect(await counterValue('mcp.asset.fee_quotes', { status: 'ok' })).to.equal(1)
    })
  })

  describe('DDO resolution', () => {
    it('records hit and miss per operation without the DID', async () => {
      inspectResult(
        'resolveDdo',
        { did: 'did:op:secret' },
        envelope('resolveDdo', { id: 'x' })
      )
      inspectResult('validateDdo', {}, envelope('validateDdo', { valid: true }))
      inspectResult('check_did_files', {}, envelope('check_did_files', {}))
      inspectResult(
        'resolveDdo',
        { did: 'did:op:secret' },
        {
          content: [{ type: 'text', text: 'DDO not found' }],
          isError: true
        }
      )

      expect(
        await counterValue('mcp.ddo.resolve', { operation: 'resolve', found: true })
      ).to.equal(1)
      expect(
        await counterValue('mcp.ddo.resolve', { operation: 'resolve', found: false })
      ).to.equal(1)
      expect(
        await counterValue('mcp.ddo.resolve', { operation: 'validate', found: true })
      ).to.equal(1)
      expect(
        await counterValue('mcp.ddo.resolve', { operation: 'check_files', found: true })
      ).to.equal(1)
    })
  })

  describe('persistent storage', () => {
    it('records every storage action under one bounded counter', async () => {
      for (const [name, action] of [
        ['createPersistentStorageBucket', 'create_bucket'],
        ['getPersistentStorageBuckets', 'list_buckets'],
        ['listPersistentStorageFiles', 'list_files'],
        ['getPersistentStorageFileObject', 'get_object'],
        ['deletePersistentStorageFile', 'delete_file'],
        ['upload_persistent_storage_file', 'upload']
      ] as const) {
        inspectResult(name, {}, envelope(name, {}))
        expect(
          await counterValue('mcp.storage.operations', { action, status: 'ok' }),
          name
        ).to.equal(1)
      }
    })
  })

  describe('escrow transaction builds', () => {
    it('counts intent to move funds, by action', async () => {
      // These tools build an UNSIGNED tx and never broadcast — this is intent, not settlement.
      for (const action of ['deposit', 'withdraw', 'authorize']) {
        inspectResult(`escrow_${action}`, {}, envelope(`escrow_${action}`, { tx: {} }))
        expect(
          await counterValue('mcp.escrow.tx_built', { action, status: 'ok' })
        ).to.equal(1)
      }
    })

    it('never records an amount', async () => {
      inspectResult(
        'escrow_deposit',
        { amount: '123456789000000000000' },
        envelope('escrow_deposit', { amount: '123456789000000000000', tx: {} })
      )
      const keys = await attributeKeys('mcp.escrow.tx_built')
      expect(keys.sort()).to.deep.equal(['action', 'status'])
    })
  })

  describe('duration and poll depth', () => {
    it('records compute poll depth and duration once, on the terminal poll', async () => {
      const beforePolls = await histogramCount('mcp.compute.job.polls', {
        'job.status': 'success'
      })
      const beforeSum = await histogramSum('mcp.compute.job.polls', {
        'job.status': 'success'
      })
      const beforeDuration = await histogramCount('mcp.compute.job.observed_duration', {
        'job.status': 'success'
      })

      const running = envelope('computeStatus', [
        { jobId: 'job-poll-1', status: 30, statusText: 'Running algorithm' }
      ])
      const done = envelope('computeStatus', [
        { jobId: 'job-poll-1', status: 70, statusText: 'Job finished' }
      ])

      // Four in-flight polls, then the terminal one → 5 polls total.
      for (let i = 0; i < 4; i++) inspectResult('computeStatus', {}, running)
      inspectResult('computeStatus', {}, done)
      inspectResult('computeStatus', {}, done)

      expect(
        await histogramCount('mcp.compute.job.polls', { 'job.status': 'success' })
      ).to.equal(beforePolls + 1)
      expect(
        await histogramSum('mcp.compute.job.polls', { 'job.status': 'success' })
      ).to.equal(beforeSum + 5)
      expect(
        await histogramCount('mcp.compute.job.observed_duration', {
          'job.status': 'success'
        })
      ).to.equal(beforeDuration + 1)
    })

    it('records service time-to-running separately from total duration', async () => {
      const starting = envelope('serviceStatus', {
        services: [{ serviceId: 'svc-poll-1', status: 10 }]
      })
      const running = envelope('serviceStatus', {
        services: [{ serviceId: 'svc-poll-1', status: 40 }]
      })
      const stopped = envelope('serviceStatus', {
        services: [{ serviceId: 'svc-poll-1', status: 70 }]
      })

      const beforeRunning = await histogramCount('mcp.service.time_to_running')
      const beforeStopped = await histogramCount('mcp.service.observed_duration', {
        'service.status': 'stopped'
      })
      const beforeRunPolls = await histogramSum('mcp.service.polls', {
        'service.status': 'running'
      })
      const beforeStopPolls = await histogramSum('mcp.service.polls', {
        'service.status': 'stopped'
      })

      inspectResult('serviceStatus', {}, starting)
      inspectResult('serviceStatus', {}, starting)
      inspectResult('serviceStatus', {}, running)
      inspectResult('serviceStatus', {}, running)
      inspectResult('serviceStatus', {}, stopped)

      // time_to_running is the slow part of a start: escrow lock + image pull + scan.
      expect(await histogramCount('mcp.service.time_to_running')).to.equal(
        beforeRunning + 1
      )
      expect(
        await histogramCount('mcp.service.observed_duration', {
          'service.status': 'stopped'
        })
      ).to.equal(beforeStopped + 1)
      // Poll depth is recorded at each milestone: 3 polls to Running, 5 to Stopped.
      expect(
        await histogramSum('mcp.service.polls', { 'service.status': 'running' })
      ).to.equal(beforeRunPolls + 3)
      expect(
        await histogramSum('mcp.service.polls', { 'service.status': 'stopped' })
      ).to.equal(beforeStopPolls + 5)
    })

    it('counts in-flight polls even though they emit no outcome', async () => {
      const inFlight = envelope('computeStatus', [
        { jobId: 'job-inflight', status: 30, statusText: 'Running' }
      ])
      const before = await histogramCount('mcp.compute.job.polls')
      const beforeSum = await histogramSum('mcp.compute.job.polls', {
        'job.status': 'success'
      })
      for (let i = 0; i < 10; i++) inspectResult('computeStatus', {}, inFlight)
      // Nothing terminal yet → nothing recorded, but the polls are being counted.
      expect(await histogramCount('mcp.compute.job.polls')).to.equal(before)

      inspectResult(
        'computeStatus',
        {},
        envelope('computeStatus', [
          { jobId: 'job-inflight', status: 71, statusText: 'done' }
        ])
      )
      expect(
        await histogramSum('mcp.compute.job.polls', { 'job.status': 'success' })
      ).to.equal(beforeSum + 11)
    })
  })

  it('never throws on a malformed payload', () => {
    const junk = [
      undefined,
      null,
      {},
      { content: 'not-an-array' },
      { content: [{ text: '{"result":' }] },
      envelope('serviceStatus', { services: 'not-an-array' }),
      envelope('computeStatus', null)
    ]
    for (const res of junk) {
      expect(
        () => inspectResult('serviceStatus', {}, res),
        JSON.stringify(res)
      ).to.not.throw()
      expect(() => inspectResult('computeStatus', {}, res)).to.not.throw()
    }
  })

  it('ignores tools with no domain hook', () => {
    expect(() =>
      inspectResult('get_balance', { chainId: 1 }, envelope('get_balance', '0'))
    ).to.not.throw()
  })
})
