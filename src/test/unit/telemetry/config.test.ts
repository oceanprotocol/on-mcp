import { expect } from 'chai'

import {
  loadTelemetryConfig,
  parseTrustProxy,
  readPositiveInt
} from '../../../telemetry/config.js'

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

  it('does NOT enable on a single signal-specific endpoint', () => {
    // Both signals are always exported, and each OTel exporter resolves its endpoint independently,
    // silently defaulting to http://localhost:4318. Enabling on one would report "enabled" while
    // shipping the other signal into a localhost void.
    const metricsOnly = loadTelemetryConfig({
      MCP_TRANSPORT: 'sse',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://collector:4318/v1/metrics'
    } as NodeJS.ProcessEnv)
    expect(metricsOnly.enabled).to.equal(false)
    expect(metricsOnly.disabledBy).to.equal('endpoint')

    const tracesOnly = loadTelemetryConfig({
      MCP_TRANSPORT: 'sse',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces'
    } as NodeJS.ProcessEnv)
    expect(tracesOnly.enabled).to.equal(false)
    expect(tracesOnly.disabledBy).to.equal('endpoint')
  })

  it('enables on both signal endpoints together', () => {
    const config = loadTelemetryConfig({
      MCP_TRANSPORT: 'sse',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://collector:4318/v1/metrics'
    } as NodeJS.ProcessEnv)
    expect(config.enabled).to.equal(true)
    expect(config.endpoint).to.contain('traces')
    expect(config.endpoint).to.contain('metrics')
  })

  it('names both routes to enablement when no endpoint is set', () => {
    const config = loadTelemetryConfig({ MCP_TRANSPORT: 'sse' } as NodeJS.ProcessEnv)
    expect(config.disabledReason).to.contain('OTEL_EXPORTER_OTLP_ENDPOINT')
    expect(config.disabledReason).to.contain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')
  })

  it('honours every hard off switch spelling', () => {
    for (const value of ['false', 'off', '0']) {
      const config = loadTelemetryConfig({ ...SSE_ENV, MCP_TELEMETRY_ENABLED: value })
      expect(config.enabled, value).to.equal(false)
      expect(config.disabledBy, value).to.equal('switch')
      expect(config.disabledReason, value).to.contain('MCP_TELEMETRY_ENABLED')
    }
  })

  it('tags why telemetry is off so callers need not match on message text', () => {
    expect(
      loadTelemetryConfig({ ...SSE_ENV, MCP_TRANSPORT: 'stdio' }).disabledBy
    ).to.equal('transport')
    expect(
      loadTelemetryConfig({ MCP_TRANSPORT: 'sse' } as NodeJS.ProcessEnv).disabledBy
    ).to.equal('endpoint')
    expect(loadTelemetryConfig(SSE_ENV).disabledBy).to.equal(undefined)
  })

  it('is unsalted by default and accepts an opt-in salt', () => {
    expect(loadTelemetryConfig(SSE_ENV).userIdSalt).to.equal(undefined)
    // Whitespace-only must not count as configured, or it would look enabled while changing nothing.
    expect(
      loadTelemetryConfig({ ...SSE_ENV, MCP_TELEMETRY_USER_ID_SALT: '   ' }).userIdSalt
    ).to.equal(undefined)
    expect(
      loadTelemetryConfig({ ...SSE_ENV, MCP_TELEMETRY_USER_ID_SALT: 'abc123' }).userIdSalt
    ).to.equal('abc123')
  })

  describe('readPositiveInt', () => {
    it('rejects the values Number() would silently mangle', () => {
      // `Number('')` is 0 and `Number('abc')` is NaN — both reach an OTel interval as a busy loop
      // or an immediate throw.
      expect(readPositiveInt(undefined, 30_000)).to.equal(30_000)
      expect(readPositiveInt('', 30_000)).to.equal(30_000)
      expect(readPositiveInt('   ', 30_000)).to.equal(30_000)
      expect(readPositiveInt('abc', 30_000)).to.equal(30_000)
      expect(readPositiveInt('0', 30_000)).to.equal(30_000)
      expect(readPositiveInt('-5', 30_000)).to.equal(30_000)
    })

    it('rejects a decimal — 0.1 is finite and positive but means a 0.1ms busy loop', () => {
      expect(readPositiveInt('0.1', 30_000)).to.equal(30_000)
      expect(readPositiveInt('1.5', 30_000)).to.equal(30_000)
      expect(readPositiveInt('5000.9', 30_000)).to.equal(30_000)
      expect(readPositiveInt('1e-3', 30_000)).to.equal(30_000)
    })

    it('accepts a positive integer, including exponent notation', () => {
      expect(readPositiveInt('5000', 30_000)).to.equal(5000)
      expect(readPositiveInt('1e4', 30_000)).to.equal(10_000)
    })
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
