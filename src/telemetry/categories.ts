/**
 * Tool name → product area, the `tool.category` attribute on `mcp.tool.calls`.
 *
 * Rules run before the explicit map so a *new* tool in an existing family (`incentives_foo`,
 * `serviceBar`, `escrow_baz`) is categorized automatically rather than failing CI on the day it
 * lands. The explicit map covers everything the rules cannot infer from the name.
 *
 * `categories.test.ts` walks a live `createServer()` instance and asserts every registered tool
 * resolves — that is the gate which catches a whole new domain file landing uncategorized, which
 * is exactly how the 11 Service-on-Demand tools would otherwise have slipped through (plan §0.1a).
 */
export type ToolCategory =
  | 'assets'
  | 'evm'
  | 'p2p'
  | 'incentives'
  | 'docs'
  | 'resources'
  | 'services'

const RULES: Array<{ pattern: RegExp; category: ToolCategory }> = [
  { pattern: /^incentives_/, category: 'incentives' },
  { pattern: /^(escrow_|accesslist_)/, category: 'evm' },
  {
    pattern: /^(service|findService|getService|getServices|estimateService)/,
    category: 'services'
  }
]

const EXPLICIT: Record<string, ToolCategory> = {
  // assets
  order_asset: 'assets',
  download_asset_file: 'assets',
  get_download_fees: 'assets',
  resolveDdo: 'assets',
  validateDdo: 'assets',
  check_did_files: 'assets',

  // evm
  get_balance: 'evm',
  get_transaction_count: 'evm',
  get_transaction: 'evm',
  get_transaction_receipt: 'evm',
  broadcast_transaction: 'evm',
  get_erc20_token_info: 'evm',

  // p2p / node protocol
  mcp_server_peers: 'p2p',
  node_status: 'p2p',
  buildFindProviderC2dContent: 'p2p',
  find_provider: 'p2p',
  is_valid_provider: 'p2p',
  resolve_peer_multiaddr: 'p2p',
  list_discovered_peers: 'p2p',
  getComputeEnvironments: 'p2p',
  getNodeJobs: 'p2p',
  getNonce: 'p2p',
  getFileInfo: 'p2p',
  initializeCompute: 'p2p',
  computeStart: 'p2p',
  freeComputeStart: 'p2p',
  computeStop: 'p2p',
  computeStatus: 'p2p',
  getComputeResult: 'p2p',
  get_compute_result_url: 'p2p',
  compute_streamable_logs: 'p2p',
  downloadNodeLogs: 'p2p',
  createPersistentStorageBucket: 'p2p',
  getPersistentStorageBuckets: 'p2p',
  listPersistentStorageFiles: 'p2p',
  getPersistentStorageFileObject: 'p2p',
  deletePersistentStorageFile: 'p2p',
  upload_persistent_storage_file: 'p2p',
  p2p_encrypt: 'p2p',
  create_auth_token: 'p2p',
  policy_server_passthrough: 'p2p',
  policy_server_initialize_verification: 'p2p',
  fetch_node_config: 'p2p',
  push_node_config: 'p2p',
  cid_from_raw_string: 'p2p',

  // docs
  search_docs: 'docs',
  get_doc: 'docs',
  list_topics: 'docs',
  get_workflow: 'docs',
  validate_algo_structure: 'docs',

  // node-operator onboarding: lives in the docs file, but the product area is incentives
  check_node_eligibility: 'incentives',

  // resources
  list_resources: 'resources',
  get_resource: 'resources'
}

/**
 * `undefined` means "no mapping" — the caller records `unknown` so a metric is never dropped,
 * while `categories.test.ts` still fails the build.
 */
export function lookupCategory(name: string): ToolCategory | undefined {
  const explicit = EXPLICIT[name]
  if (explicit) return explicit
  for (const rule of RULES) {
    if (rule.pattern.test(name)) return rule.category
  }
  return undefined
}

export function categoryOf(name: string): ToolCategory | 'unknown' {
  return lookupCategory(name) ?? 'unknown'
}
