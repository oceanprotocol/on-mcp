import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'

import {
  DOC_LIST_FILE_TYPES,
  DOC_SEARCH_FILE_TYPES,
  DOC_SECTIONS,
  DOC_SECTIONS_WITH_ALL
} from '../docs/config.js'
import type { DocIndex } from '../docs/loader.js'
import { search } from '../docs/search.js'
import { textContent } from '../utils/format.js'

type ValidationIssue = {
  level: 'error' | 'warning'
  check: string
  message: string
  fix: string
}

type EligibilityResult = {
  pass: boolean
  check: string
  status: 'pass' | 'fail' | 'warn'
  detail: string
  fix?: string
}

type Params = {
  server: McpServer
  docsIndex: DocIndex
}

const BASE_CHAIN_ID = '8453'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const BASE_COMPY = '0x298f163244e0c8cc9316d6e97162e5792ac5d410'
const BASE_FEE_TOKENS: ReadonlyArray<{ symbol: string; address: string }> = [
  { symbol: 'USDC', address: BASE_USDC },
  { symbol: 'COMPY', address: BASE_COMPY }
]

const PRIVATE_IP_PATTERNS = [
  /^\/ip4\/127\./,
  /^\/ip4\/10\./,
  /^\/ip4\/192\.168\./,
  /^\/ip4\/172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^\/ip4\/0\./,
  /relay/i
]

