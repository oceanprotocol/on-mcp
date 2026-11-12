import { expect } from 'chai'

import type { DocIndex } from '../../../docs/loader.js'
import { registerResourceTools } from '../../../tools/resourcesTools.js'

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

const fakeEvmRegistry = {
  getConfiguredChainIds: (): number[] => [],
  getProvider: (): undefined => undefined
} as never

/** A docsIndex large enough that the compact catalog JSON exceeds the 40 KiB get_resource cap. */
function bigDocsIndex(n: number): DocIndex {
  return Array.from({ length: n }, (_v, i) => ({
    uri: `ocean://docs/guide/ocean-node/file-${i}-with-a-reasonably-long-path-segment.md`,
    title: `Document number ${i} with a descriptive human-readable title`,
    filePath: `/tmp/file-${i}.md`,
    content: `# Document ${i}\n\n${'body '.repeat(200)}`,
    mimeType: 'text/markdown',
    section: 'guide' as const,
    keywords: ['doc', `k${i}`]
  }))
}

function registerAndCollect(docsIndex: DocIndex) {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler)
    }
  }
  registerResourceTools({
    server: server as never,
    evmRegistry: fakeEvmRegistry,
    docsIndex
  })
  return handlers
}

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text).result
}

describe('get_resource', () => {
  it('returns the application/json docs catalog whole and parseable even when huge', async () => {
    const docsIndex = bigDocsIndex(900)
    const handlers = registerAndCollect(docsIndex)
    const res = await handlers.get('get_resource')!({ uri: 'ocean://docs/index' })

    const body = parse(res)
    expect(body.mimeType).to.equal('application/json')
    // Not truncated — the whole catalog is returned despite exceeding the 40 KiB text cap.
    expect(body).to.not.have.property('truncated')
    expect(body.byteLength as number).to.be.greaterThan(40 * 1024)
    // The returned text must be valid JSON with one row per doc.
    const catalog = JSON.parse(body.text as string)
    expect(catalog.count).to.equal(900)
    expect(catalog.docs).to.have.length(900)
    expect(catalog.docs[0]).to.have.keys(['uri', 'title', 'section'])
  })

  it('caps a large text/markdown resource and pages it with offset/nextOffset', async () => {
    // A single large markdown doc so get_resource must slice it.
    const big = `# Big\n\n${'content '.repeat(10000)}` // ~80 KB
    const docsIndex: DocIndex = [
      {
        uri: 'ocean://docs/guide/big.md',
        title: 'Big',
        filePath: '/tmp/big.md',
        content: big,
        mimeType: 'text/markdown',
        section: 'guide',
        keywords: []
      }
    ]
    const handlers = registerAndCollect(docsIndex)

    const first = parse(
      await handlers.get('get_resource')!({ uri: 'ocean://docs/guide/big.md' })
    )
    expect(first.truncated).to.equal(true)
    expect(first.nextOffset).to.be.a('number')

    const second = parse(
      await handlers.get('get_resource')!({
        uri: 'ocean://docs/guide/big.md',
        offset: first.nextOffset
      })
    )
    expect((first.text as string) + (second.text as string)).to.have.length.greaterThan(0)
    expect(first.byteLength).to.equal(second.byteLength) // same total reported
  })

  it('reports an unknown resource URI as an error', async () => {
    const handlers = registerAndCollect([])
    const res = await handlers.get('get_resource')!({ uri: 'ocean://docs/nope' })
    expect(res.isError).to.equal(true)
    expect(res.content[0].text).to.contain('Unknown resource URI')
  })
})

describe('list_resources', () => {
  it('returns built-in resources plus a single docs catalog summary, not every file', async () => {
    const handlers = registerAndCollect(bigDocsIndex(900))
    const body = parse(await handlers.get('list_resources')!({}))
    const resources = body.resources as { uri: string }[]
    const uris = resources.map((r) => r.uri)
    expect(uris).to.include('ocean://docs/index')
    expect(uris).to.include('ocean://docs/auth-signing')
    // Compact: well under the ~900 per-file entries the old listing produced.
    expect(resources.length).to.be.lessThan(30)
    expect(uris.filter((u) => u.includes('file-'))).to.have.length(0)
  })
})
