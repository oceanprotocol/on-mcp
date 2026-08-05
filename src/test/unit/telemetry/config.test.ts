import { expect } from 'chai'

import { loadTelemetryConfig, parseTrustProxy } from '../../../telemetry/config.js'

const SSE_ENV = {
  MCP_TRANSPORT: 'sse',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318'
} as NodeJS.ProcessEnv

describe('telemetry/config', () => {
  it('enables telemetry for SSE with an endpoint', () => {
    const config = loadTelemetryConfig(SSE_ENV)
    expect(config.enabled).to.equal(true)
    expect(config.disabledReason).to.equal(undefined)
  })

  it('is off for stdio even with an endpoint configured', () => {
    // The scope decision is SSE-only: stdio owns stdout as its JSON-RPC channel.
    const config = loadTelemetryConfig({ ...SSE_ENV, MCP_TRANSPORT: 'stdio' })
    expect(config.enabled).to.equal(false)
    expect(config.disabledReason).to.contain('SSE-only')
  })

  it('defaults to stdio (and therefore off) when MCP_TRANSPORT is unset', () => {
    const config = loadTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318'
    } as NodeJS.ProcessEnv)
    expect(config.enabled).to.equal(false)
  })

  it('is off without an endpoint — the safe default', () => {
    const config = loadTelemetryConfig({ MCP_TRANSPORT: 'sse' } as NodeJS.ProcessEnv)
    expect(config.enabled).to.equal(false)
    expect(config.disabledReason).to.contain('OTEL_EXPORTER_OTLP_ENDPOINT')
  })

  it('honours a hard off switch', () => {
    const config = loadTelemetryConfig({ ...SSE_ENV, MCP_TELEMETRY_ENABLED: 'false' })
    expect(config.enabled).to.equal(false)
    expect(config.disabledReason).to.contain('MCP_TELEMETRY_ENABLED')
  })

  it('excludes the source port from user ids by default', () => {
    expect(loadTelemetryConfig(SSE_ENV).includePortInUserId).to.equal(false)
    expect(
      loadTelemetryConfig({ ...SSE_ENV, MCP_TELEMETRY_USER_ID_INCLUDE_PORT: '1' })
        .includePortInUserId
    ).to.equal(true)
  })

  describe('TRUST_PROXY', () => {
    it('defaults to loopback', () => {
      expect(loadTelemetryConfig(SSE_ENV).trustProxy).to.equal('loopback')
      expect(parseTrustProxy(undefined)).to.equal('loopback')
    })

    it('coerces a hop count to a NUMBER, not an IP literal', () => {
      // Express dispatches on runtime type. Left as the string "1", proxy-addr parses it as an IP
      // address, it never matches, and X-Forwarded-For is silently ignored — collapsing every
      // client onto the proxy's address and breaking the unique-user estimate.
      expect(parseTrustProxy('1')).to.equal(1)
      expect(parseTrustProxy('2')).to.equal(2)
      expect(loadTelemetryConfig({ ...SSE_ENV, TRUST_PROXY: '1' }).trustProxy).to.equal(1)
    })

    it('coerces true/false to booleans instead of throwing', () => {
      // Left as the string "true", proxy-addr throws `invalid IP address: true`, which would take
      // down SSE startup.
      expect(parseTrustProxy('true')).to.equal(true)
      expect(parseTrustProxy('TRUE')).to.equal(true)
      expect(parseTrustProxy('false')).to.equal(false)
    })

    it('passes named presets, addresses and CIDR lists through untouched', () => {
      expect(parseTrustProxy('loopback')).to.equal('loopback')
      expect(parseTrustProxy('uniquelocal')).to.equal('uniquelocal')
      expect(parseTrustProxy('linklocal')).to.equal('linklocal')
      expect(parseTrustProxy('10.0.0.0/8')).to.equal('10.0.0.0/8')
      expect(parseTrustProxy('loopback, 10.0.0.0/8')).to.equal('loopback, 10.0.0.0/8')
    })

    it('falls back rather than passing a value proxy-addr would reject', () => {
      // An empty or whitespace-only value also throws `invalid IP address:` inside proxy-addr.
      expect(parseTrustProxy('')).to.equal('loopback')
      expect(parseTrustProxy('   ')).to.equal('loopback')
    })

    it('does not treat a negative or fractional hop count as a number', () => {
      // proxy-addr would trust nothing for these. Leaving them as strings surfaces the mistake as
      // a loud startup error instead of silently disabling XFF.
      expect(parseTrustProxy('-1')).to.equal('-1')
      expect(parseTrustProxy('1.5')).to.equal('1.5')
    })
  })
})
