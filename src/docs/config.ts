import path from 'node:path'

export const DOC_SECTIONS = [
  'guide',
  'ocean-node',
  'dashboard',
  'incentives-monitor',
  'vscode-extension',
  'ocean-contracts',
  'ocean-js',
  'ocean-cli'
] as const

export const DOC_SECTIONS_WITH_ALL = [...DOC_SECTIONS, 'all'] as const

export const DOC_SEARCH_FILE_TYPES = ['md', 'ts', 'js', 'json', 'sol', 'all'] as const
export const DOC_LIST_FILE_TYPES = ['md', 'ts', 'js', 'json', 'all'] as const

export type DocSection = (typeof DOC_SECTIONS)[number]

export type DocSourceConfig = {
  section: DocSection
  uriPrefix: `ocean://docs/${string}/`
  envKey: string
  repoDirName: string
  defaultSiblingPath: string
  extraExcludes?: string[]
}

const docsContentDir = process.env.DOCS_CONTENT_DIR
  ? path.resolve(process.cwd(), process.env.DOCS_CONTENT_DIR)
  : undefined

function resolveRootPath(source: DocSourceConfig): string {
  const envValue = process.env[source.envKey]
  if (envValue) {
    return path.resolve(process.cwd(), envValue)
  }

  if (docsContentDir) {
    return path.join(docsContentDir, source.repoDirName)
  }

  return path.resolve(process.cwd(), source.defaultSiblingPath)
}

export const DOC_SOURCES: DocSourceConfig[] = [
  {
    section: 'guide',
    uriPrefix: 'ocean://docs/guide/',
    envKey: 'ON_DOCS_PATH',
    repoDirName: 'ON-Docs-MCP',
    defaultSiblingPath: '../ON-Docs-MCP',
    extraExcludes: [
      'SUMMARY.md',
      'MCP_SERVER_PROPOSAL.md',
      'claim-tokens-*',
      'supporting docs/**'
    ]
  },
  {
    section: 'ocean-node',
    uriPrefix: 'ocean://docs/ocean-node/',
    envKey: 'OCEAN_NODE_PATH',
    repoDirName: 'ocean-node',
    defaultSiblingPath: '../ocean-node',
    extraExcludes: [
      'docs/GITHUB_ISSUE_*',
      'docs/ISSUE_*',
      'docs/Ocean Node.postman_collection.json'
    ]
  },
  {
    section: 'dashboard',
    uriPrefix: 'ocean://docs/dashboard/',
    envKey: 'NODES_DASHBOARD_PATH',
    repoDirName: 'nodes-dashboard',
    defaultSiblingPath: '../nodes-dashboard'
  },
  {
    section: 'incentives-monitor',
    uriPrefix: 'ocean://docs/incentives-monitor/',
    envKey: 'NODES_INCENTIVES_MONITOR_PATH',
    repoDirName: 'nodes-incentives-monitor',
    defaultSiblingPath: '../nodes-incentives-monitor'
  },
  {
    section: 'vscode-extension',
    uriPrefix: 'ocean://docs/vscode-extension/',
    envKey: 'VSCODE_EXTENSION_PATH',
    repoDirName: 'vscode-extension',
    defaultSiblingPath: '../vscode-extension',
    extraExcludes: ['real-estate-*/**', 'DOCKER_HUB_ANALYSIS.md', 'offer.*']
  },
  {
    section: 'ocean-contracts',
    uriPrefix: 'ocean://docs/ocean-contracts/',
    envKey: 'OCEAN_CONTRACTS_PATH',
    repoDirName: 'contracts',
    defaultSiblingPath: '../contracts',
    extraExcludes: [
      'artifacts/**',
      'cache/**',
      'coverage/**',
      'coverage.json',
      '*.pdf',
      '*.jpg',
      '*.png'
    ]
  },
  {
    section: 'ocean-js',
    uriPrefix: 'ocean://docs/ocean-js/',
    envKey: 'OCEAN_JS_PATH',
    repoDirName: 'ocean.js',
    defaultSiblingPath: '../ocean.js',
    extraExcludes: ['artifacts/**', 'coverage/**', 'coverage.json']
  },
  {
    section: 'ocean-cli',
    uriPrefix: 'ocean://docs/ocean-cli/',
    envKey: 'OCEAN_CLI_PATH',
    repoDirName: 'ocean.js-cli',
    defaultSiblingPath: '../ocean.js-cli'
  }
]

export function getDocSourcesWithResolvedPaths() {
  return DOC_SOURCES.map((source) => ({
    ...source,
    rootPath: resolveRootPath(source)
  }))
}
