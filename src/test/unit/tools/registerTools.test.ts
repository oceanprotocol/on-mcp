import { expect } from 'chai'

import { registerTools } from '../../../tools/registerTools.js'

const INCENTIVES_TOOL_NAMES = [
  'incentives_list_nodes',
  'incentives_run_query',
  'incentives_get_node_system_stats',
  'incentives_get_node_benchmark_history',
  'incentives_get_ban_status',
  'incentives_request_unban',
  'incentives_list_unban_requests',
  'incentives_get_node_benchmark',
  'incentives_list_owner_compute_jobs',
  'incentives_get_owner_env_info',
  'incentives_get_owner_nodes_stats',
  'incentives_get_consumer_jobs_success_rate',
  'incentives_list_admin_nodes',
  'incentives_list_envs'
]

describe('registerTools', () => {
  it('registers the incentives tool group', () => {
    const registeredTools: string[] = []
    const server = {
      registerTool(name: string) {
        registeredTools.push(name)
      }
    }

    registerTools({
      server: server as any,
      nodeClient: {} as any,
      incentivesClient: {} as any,
      evmRegistry: {} as any,
      docsIndex: []
    })

    expect(
      registeredTools.filter((name) => name.startsWith('incentives_'))
    ).to.deep.equal(INCENTIVES_TOOL_NAMES)
  })
})
