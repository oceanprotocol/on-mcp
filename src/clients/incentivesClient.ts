type JsonObject = Record<string, unknown>
type SortDirection = 'asc' | 'desc'

type ListQueryInput = {
  page?: number
  size?: number
  search?: string
  useScroll?: boolean
  filters?: JsonObject
  sort?: Record<string, SortDirection>
}

type NodesQueryInput = ListQueryInput & {
  nodeId?: string
}

type PaginationInput = {
  page?: number
  size?: number
}

type UnbanRequestInput = {
  signature: string
  expiryTimestamp: number
  address: string
}

const DEFAULT_BASE_URL = 'https://api.oncompute.ai'
const DEFAULT_TIMEOUT_MS = 20_000

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function appendNestedQuery(
  params: URLSearchParams,
  prefix: string,
  value: unknown
): void {
  if (value === undefined || value === null) return

  if (Array.isArray(value)) {
    for (const item of value) {
      appendNestedQuery(params, `${prefix}[]`, item)
    }
    return
  }

  if (isJsonObject(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      appendNestedQuery(params, `${prefix}[${key}]`, nestedValue)
    }
    return
  }

  params.append(prefix, String(value))
}

function parseErrorDetail(responseText: string, statusText: string): string {
  if (!responseText.trim()) return statusText || 'Request failed'

  try {
    const parsed = JSON.parse(responseText) as unknown
    if (isJsonObject(parsed) && typeof parsed.message === 'string') {
      return parsed.message
    }
    return JSON.stringify(parsed)
  } catch {
    return responseText
  }
}

export class IncentivesClient {
  readonly baseUrl: string

  constructor(baseUrl = process.env.INCENTIVES_API_BASE_URL ?? DEFAULT_BASE_URL) {
    const normalized = baseUrl.trim()
    if (!normalized) {
      throw new Error('INCENTIVES_API_BASE_URL must not be empty')
    }

    this.baseUrl = normalized.endsWith('/') ? normalized : `${normalized}/`
  }

  listNodes(params: NodesQueryInput = {}) {
    return this.request('GET', '/nodes', {
      query: this.buildNodesQuery(params)
    })
  }

  runQuery(query: JsonObject) {
    return this.request('POST', '/query', {
      body: { query }
    })
  }

  getNodeSystemStats() {
    return this.request('GET', '/nodeSystemStats')
  }

  getNodeBenchmarkHistory(nodeId: string, params: ListQueryInput = {}) {
    return this.request('GET', `/nodes/${encodeURIComponent(nodeId)}/benchmarkHistory`, {
      query: this.buildJsonListQuery(params)
    })
  }

  getBanStatus(nodeId: string) {
    return this.request('GET', `/nodes/${encodeURIComponent(nodeId)}/banStatus`)
  }

  requestUnban(nodeId: string, body: UnbanRequestInput) {
    return this.request('POST', `/nodes/${encodeURIComponent(nodeId)}/unban`, {
      body
    })
  }

  listUnbanRequests(nodeId: string, params: PaginationInput = {}) {
    const query = new URLSearchParams()
    if (params.page !== undefined) query.set('page', String(params.page))
    if (params.size !== undefined) query.set('size', String(params.size))

    return this.request('GET', `/nodes/${encodeURIComponent(nodeId)}/unbanRequests`, {
      query
    })
  }

  getNodeBenchmark(nodeId: string) {
    return this.request('GET', `/nodes/${encodeURIComponent(nodeId)}/benchmark`)
  }

  listOwnerComputeJobs(owner: string, params: ListQueryInput = {}) {
    return this.request('GET', `/owners/${encodeURIComponent(owner)}/computeJobs`, {
      query: this.buildJsonListQuery(params)
    })
  }

  getOwnerEnvInfo(owner: string) {
    return this.request('GET', `/owners/${encodeURIComponent(owner)}/envInfo`)
  }

  getOwnerNodesStats(owner: string) {
    return this.request('GET', `/owners/${encodeURIComponent(owner)}/nodesStats`)
  }

  getConsumerJobsSuccessRate(consumer: string) {
    return this.request(
      'GET',
      `/consumers/${encodeURIComponent(consumer)}/jobs-success-rate`
    )
  }

  listAdminNodes(admin: string, params: ListQueryInput = {}) {
    return this.request('GET', `/admin/${encodeURIComponent(admin)}/myNodes`, {
      query: this.buildJsonListQuery(params)
    })
  }

  listEnvs(params: Omit<ListQueryInput, 'search'> = {}) {
    return this.request('GET', '/envs', {
      query: this.buildJsonListQuery(params)
    })
  }

  private buildJsonListQuery(params: Partial<ListQueryInput>): URLSearchParams {
    const query = new URLSearchParams()

    if (params.page !== undefined) query.set('page', String(params.page))
    if (params.size !== undefined) query.set('size', String(params.size))
    if (params.search !== undefined) query.set('search', params.search)
    if (params.useScroll !== undefined) {
      query.set('useScroll', String(params.useScroll))
    }
    if (params.filters !== undefined) {
      query.set('filters', JSON.stringify(params.filters))
    }
    if (params.sort !== undefined) {
      query.set('sort', JSON.stringify(params.sort))
    }

    return query
  }

  private buildNodesQuery(params: NodesQueryInput): URLSearchParams {
    const query = new URLSearchParams()

    if (params.nodeId !== undefined) query.set('nodeId', params.nodeId)
    if (params.page !== undefined) query.set('page', String(params.page))
    if (params.size !== undefined) query.set('size', String(params.size))
    if (params.search !== undefined) query.set('search', params.search)
    if (params.useScroll !== undefined) {
      query.set('useScroll', String(params.useScroll))
    }
    if (params.filters !== undefined) {
      appendNestedQuery(query, 'filters', params.filters)
    }
    if (params.sort !== undefined) {
      query.set('sort', JSON.stringify(params.sort))
    }

    return query
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    options: {
      query?: URLSearchParams
      body?: unknown
    } = {}
  ): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ''), this.baseUrl)
    if (options.query && options.query.size > 0) {
      url.search = options.query.toString()
    }

    const init: NonNullable<Parameters<typeof fetch>[1]> = {
      method,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    }

    if (options.body !== undefined) {
      init.headers = {
        'content-type': 'application/json'
      }
      init.body = JSON.stringify(options.body)
    }

    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      throw new Error(`Incentives API ${method} ${path} request failed: ${message}`)
    }

    const responseText = await response.text()
    if (!response.ok) {
      const detail = parseErrorDetail(responseText, response.statusText)
      throw new Error(
        `Incentives API ${method} ${path} failed (${response.status} ${response.statusText}): ${detail}`
      )
    }

    if (!responseText) {
      return undefined as T
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('application/json')) {
      return JSON.parse(responseText) as T
    }

    return responseText as T
  }
}
