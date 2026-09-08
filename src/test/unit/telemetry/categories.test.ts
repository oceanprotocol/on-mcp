import { expect } from 'chai'

import { categoryOf, lookupCategory } from '../../../telemetry/categories.js'
import { registerTools } from '../../../tools/registerTools.js'

/**
 * Enumerates tools by driving the real `registerTools` with a stub server rather than hardcoding a
 * list. That is the whole point of this suite: a new domain file (as Service-on-Demand was) shows
 * up here automatically and fails the build until it is categorized, instead of silently emitting
 * `tool.category="unknown"` on every call.
 */
function registeredToolNames(): string[] {
  const names: string[] = []
  registerTools({
    server: {
      registerTool(name: string) {
        names.push(name)
      }
    } as never,
    nodeClient: {} as never,
    incentivesClient: {} as never,
    evmRegistry: {} as never,
    docsIndex: []
  })
  return names
}

describe('telemetry/categories', () => {
  it('maps every registered tool to a category', () => {
    const uncategorized = registeredToolNames().filter((name) => !lookupCategory(name))
    expect(
      uncategorized,
      `uncategorized tools: ${uncategorized.join(', ')}`
    ).to.deep.equal([])
  })

  it('covers the whole active tool surface', () => {
    // Guards against `registerTools` silently losing a domain — the count is the tripwire.
    expect(registeredToolNames().length).to.be.at.least(90)
  })

  it('categorizes the Service-on-Demand family', () => {
    for (const name of [
      'serviceStart',
      'serviceStatus',
      'serviceExtend',
      'serviceLogs',
      'findServiceEnvironments',
      'findServiceNodes',
      'getServiceTemplates',
      'getServices',
      'estimateServiceCost'
    ]) {
      expect(categoryOf(name), name).to.equal('services')
    }
  })

  it('routes escrow and accesslist tools to evm', () => {
    expect(categoryOf('escrow_deposit')).to.equal('evm')
    expect(categoryOf('escrow_preflight')).to.equal('evm')
    expect(categoryOf('accesslist_mint')).to.equal('evm')
  })

  it('categorizes a new tool in a known family without a code change', () => {
    // Rule-based fallback: the day someone adds `incentives_whatever`, CI should not break.
    expect(categoryOf('incentives_brand_new_tool')).to.equal('incentives')
    expect(categoryOf('serviceBrandNewTool')).to.equal('services')
  })

  it('reports unknown rather than throwing for an unmapped name', () => {
    expect(categoryOf('totally_unknown_tool')).to.equal('unknown')
    expect(lookupCategory('totally_unknown_tool')).to.equal(undefined)
  })
})