const WORKFLOWS: Record<string, { title: string; persona: string; steps: string[] }> = {
  run_node: {
    title: 'Run an Ocean Node',
    persona: 'Node Operator',
    steps: [
      'Prerequisites: Install Docker and Docker Compose. Minimum hardware: 1 vCPU, 2GB RAM, 4GB storage.',
      "Recommended - Dashboard Wizard: Go to https://dashboard.oceanprotocol.com, navigate to 'Run Node', connect your wallet, fill in config (ports, IP, TLS, compute resources), and download the generated docker-compose.yml.",
      'Alternative - Quickstart Script: Run:\n  bash <(curl -s https://raw.githubusercontent.com/oceanprotocol/ocean-node/main/scripts/ocean-node-quickstart.sh)\n  Follow the prompts: enter PRIVATE_KEY, configure ports, enable C2D, detect GPU.',
      'Start the node: docker-compose up -d',
      'Verify: Open http://localhost:8000/controlpanel/ to confirm the node is running.',
      'For incentive eligibility, also complete the node eligibility checklist (use the check_node_eligibility tool or see the setup_node prompt).'
    ]
  },
  configure_node_for_incentives: {
    title: 'Configure Node for Incentive Eligibility',
    persona: 'Node Operator',
    steps: [
      'Ensure node version is >= 2.0.0. Check at: http://localhost:8000/api/services/info',
      'Set P2P_ANNOUNCE_ADDRESSES to your server\'s public IP:\n  P2P_ANNOUNCE_ADDRESSES=["/ip4/YOUR_PUBLIC_IP/tcp/8000"]',
      'Configure the Base escrow address (chain ID 8453) - see Ocean Protocol deployment addresses.',
      'Set DOCKER_COMPUTE_ENVIRONMENTS with at least one environment that:\n  - Includes Base (8453) fee chain\n  - Accepts Base USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) and/or COMPY (0x298f163244e0c8cc9316D6E97162e5792ac5d410, the Ocean grant token) as feeToken\n  - Has GPU resource listed\n  - Total resource price: 0 < total <= 1 USDC-equivalent/min (for benchmark jobs)\n  - Adds the Ocean monitoring consumer wallet to access.addresses',
      'Restart: docker-compose down && docker-compose up -d',
      "Verify eligibility on the Nodes Dashboard under your node's 'Eligibility' tab."
    ]
  },
  troubleshoot_node: {
    title: 'Troubleshoot an Ocean Node',
    persona: 'Node Operator',
    steps: [
      'Check container logs: docker logs ocean-node  (or: pm2 logs ocean-node)',
      "Node won't start? Verify PRIVATE_KEY starts with 0x and port 8000 is not in use.",
      'GPU not detected? Install NVIDIA drivers + NVIDIA Container Toolkit so Docker can access the GPU.',
      'Not receiving benchmark jobs? Use the check_node_eligibility tool with your config - it will identify the failing criterion.',
      "Suspended or banned? Check the Nodes Dashboard 'Eligibility' tab. 3 consecutive failures trigger exponential suspension. Request unban via the dashboard button.",
      'Database errors? Ensure Typesense or Elasticsearch container is healthy and DB_URL is correct.',
      'Docker Hub rate limits? Run: docker login  - or upgrade your Docker Hub plan.',
      'P2P connectivity? Confirm P2P port is open in your firewall and P2P_ANNOUNCE_ADDRESSES has your real public IP.'
    ]
  },
  write_c2d_algo: {
    title: 'Write a C2D Algorithm',
    persona: 'Algorithm Writer',
    steps: [
      'RECOMMENDED PATH (no Docker build). Read the resource ocean://docs/c2d-algorithm-authoring (via get_doc or get_resource) first. You submit your source inline as algorithm.meta.rawcode against a prebuilt oceanprotocol/c2d_examples image - no Dockerfile, no registry push, no image to publish.',
      'Pick a prebuilt image by matching your imports to the catalog in that resource (py-lite, py-panda, py-sql, py-general, js-general). Use the smallest image that covers your imports. If none cover them, build your own image (CUSTOM IMAGE step below).',
      'Write to the C2D filesystem contract and runtime constraints: read inputs from /data/inputs, write outputs to /data/outputs, exit 0. See ocean://docs/c2d-algorithm-authoring for the exact rules (recursive input walk, DIDS, algoCustomData.json, outputs.tar, no runtime installs, algorithm.log).',
      'Validate before submitting: use the validate_algo_structure tool by pasting your code.',
      'Submit: pass the algorithm object (meta.container { image, tag, checksum, entrypoint e.g. "python $ALGO" } + meta.rawcode) to computeStart (paid) or freeComputeStart (free). See ocean://docs/c2d-algorithm-authoring for the exact shape and free-compute auth.',
      'CUSTOM IMAGE (only if no prebuilt image has your dependencies): use the new_c2d_algo_python / new_c2d_algo_js prompt for a Dockerfile-based skeleton, build and push the image to a registry, then reference it in container.image / tag / checksum.'
    ]
  },
  publish_algorithm: {
    title: 'Publish an Algorithm',
    persona: 'Algorithm Writer / Demand Side',
    steps: [
      'Set required environment variables:\n  export PRIVATE_KEY=0x...\n  export RPC=https://...\n  export NODE_URL=http://your-node:8000',
      "Create metadata JSON at metadata/my-algorithm.json following the Ocean DDO standard.\n  Key fields: name, description, files (Docker image reference or URL), type: 'algorithm'.",
      'Publish: npm run cli publishAlgo metadata/my-algorithm.json',
      "The CLI returns the algorithm DID (did:op:0x...). Save it - you'll need it for compute jobs.",
      'To whitelist your algorithm on a dataset:\n  npm run cli allowAlgo --dataset did:op:DATASET_DID --algo did:op:ALGO_DID'
    ]
  },
  publish_dataset: {
    title: 'Publish a Dataset',
    persona: 'Demand Side',
    steps: [
      'Set required environment variables:\n  export PRIVATE_KEY=0x...\n  export RPC=https://...\n  export NODE_URL=http://your-node:8000',
      "Create metadata JSON at metadata/my-dataset.json following the Ocean DDO standard.\n  Key fields: name, description, files (array of file URLs or IPFS hashes), type: 'dataset'.",
      'Publish: npm run cli publish metadata/my-dataset.json',
      'The CLI returns the dataset DID (did:op:0x...). Save it.',
      'To edit metadata later:\n  npm run cli editAsset --did did:op:YOUR_DID --file updated-metadata.json',
      "To control access, create an access list:\n  npm run cli createAccessList --name 'My List' --symbol 'ML' --users '0xUser1,0xUser2'"
    ]
  },
  run_compute_job_cli: {
    title: 'Run a Compute Job via Ocean CLI',
    persona: 'Demand Side',
    steps: [
      "Set required environment variables:\n  export PRIVATE_KEY=0x...\n  export RPC=https://mainnet.base.org\n  export NODE_URL=http://your-node:8000\n  # Pick the env's fee token. Common Base options:\n  #   USDC:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\n  #   COMPY: 0x298f163244e0c8cc9316D6E97162e5792ac5d410 (Ocean grant token)\n  export PAYMENT_TOKEN=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      'Find available compute environments:\n  npm run cli getComputeEnvironments\n  Note the environment ID (ENV_ID) you want to use.',
      'Get your dataset and algorithm DIDs (from publishing them, or browse the network).',
      'Start the job:\n  npm run cli startCompute \\\n    $DATASET_DID \\\n    $ALGO_DID \\\n    $ENV_ID \\\n    60 \\\n    $PAYMENT_TOKEN \\\n    \'[{"id":"cpu","amount":1},{"id":"disk","amount":1},{"id":"ram","amount":1}]\'\n  Add --accept true to skip the payment confirmation prompt.',
      "Monitor job status (save JOB_ID from the previous step):\n  npm run cli getJobStatus -d $DATASET_DID -j $JOB_ID ''",
      "When status shows 'Finished', download results:\n  mkdir results\n  npm run cli downloadJobResults $JOB_ID 2 ./results"
    ]
  },
  run_compute_job_vscode: {
    title: 'Run a Compute Job via VS Code Extension',
    persona: 'Demand Side / Algorithm Writer',
    steps: [
      'Install the Ocean Orchestrator extension from the VS Code Marketplace (also works in Cursor, Windsurf, Antigravity).',
      'Click the Ocean icon in the Activity Bar to open the Ocean Orchestrator panel.',
      'Create a new project: click "Create a new project folder", choose Python / JavaScript / Custom Docker.',
      'Your project will have:\n  * algo.py / algo.js - your algorithm\n  * Dockerfile - container definition\n  * requirements.txt / package.json - dependencies\n  * .env - secrets',
      'Browse compute resources: use the Nodes Dashboard link in the extension to find a suitable node.',
      'Select the node/environment in the extension under "Configure Compute".',
      'Free compute: click "Start FREE Compute Job".\n  Paid compute: ensure you have USDC on Base, then click "Start Paid Compute Job".',
      'Monitor in the Output console (real-time logs stream from the node).',
      'When complete, check the results/ folder in your project directory.'
    ]
  },
  run_compute_job_dashboard: {
    title: 'Run a Compute Job via Dashboard',
    persona: 'Demand Side',
    steps: [
      'Open https://dashboard.oceanprotocol.com and log in (wallet or email/social via Smart Wallet).',
      "Navigate to 'Run a Job' and browse the GPU catalog.\n  Filter by GPU model (H100, A100...), RAM, price, region.",
      "Click 'Run a job' on your chosen node.",
      'Configure the job: upload your algorithm (Python/JS), select input dataset, set duration.',
      'Payment:\n  * Ensure USDC balance on Base network\n  * Deposit to escrow if prompted\n  * Authorize the payment transaction',
      'Execute: generate a job token and confirm the transaction.',
      'Monitor in "My Jobs": watch status Queued -> Running -> Completed, view live logs.',
      'Download output files when the job is Completed.'
    ]
  },
  fund_wallet: {
    title: 'Fund Your Wallet on Base (USDC or COMPY)',
    persona: 'Demand Side',
    steps: [
      "Ocean runs on the Base network (Ethereum L2). Common fee tokens: **USDC** (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) and **COMPY** (0x298f163244e0c8cc9316D6E97162e5792ac5d410 — Ocean grant token). Check the target env's `fee_tokens` to know which it accepts.",
      'Options to get USDC on Base:\n  A) Coinbase Exchange: send USDC directly to your Base address (no bridge fee).\n  B) Base Bridge (bridge.base.org): deposit ETH or USDC from Ethereum Mainnet.\n  C) Superbridge: cross-chain bridge from other networks.\n  D) Fiat On-Ramp (coming soon in Dashboard): buy USDC directly with credit card via MoonPay.\n  Options to get COMPY: receive a grant allocation from Ocean Network (grant token, not openly tradable).',
      'Check your balance in the Nodes Dashboard wallet section.',
      'Deposit to escrow before running jobs: the dashboard will prompt you if escrow is insufficient.',
      'To manage escrow via CLI:\n  Deposit: npm run cli depositEscrow --token 0xToken --amount 100\n  Check: npm run cli getUserFundsEscrow --token 0xToken\n  Withdraw: npm run cli withdrawFromEscrow --token 0xToken --amount 50'
    ]
  }
}

