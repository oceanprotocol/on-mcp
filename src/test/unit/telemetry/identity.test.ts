import { expect } from 'chai'
import { createHash } from 'node:crypto'

import { loadTelemetryConfig } from '../../../telemetry/config.js'
import {
  deriveUserId,
  extractClientIp,
  sanitizeClient,
  sanitizeClientName,
  sanitizeClientVersion
} from '../../../telemetry/identity.js'

describe('telemetry/identity', () => {
  describe('deriveUserId', () => {
    it('is stable for the same (ip, client)', () => {
      const a = deriveUserId('203.0.113.7', 'claude-desktop')
      const b = deriveUserId('203.0.113.7', 'claude-desktop')
      expect(a).to.be.a('string')
      expect(a).to.equal(b)
    })

    it('separates users behind one NAT by client', () => {
      expect(deriveUserId('203.0.113.7', 'claude-desktop')).to.not.equal(
        deriveUserId('203.0.113.7', 'cursor')
      )
    })

    it('separates different IPs', () => {
      expect(deriveUserId('203.0.113.7', 'cursor')).to.not.equal(
        deriveUserId('203.0.113.8', 'cursor')
      )
    })

    it('never contains the raw IP', () => {
      const id = deriveUserId('203.0.113.7', 'cursor')
      expect(id).to.not.contain('203')
      expect(id).to.not.contain('113')
      expect(id).to.match(/^[0-9a-f]{16}$/)
    })

    it('returns undefined without an IP rather than hashing a constant', () => {
      // Hashing `undefined` would collapse every unknown-IP client onto one shared id and
      // silently under-report — better to contribute nothing to the sketch.
      expect(deriveUserId(undefined, 'cursor')).to.equal(undefined)
    })
  })

  describe('stability without configuration', () => {
    it('produces the same id in a fresh process with no telemetry env set', () => {
      // The hash is unsalted precisely so identity survives restarts and replicas with nothing to
      // provision. This asserts the property that replaces the old stable-salt requirement:
      // a known input maps to a fixed, checked-in digest.
      const expected = createHash('sha256')
        .update(['198.51.100.9', 'cursor'].join('|'))
        .digest('hex')
        .slice(0, 16)

      expect(deriveUserId('198.51.100.9', 'cursor')).to.equal(expected)
    })

    it('ignores the source port unless the opt-in is set', () => {
      // Default is off: a port would make this a connection id, not a user id. The enabled branch
      // is covered by config.test.ts (`includePortInUserId`) — `deriveUserId` reads the memoized
      // process config, so it cannot be flipped per-call here.
      const withoutPort = deriveUserId('198.51.100.9', 'cursor')
      expect(deriveUserId('198.51.100.9', 'cursor', 54321)).to.equal(withoutPort)
      expect(loadTelemetryConfig({} as NodeJS.ProcessEnv).includePortInUserId).to.equal(
        false
      )
      expect(
        loadTelemetryConfig({
          MCP_TELEMETRY_USER_ID_INCLUDE_PORT: '1'
        } as NodeJS.ProcessEnv).includePortInUserId
      ).to.equal(true)
    })
  })

  describe('client sanitization', () => {
    it('maps known clients onto the allowlist', () => {
      expect(sanitizeClientName('Claude Desktop')).to.equal('claude-desktop')
      expect(sanitizeClientName('cursor-vscode')).to.equal('cursor')
      expect(sanitizeClientName('mcp-inspector')).to.equal('mcp-inspector')
    })

    it('buckets an unknown client as other', () => {
      expect(sanitizeClientName('SomeRandomAgent')).to.equal('other')
    })

    it('does not let a very short name match a known client by substring', () => {
      // Reverse containment is length-gated: 'claude-desktop'.includes('c') is true, so without the
      // floor a client calling itself "c" would be reported as Claude Desktop.
      expect(sanitizeClientName('c')).to.equal('other')
      expect(sanitizeClientName('cu')).to.equal('other')
      expect(sanitizeClientName('ze')).to.equal('other')
      // Long enough to be meaningful, and a genuine prefix of an allowlist entry.
      expect(sanitizeClientName('curs')).to.equal('cursor')
      // An exact allowlist entry still matches regardless of length.
      expect(sanitizeClientName('zed')).to.equal('zed')
    })

    it('bounds a hostile client name instead of passing it through as a label', () => {
      // `clientInfo` is client-controlled free text; unbounded values are the one genuine
      // cardinality risk in the metric set.
      const hostile = 'x'.repeat(5000)
      const label = sanitizeClientName(hostile)
      expect(label).to.equal('other')
      expect(label.length).to.be.at.most(64)
    })

    it('keeps only a semver-ish version prefix', () => {
      expect(sanitizeClientVersion('1.2.3')).to.equal('1.2.3')
      expect(sanitizeClientVersion('v2.0')).to.equal('2.0')
      expect(sanitizeClientVersion('build-from-git-abc123')).to.equal('other')
      expect(sanitizeClientVersion(undefined)).to.equal('unknown')
    })

    it('reports unknown for a missing client name', () => {
      expect(sanitizeClient(undefined, undefined)).to.deep.equal({
        clientName: 'unknown',
        clientVersion: 'unknown'
      })
    })
  })

  describe('extractClientIp', () => {
    it('prefers req.ip (which honours the trust-proxy setting)', () => {
      const req = { ip: '198.51.100.4', socket: { remoteAddress: '10.0.0.1' } }
      expect(extractClientIp(req as never)).to.equal('198.51.100.4')
    })

    it('falls back to the socket address', () => {
      const req = { socket: { remoteAddress: '10.0.0.1' } }
      expect(extractClientIp(req as never)).to.equal('10.0.0.1')
    })

    it('normalizes IPv4-mapped IPv6 so one client hashes consistently', () => {
      const req = { ip: '::ffff:203.0.113.7' }
      expect(extractClientIp(req as never)).to.equal('203.0.113.7')
    })

    it('returns undefined when there is no address at all', () => {
      expect(extractClientIp({} as never)).to.equal(undefined)
    })
  })
})
