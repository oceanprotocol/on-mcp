import { expect } from 'chai'

import { IncentivesClient } from '../../../clients/incentivesClient.js'

describe('IncentivesClient', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(response: Response) {
    const calls: Array<[URL, Parameters<typeof fetch>[1]]> = []

    globalThis.fetch = ((
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const url = input instanceof URL ? input : new URL(String(input))
      calls.push([url, init])
      return Promise.resolve(response)
    }) as typeof fetch

    return calls
  }

  it('serializes nested query params for listNodes', async () => {
    const calls = mockFetch(
      new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      })
    )

    const client = new IncentivesClient('https://api.oncompute.ai')

    await client.listNodes({
      nodeId: 'node-1',
      page: 2,
      size: 25,
      search: 'gpu',
      useScroll: true,
      filters: {
        id: { contains: 'node-1' },
        eligible: { contains: true }
      },
      sort: {
        friendlyName: 'asc'
      }
    })

    expect(calls).to.have.length(1)

    const [url, init] = calls[0]

    expect(url.origin + url.pathname).to.equal('https://api.oncompute.ai/nodes')
    expect(url.searchParams.get('nodeId')).to.equal('node-1')
    expect(url.searchParams.get('page')).to.equal('2')
    expect(url.searchParams.get('size')).to.equal('25')
    expect(url.searchParams.get('search')).to.equal('gpu')
    expect(url.searchParams.get('useScroll')).to.equal('true')
    expect(url.searchParams.get('sort')).to.equal('{"friendlyName":"asc"}')
    expect(url.search).to.include('filters%5Bid%5D%5Bcontains%5D=node-1')
    expect(url.search).to.include('filters%5Beligible%5D%5Bcontains%5D=true')
    expect(init.method).to.equal('GET')
  })

  it('sends JSON bodies for requestUnban', async () => {
    const calls = mockFetch(
      new Response(JSON.stringify({ success: true }), {
        status: 202,
        headers: {
          'content-type': 'application/json'
        }
      })
    )

    const client = new IncentivesClient('https://api.oncompute.ai')

    await client.requestUnban('node-1', {
      signature: '0xsigned',
      expiryTimestamp: 1_717_171_717_000,
      address: '0xabc123'
    })

    expect(calls).to.have.length(1)

    const [url, init] = calls[0]

    expect(url.origin + url.pathname).to.equal(
      'https://api.oncompute.ai/nodes/node-1/unban'
    )
    expect(init.method).to.equal('POST')
    expect(init.headers).to.deep.equal({
      'content-type': 'application/json'
    })
    expect(JSON.parse(String(init.body))).to.deep.equal({
      signature: '0xsigned',
      expiryTimestamp: 1_717_171_717_000,
      address: '0xabc123'
    })
  })

  it('includes API error details in thrown errors', async () => {
    mockFetch(
      new Response(JSON.stringify({ message: 'Queue unavailable' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {
          'content-type': 'application/json'
        }
      })
    )

    const client = new IncentivesClient('https://api.oncompute.ai')

    let caught: Error | undefined
    try {
      await client.getNodeSystemStats()
    } catch (error) {
      caught = error as Error
    }

    expect(caught).to.be.instanceOf(Error)
    expect(caught?.message).to.include('503 Service Unavailable')
    expect(caught?.message).to.include('Queue unavailable')
  })
})