function detectLanguage(filename: string): 'python' | 'javascript' | 'unknown' {
  const extension = filename.split('.').pop()?.toLowerCase()
  if (extension === 'py') return 'python'
  if (extension === 'js' || extension === 'ts' || extension === 'mjs') return 'javascript'
  return 'unknown'
}

function validateAlgoCode(
  code: string,
  language: 'python' | 'javascript' | 'unknown'
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const usesDids =
    language === 'python'
      ? code.includes('os.environ') && code.includes('DIDS')
      : code.includes('process.env') && code.includes('DIDS')

  if (!usesDids) {
    issues.push({
      level: 'error',
      check: 'DIDS environment variable',
      message: 'Algorithm does not read the DIDS environment variable.',
      fix:
        language === 'python'
          ? "Add: dids = json.loads(os.environ.get('DIDS', '[]'))"
          : "Add: const dids = JSON.parse(process.env.DIDS || '[]')"
    })
  }

  if (!code.includes('/data/inputs')) {
    issues.push({
      level: 'error',
      check: 'Input path /data/inputs',
      message: 'Algorithm does not read from the C2D input directory /data/inputs.',
      fix: 'Input files are mounted at /data/inputs/<DID>/<filename>. Read them from there.'
    })
  }

  if (!code.includes('/data/outputs')) {
    issues.push({
      level: 'error',
      check: 'Output path /data/outputs',
      message:
        'Algorithm does not write to /data/outputs/. Results written elsewhere will not be returned.',
      fix: "Write all output files to /data/outputs/. Example: open('/data/outputs/result.txt', 'w')"
    })
  }

  if (language === 'python') {
    const hasExit = code.includes('sys.exit') || code.includes('exit(')
    if (!hasExit) {
      issues.push({
        level: 'warning',
        check: 'Exit code',
        message:
          'No explicit sys.exit() found. The container should exit 0 on success and non-zero on failure.',
        fix: 'Add sys.exit(0) at the end and sys.exit(1) in your except block.'
      })
    }
  } else if (language === 'javascript') {
    const hasExit =
      code.includes('process.exit') || code.includes('.then(() => process.exit')
    if (!hasExit) {
      issues.push({
        level: 'warning',
        check: 'Exit code',
        message:
          'No explicit process.exit() found. The container should exit 0 on success and non-zero on failure.',
        fix: 'End your main function with .then(() => process.exit(0)).catch(() => process.exit(1))'
      })
    }
  }

  if (/['"`]\/(?!data\/).+\.(?:csv|json|txt|parquet)/i.test(code)) {
    issues.push({
      level: 'warning',
      check: 'Hardcoded file path',
      message:
        'Detected a hardcoded file path outside of /data/. These paths will not exist in the container.',
      fix: 'Use /data/inputs/<DID>/ for inputs and /data/outputs/ for outputs.'
    })
  }

  if (language === 'python' && code.includes('print(') && !code.includes('flush=True')) {
    issues.push({
      level: 'warning',
      check: 'Log flushing',
      message:
        'print() calls found without flush=True. Logs may not appear in the real-time monitor.',
      fix: "Use print('message', flush=True) to ensure logs stream in real-time."
    })
  }

  if (
    language === 'python' &&
    code.includes('/data/outputs') &&
    !code.includes('os.makedirs') &&
    !code.includes('Path(') &&
    !code.includes('mkdir')
  ) {
    issues.push({
      level: 'warning',
      check: 'Output directory creation',
      message:
        '/data/outputs/ should be created before writing to it (it may not exist).',
      fix: "Add: os.makedirs('/data/outputs', exist_ok=True)"
    })
  }

  return issues
}

function validateDockerfile(content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (!content.includes('WORKDIR')) {
    issues.push({
      level: 'warning',
      check: 'Dockerfile WORKDIR',
      message: 'No WORKDIR instruction found.',
      fix: 'Add: WORKDIR /app'
    })
  }

  if (!content.includes('CMD') && !content.includes('ENTRYPOINT')) {
    issues.push({
      level: 'error',
      check: 'Dockerfile CMD/ENTRYPOINT',
      message:
        "No CMD or ENTRYPOINT instruction found. The container won't know what to run.",
      fix: 'Add: CMD ["python", "algo.py"] or CMD ["node", "algo.js"]'
    })
  }

  return issues
}

function semverMajor(version: string): number {
  return parseInt(version.split('.')[0] ?? '0', 10)
}

function isPublicMultiaddr(address: string): boolean {
  return !PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(address))
}

