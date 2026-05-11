#!/usr/bin/env node

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const contentDir = process.env.DOCS_CONTENT_DIR
  ? path.resolve(process.cwd(), process.env.DOCS_CONTENT_DIR)
  : path.resolve(__dirname, '../content')

const repos = [
  {
    name: 'ON-Docs-MCP',
    envKey: 'ON_DOCS_PATH',
    url: 'https://github.com/oceanprotocol/ON-Docs-MCP',
    branch: 'main'
  },
  {
    name: 'ocean-node',
    envKey: 'OCEAN_NODE_PATH',
    url: 'https://github.com/oceanprotocol/ocean-node',
    branch: 'main'
  },
  {
    name: 'nodes-dashboard',
    envKey: 'NODES_DASHBOARD_PATH',
    url: 'https://github.com/oceanprotocol/nodes-dashboard',
    branch: 'main'
  },
  {
    name: 'nodes-incentives-monitor',
    envKey: 'NODES_INCENTIVES_MONITOR_PATH',
    url: 'https://github.com/oceanprotocol/nodes-incentives-monitor',
    branch: 'main'
  },
  {
    name: 'vscode-extension',
    envKey: 'VSCODE_EXTENSION_PATH',
    url: 'https://github.com/oceanprotocol/vscode-extension',
    branch: 'main'
  },
  {
    name: 'contracts',
    envKey: 'OCEAN_CONTRACTS_PATH',
    url: 'https://github.com/oceanprotocol/contracts',
    branch: 'main'
  },
  {
    name: 'ocean.js',
    envKey: 'OCEAN_JS_PATH',
    url: 'https://github.com/oceanprotocol/ocean.js',
    branch: 'main'
  },
  {
    name: 'ocean.js-cli',
    envKey: 'OCEAN_CLI_PATH',
    url: 'https://github.com/oceanprotocol/ocean.js-cli',
    branch: 'main'
  }
]

fs.mkdirSync(contentDir, { recursive: true })
process.env.DOCS_CONTENT_DIR ??= contentDir

let failures = 0

for (const repo of repos) {
  const destination = process.env[repo.envKey]
    ? path.resolve(process.cwd(), process.env[repo.envKey])
    : path.join(contentDir, repo.name)

  try {
    if (fs.existsSync(path.join(destination, '.git'))) {
      console.log(`[sync-docs-content] Pulling ${repo.name}...`)
      execSync(`git -C "${destination}" pull --depth=1 --rebase`, { stdio: 'inherit' })
    } else {
      if (fs.existsSync(destination)) {
        fs.rmSync(destination, { recursive: true, force: true })
      }

      console.log(`[sync-docs-content] Cloning ${repo.name}...`)
      execSync(`git clone --depth=1 --branch ${repo.branch} ${repo.url} "${destination}"`, {
        stdio: 'inherit'
      })
    }

    process.env[repo.envKey] ??= destination
  } catch (error) {
    console.error(`[sync-docs-content] Failed syncing ${repo.name}: ${error}`)
    failures += 1
  }
}

if (failures > 0) {
  console.error(`[sync-docs-content] ${failures} repo(s) failed to sync.`)
  process.exit(1)
}

console.log(`[sync-docs-content] All docs repos are available under ${contentDir}`)