function sumResourcePrices(prices: Array<{ id: string; price?: number }>): number {
  return prices.reduce((sum, price) => sum + (price.price ?? 0), 0)
}

export function registerDocsTools({ server, docsIndex }: Params): void {
  server.registerTool(
    'search_docs',
    {
      title: 'Search Ocean docs',
      description:
        'Search Ocean Network documentation by keyword or question across the indexed docs repositories.',
      inputSchema: {
        query: z.string().describe('The search query or question.'),
        section: z
          .enum(DOC_SECTIONS_WITH_ALL)
          .optional()
          .default('all')
          .describe('Limit results to a specific repository section.'),
        fileType: z
          .enum(DOC_SEARCH_FILE_TYPES)
          .optional()
          .default('all')
          .describe('Limit results to a specific file type.')
      }
    },
    ({ query, section, fileType }) => {
      const results = search(docsIndex, {
        query,
        section: section ?? 'all',
        fileType: fileType ?? 'all',
        limit: 10
      })

      if (results.length === 0) {
        return textContent(`No results found for: "${query}"`)
      }

      const formatted = results
        .map(
          (result, index) =>
            `${index + 1}. [${result.section}] ${result.title}\n   URI: ${result.uri}\n   Score: ${result.score}\n   ${result.excerpt}`
        )
        .join('\n\n')

      return textContent(
        `Found ${results.length} result(s) for "${query}":\n\n${formatted}`
      )
    }
  )

  server.registerTool(
    'get_doc',
    {
      title: 'Get Ocean doc by URI',
      description:
        'Retrieve the full content of a specific documentation file by its URI. Use list_topics to discover available URIs.',
      inputSchema: {
        uri: z
          .string()
          .describe(
            'The full URI of the document, e.g. "ocean://docs/guide/ocean-node/getting-started.md".'
          )
      }
    },
    ({ uri }) => {
      const directMatch = docsIndex.find((entry) => entry.uri === uri)
      const entry =
        directMatch ??
        docsIndex.find((docEntry) => docEntry.uri.toLowerCase() === uri.toLowerCase())

      if (!entry) {
        return textContent(
          `Document not found: "${uri}". Use list_topics to see available URIs.`
        )
      }

      return textContent(
        `# ${entry.title}\n\nURI: ${entry.uri}\nSection: ${entry.section}\nFile type: ${entry.mimeType}\n\n---\n\n${entry.content}`
      )
    }
  )

  server.registerTool(
    'list_topics',
    {
      title: 'List Ocean doc topics',
      description:
        'List all available documentation topics grouped by section. Defaults to markdown files only to keep output manageable.',
      inputSchema: {
        section: z
          .enum(DOC_SECTIONS_WITH_ALL)
          .optional()
          .default('all')
          .describe("Filter by section, or 'all' to see every section."),
        fileType: z
          .enum(DOC_LIST_FILE_TYPES)
          .optional()
          .default('md')
          .describe(
            "Filter by file type. Defaults to 'md' to avoid flooding with source files."
          )
      }
    },
    ({ section, fileType }) => {
      const mimeFilter: Record<string, string[]> = {
        md: ['text/markdown'],
        ts: ['text/x-typescript'],
        js: ['text/javascript'],
        json: ['application/json']
      }

      let candidates = docsIndex

      if (section && section !== 'all') {
        candidates = candidates.filter((entry) => entry.section === section)
      }

      if (fileType && fileType !== 'all' && mimeFilter[fileType]) {
        candidates = candidates.filter((entry) =>
          mimeFilter[fileType].includes(entry.mimeType)
        )
      }

      const grouped: Record<string, string[]> = {}
      for (const entry of candidates) {
        grouped[entry.section] ??= []
        grouped[entry.section].push(`${entry.uri} - ${entry.title}`)
      }

      const sectionLines: string[] = []
      for (const sectionName of DOC_SECTIONS) {
        if (!grouped[sectionName]) continue
        sectionLines.push(`## ${sectionName} (${grouped[sectionName].length} files)`)
        for (const item of grouped[sectionName].sort()) {
          sectionLines.push(`  - ${item}`)
        }
        sectionLines.push('')
      }

      return textContent(
        `Showing ${candidates.length} of ${docsIndex.length} indexed files (fileType=${fileType ?? 'md'}, section=${section ?? 'all'}):\n\n${sectionLines.join('\n')}`
      )
    }
  )

  server.registerTool(
    'get_workflow',
    {
      title: 'Get Ocean workflow guide',
      description:
        'Get a step-by-step guide for a specific Ocean Network task across node operators, algorithm writers, and demand-side users.',
      inputSchema: {
        task: z
          .enum([
            'run_node',
            'configure_node_for_incentives',
            'troubleshoot_node',
            'write_c2d_algo',
            'publish_algorithm',
            'publish_dataset',
            'run_compute_job_cli',
            'run_compute_job_vscode',
            'run_compute_job_dashboard',
            'fund_wallet'
          ])
          .describe('The Ocean workflow to retrieve.')
      }
    },
    ({ task }) => {
      const workflow = WORKFLOWS[task]
      const workflowNames = Object.keys(WORKFLOWS).join(', ')

      if (!workflow) {
        return textContent(`Unknown workflow: "${task}". Available: ${workflowNames}`)
      }

      return textContent(
        [
          `# ${workflow.title}`,
          `Persona: ${workflow.persona}`,
          '',
          ...workflow.steps.map((step, index) => `## Step ${index + 1}\n${step}`)
        ].join('\n\n')
      )
    }
  )

  server.registerTool(
    'validate_algo_structure',
    {
      title: 'Validate C2D algorithm structure',
      description:
        'Validate an Ocean Compute-to-Data algorithm for common mistakes before submission.',
      inputSchema: {
        code: z
          .string()
          .describe('The full content of the algorithm file (Python or JavaScript).'),
        filename: z
          .string()
          .describe(
            'The algorithm filename, e.g. "algo.py" or "algo.js". Used to detect language.'
          ),
        dockerfile: z
          .string()
          .optional()
          .describe('Optional: the content of the Dockerfile for additional validation.')
      }
    },
    ({ code, filename, dockerfile }) => {
      const language = detectLanguage(filename)
      const issues = validateAlgoCode(code, language)

      if (dockerfile) {
        issues.push(...validateDockerfile(dockerfile))
      }

      if (issues.length === 0) {
        return textContent(
          `${filename} passed all C2D validation checks.\n\nNo issues found. This algorithm follows Ocean Compute-to-Data conventions correctly.`
        )
      }

      const errors = issues.filter((issue) => issue.level === 'error')
      const warnings = issues.filter((issue) => issue.level === 'warning')

      const lines = [
        `C2D Validation Report for: ${filename}`,
        `Language: ${language}`,
        '',
        `${errors.length} error(s), ${warnings.length} warning(s)`,
        ''
      ]

      if (errors.length > 0) {
        lines.push('## Errors (must fix before job will work)')
        for (const issue of errors) {
          lines.push(`\n[ERROR] ${issue.check}`)
          lines.push(`  Problem: ${issue.message}`)
          lines.push(`  Fix:     ${issue.fix}`)
        }
        lines.push('')
      }

      if (warnings.length > 0) {
        lines.push('## Warnings (recommended fixes)')
        for (const issue of warnings) {
          lines.push(`\n[WARN] ${issue.check}`)
          lines.push(`  Problem: ${issue.message}`)
          lines.push(`  Fix:     ${issue.fix}`)
        }
      }

      return textContent(lines.join('\n'))
    }
  )

  server.registerTool(
    'check_node_eligibility',
    {
      title: 'Check node incentive eligibility',
      description:
        'Validate an Ocean Node configuration against the incentive program eligibility requirements.',
      inputSchema: {
        version: z.string().optional().describe('Node software version, e.g. "2.1.0".'),
        p2p_announce_addresses: z
          .array(z.string())
          .optional()
          .describe('List of P2P multiaddrs the node announces.'),
        escrow_chains: z
          .array(z.string())
          .optional()
          .describe('Chain IDs configured in the node escrow address.'),
        compute_environments: z
          .array(
            z.object({
              id: z.string().optional(),
              fee_tokens: z.array(z.string()).optional(),
              fee_chain_ids: z.array(z.string()).optional(),
              resource_prices: z
                .array(
                  z.object({
                    id: z.string().describe('Resource type: cpu, ram, disk, gpu'),
                    price: z.number().describe('Price per minute in USDC')
                  })
                )
                .optional(),
              has_gpu: z.boolean().optional(),
              access_addresses: z.array(z.string()).optional()
            })
          )
          .optional()
          .describe('List of compute environments exposed by the node.'),
        monitoring_consumer_address: z
          .string()
          .optional()
          .describe(
            'The Ocean monitoring consumer wallet address that must be in access.addresses.'
          )
      }
    },
    (args) => {
      const {
        version,
        p2p_announce_addresses: p2pAnnounceAddresses,
        escrow_chains: escrowChains,
        compute_environments: computeEnvironments,
        monitoring_consumer_address: monitoringConsumerAddress
      } = args
      const results: EligibilityResult[] = []

      if (version) {
        const majorVersion = semverMajor(version)
        results.push({
          pass: majorVersion >= 2,
          check: 'Node Version >= 2.0.0',
          status: majorVersion >= 2 ? 'pass' : 'fail',
          detail: `Running version ${version} (major: ${majorVersion})`,
          fix:
            majorVersion < 2
              ? 'Update ocean-node to version 2.0.0 or later. Run: git pull && npm run build'
              : undefined
        })
      } else {
        results.push({
          pass: false,
          check: 'Node Version >= 2.0.0',
          status: 'warn',
          detail: 'Version not provided - cannot verify.',
          fix: 'Check your running version at http://localhost:8000/api/services/info'
        })
      }

      if (p2pAnnounceAddresses && p2pAnnounceAddresses.length > 0) {
        const publicAddresses = p2pAnnounceAddresses.filter(isPublicMultiaddr)
        results.push({
          pass: publicAddresses.length > 0,
          check: 'P2P Public IP Announced',
          status: publicAddresses.length > 0 ? 'pass' : 'fail',
          detail:
            publicAddresses.length > 0
              ? `Found ${publicAddresses.length} public address(es): ${publicAddresses.join(', ')}`
              : `All ${p2pAnnounceAddresses.length} address(es) are private/relay-only: ${p2pAnnounceAddresses.join(', ')}`,
          fix:
            publicAddresses.length === 0
              ? 'Set P2P_ANNOUNCE_ADDRESSES to your server public IP, e.g. ["/ip4/YOUR_PUBLIC_IP/tcp/8000"]'
              : undefined
        })
      } else {
        results.push({
          pass: false,
          check: 'P2P Public IP Announced',
          status: 'warn',
          detail: 'P2P announce addresses not provided.',
          fix: "Set P2P_ANNOUNCE_ADDRESSES in your .env file with your node's public IP multiaddr."
        })
      }

      if (escrowChains && escrowChains.length > 0) {
        const hasBase = escrowChains.includes(BASE_CHAIN_ID)
        results.push({
          pass: hasBase,
          check: 'Escrow Configured for Base (8453)',
          status: hasBase ? 'pass' : 'fail',
          detail: hasBase
            ? 'Base escrow address is configured.'
            : `Escrow only configured for chains: ${escrowChains.join(', ')}. Base (8453) is missing.`,
          fix: hasBase
            ? undefined
            : 'Add the Ocean Protocol Escrow contract address for Base to your node configuration.'
        })
      } else {
        results.push({
          pass: false,
          check: 'Escrow Configured for Base (8453)',
          status: 'warn',
          detail: 'Escrow chain configuration not provided.',
          fix: 'Configure escrowAddress in your node settings to include Base (chain ID 8453).'
        })
      }

      if (computeEnvironments && computeEnvironments.length > 0) {
        let hasAnyEligibleEnvironment = false
        let hasGpu = false

        for (const [index, environment] of computeEnvironments.entries()) {
          const environmentLabel = environment.id
            ? `env "${environment.id}"`
            : `env #${index + 1}`
          const supportsBase = environment.fee_chain_ids?.includes(BASE_CHAIN_ID) ?? false
          const lowerFeeTokens = (environment.fee_tokens ?? []).map((token) =>
            token.toLowerCase()
          )
          const acceptedTokens = BASE_FEE_TOKENS.filter((t) =>
            lowerFeeTokens.includes(t.address)
          )

          if (!supportsBase) {
            results.push({
              pass: false,
              check: `${environmentLabel}: Base fee chain`,
              status: 'fail',
              detail: `${environmentLabel} does not list Base (8453) in its fee chains.`,
              fix: 'Add chain ID "8453" to this environment fee chain configuration.'
            })
          }

          if (supportsBase && acceptedTokens.length === 0) {
            results.push({
              pass: false,
              check: `${environmentLabel}: Base fee token (USDC or COMPY)`,
              status: 'warn',
              detail: `${environmentLabel} accepts neither Base USDC (${BASE_USDC}) nor COMPY (${BASE_COMPY}); it may use a different fee token.`,
              fix: `Add Base USDC ${BASE_USDC} and/or COMPY ${BASE_COMPY} to this environment's fee tokens if you want consumers to pay with them.`
            })
          }

          if (environment.resource_prices && environment.resource_prices.length > 0) {
            const totalPrice = sumResourcePrices(environment.resource_prices)
            const eligible = totalPrice > 0 && totalPrice < 3
            const benchmarkEligible = totalPrice > 0 && totalPrice <= 1

            results.push({
              pass: eligible,
              check: `${environmentLabel}: Pricing (0 < total < 3 USDC/min)`,
              status: eligible ? 'pass' : 'fail',
              detail: `Total resource price: ${totalPrice.toFixed(4)} USDC/min (${environment.resource_prices.map((price) => `${price.id}: ${price.price}`).join(', ')})`,
              fix: eligible
                ? undefined
                : totalPrice === 0
                  ? 'Set resource prices above 0 USDC/min.'
                  : 'Reduce total resource price to below 3 USDC/min.'
            })

            if (eligible) {
              hasAnyEligibleEnvironment = true
              results.push({
                pass: benchmarkEligible,
                check: `${environmentLabel}: Benchmark job eligible (<= 1 USDC/min)`,
                status: benchmarkEligible ? 'pass' : 'warn',
                detail: benchmarkEligible
                  ? `Total: ${totalPrice.toFixed(4)} USDC/min - eligible to receive paid benchmark jobs.`
                  : `Total: ${totalPrice.toFixed(4)} USDC/min - eligible for monitoring but not for benchmark jobs (need <= 1 USDC/min).`,
                fix: benchmarkEligible
                  ? undefined
                  : 'Reduce total price to <= 1 USDC/min to receive paid benchmark jobs and incentive rewards.'
              })
            }
          }

          if (environment.has_gpu === true) {
            hasGpu = true
          }

          if (monitoringConsumerAddress && environment.access_addresses?.length) {
            const consumerAddress = monitoringConsumerAddress.toLowerCase()
            const hasConsumer = environment.access_addresses.some(
              (address) => address.toLowerCase() === consumerAddress
            )

            results.push({
              pass: hasConsumer,
              check: `${environmentLabel}: Monitoring consumer in access list`,
              status: hasConsumer ? 'pass' : 'fail',
              detail: hasConsumer
                ? 'Monitoring consumer wallet is in the access list.'
                : `Monitoring consumer wallet ${monitoringConsumerAddress} is not in the access list.`,
              fix: hasConsumer
                ? undefined
                : `Add ${monitoringConsumerAddress} to this environment access.addresses list.`
            })
          }
        }

        results.push({
          pass: hasGpu,
          check: 'GPU Resource in at Least One Environment',
          status: hasGpu ? 'pass' : 'fail',
          detail: hasGpu
            ? 'At least one compute environment includes GPU resources.'
            : 'No compute environment has GPU resources. GPU is required for incentive eligibility.',
          fix: hasGpu
            ? undefined
            : "Add a GPU resource entry (id: 'gpu') to at least one compute environment."
        })

        if (!hasAnyEligibleEnvironment) {
          results.push({
            pass: false,
            check: 'At Least One Eligible Environment',
            status: 'fail',
            detail: 'No compute environment passes all eligibility checks.',
            fix: 'Fix pricing and chain configuration in at least one compute environment.'
          })
        }
      } else {
        results.push({
          pass: false,
          check: 'Compute Environments Configured',
          status: 'warn',
          detail: 'No compute environments provided.',
          fix: "Configure DOCKER_COMPUTE_ENVIRONMENTS in your node's .env file."
        })
      }

      const passes = results.filter((result) => result.status === 'pass').length
      const fails = results.filter((result) => result.status === 'fail').length
      const warnings = results.filter((result) => result.status === 'warn').length

      const lines = [
        '# Node Eligibility Report',
        '',
        `Result: ${fails === 0 ? 'ELIGIBLE' : 'NOT ELIGIBLE'} for incentive program`,
        `Checks: ${passes} passed, ${fails} failed, ${warnings} warnings`,
        ''
      ]

      for (const result of results) {
        const statusLabel =
          result.status === 'pass'
            ? '[PASS]'
            : result.status === 'fail'
              ? '[FAIL]'
              : '[WARN]'
        lines.push(`${statusLabel} ${result.check}`)
        lines.push(`  ${result.detail}`)
        if (result.fix) {
          lines.push(`  -> ${result.fix}`)
        }
        lines.push('')
      }

      if (fails === 0 && warnings === 0) {
        lines.push(
          'Your node meets all eligibility requirements for the Ocean incentive program.'
        )
      } else if (fails > 0) {
        lines.push(
          `Fix the ${fails} failed check(s) above before your node will qualify for incentive benchmark jobs.`
        )
      }

      return textContent(lines.join('\n'))
    }
  )
}
