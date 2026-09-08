import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'

const PYTHON_TEMPLATE = (name: string, description: string) => `# ${name}.py
# ${description}
#
# Ocean Compute-to-Data (C2D) Algorithm
# -------------------------------
# Requirements:
#   - Read input DIDs from the environment variable DIDS (JSON array string)
#   - Read input files from /data/inputs/<DID>/<index>
#   - Write ALL output files to /data/outputs/
#   - The container will be terminated after this script exits
#
# See: https://docs.oceanprotocol.com/developers/compute-to-data

import os
import json
import sys

def get_input_path(index: int = 0) -> str:
    """Return the path to the primary input file."""
    dids_raw = os.environ.get("DIDS", "[]")
    dids = json.loads(dids_raw)

    if not dids:
        raise RuntimeError("No DIDs found in environment variable DIDS")

    did = dids[0]
    input_dir = f"/data/inputs/{did}"
    files = sorted(os.listdir(input_dir)) if os.path.isdir(input_dir) else []
    if not files:
        raise RuntimeError(f"No input files found in {input_dir}")

    return os.path.join(input_dir, files[index])


OUTPUT_DIR = "/data/outputs"
os.makedirs(OUTPUT_DIR, exist_ok=True)


def run():
    input_file = get_input_path()
    print(f"Processing input: {input_file}", flush=True)

    with open(input_file, "r") as file_handle:
        data = file_handle.read()

    result = f"Processed {len(data)} bytes from {os.path.basename(input_file)}"

    output_path = os.path.join(OUTPUT_DIR, "result.txt")
    with open(output_path, "w") as file_handle:
        file_handle.write(result)

    print(f"Output written to {output_path}", flush=True)


if __name__ == "__main__":
    try:
        run()
        sys.exit(0)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
`

const PYTHON_DOCKERFILE_TEMPLATE = (name: string) => `# Dockerfile for ${name}
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ${name}.py ./

CMD ["python", "${name}.py"]
`

const PYTHON_REQUIREMENTS_TEMPLATE = `# Python dependencies
# Add your packages here, one per line
numpy
pandas
requests
`

const JS_TEMPLATE = (name: string, description: string) => `// ${name}.js
// ${description}
//
// Ocean Compute-to-Data (C2D) Algorithm
// -------------------------------
// Requirements:
//   - Read input DIDs from process.env.DIDS (JSON array string)
//   - Read input files from /data/inputs/<DID>/<index>
//   - Write ALL output files to /data/outputs/
//
// See: https://docs.oceanprotocol.com/developers/compute-to-data

const fs = require('fs')
const path = require('path')

function getInputPath(index = 0) {
  const dids = JSON.parse(process.env.DIDS || '[]')
  if (!dids.length) throw new Error('No DIDs found in environment variable DIDS')

  const did = dids[0]
  const inputDir = \`/data/inputs/\${did}\`
  const files = fs.readdirSync(inputDir).sort()
  if (!files.length) throw new Error(\`No input files found in \${inputDir}\`)

  return path.join(inputDir, files[index])
}

const OUTPUT_DIR = '/data/outputs'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

async function run() {
  const inputFile = getInputPath()
  console.log('Processing input:', inputFile)

  const data = fs.readFileSync(inputFile, 'utf8')
  const result = \`Processed \${data.length} bytes from \${path.basename(inputFile)}\`

  const outputPath = path.join(OUTPUT_DIR, 'result.txt')
  fs.writeFileSync(outputPath, result)
  console.log('Output written to', outputPath)
}

run().then(() => process.exit(0)).catch((error) => {
  console.error('ERROR:', error.message)
  process.exit(1)
})
`

const JS_DOCKERFILE_TEMPLATE = (name: string) => `# Dockerfile for ${name}
FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY ${name}.js ./

CMD ["node", "${name}.js"]
`

const JS_PACKAGE_JSON_TEMPLATE = (name: string) => `{
  "name": "${name}",
  "version": "1.0.0",
  "dependencies": {
    "axios": "^1.6.0",
    "bignumber.js": "^9.1.0"
  }
}
`

const DATASET_METADATA_TEMPLATE = (name: string, description: string) => `{
  "metadata": {
    "created": "${new Date().toISOString()}",
    "updated": "${new Date().toISOString()}",
    "description": "${description}",
    "name": "${name}",
    "type": "dataset",
    "author": "Your Name",
    "license": "https://market.oceanprotocol.com/terms"
  },
  "services": [
    {
      "type": "compute",
      "files": "0x...",
      "serviceEndpoint": "http://YOUR_NODE:8000",
      "timeout": 86400
    }
  ]
}`

const ALGO_METADATA_TEMPLATE = (
  name: string,
  description: string,
  language: 'python' | 'javascript'
) => `{
  "metadata": {
    "created": "${new Date().toISOString()}",
    "updated": "${new Date().toISOString()}",
    "description": "${description}",
    "name": "${name}",
    "type": "algorithm",
    "author": "Your Name",
    "license": "https://market.oceanprotocol.com/terms",
    "algorithm": {
      "language": "${language}",
      "version": "0.1",
      "container": {
        "entrypoint": "${language === 'python' ? 'python $ALGO' : 'node $ALGO'}",
        "image": "oceanprotocol/c2d_examples",
        "tag": "${language === 'python' ? 'py-general' : 'js-general'}",
        "checksum": ""
      }
    }
  },
  "services": [
    {
      "type": "compute",
      "serviceEndpoint": "http://YOUR_NODE:8000",
      "timeout": 86400
    }
  ]
}`

function promptMessage(text: string) {
  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text
        }
      }
    ]
  }
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'new_c2d_algo_python',
    {
      description:
        'Generate a Python algorithm skeleton compatible with Ocean Compute-to-Data (C2D). Produces the .py file, Dockerfile, and requirements.txt.',
      argsSchema: {
        algorithm_name: z
          .string()
          .describe('Name of the algorithm (used as the Python filename, no spaces)'),
        task_description: z
          .string()
          .describe('One sentence describing what the algorithm should do')
      }
    },
    (args) => {
      const { algorithm_name: algorithmName, task_description: taskDescription } = args
      const safeName = algorithmName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()

      return promptMessage(
        [
          `Generate an Ocean Compute-to-Data Python algorithm called "${safeName}" that: ${taskDescription}`,
          '',
          '## C2D Conventions (strictly follow these):',
          "- Input DIDs come from `os.environ['DIDS']` (a JSON array string)",
          '- Input files are at `/data/inputs/<DID>/<filename>`',
          '- ALL outputs MUST be written to `/data/outputs/`',
          '- The script must exit with code 0 on success, non-zero on failure',
          '- Use `print(..., flush=True)` for logs so they appear in the job monitor',
          '',
          '## Template to build on:',
          '```python',
          PYTHON_TEMPLATE(safeName, taskDescription),
          '```',
          '',
          '## Dockerfile template:',
          '```dockerfile',
          PYTHON_DOCKERFILE_TEMPLATE(safeName),
          '```',
          '',
          '## requirements.txt template:',
          '```',
          PYTHON_REQUIREMENTS_TEMPLATE,
          '```',
          '',
          'Adapt the template to implement the described task. Add any necessary imports and dependencies.'
        ].join('\n')
      )
    }
  )

  server.registerPrompt(
    'new_c2d_algo_js',
    {
      description:
        'Generate a JavaScript/Node.js algorithm skeleton compatible with Ocean Compute-to-Data (C2D). Produces the .js file, Dockerfile, and package.json.',
      argsSchema: {
        algorithm_name: z
          .string()
          .describe('Name of the algorithm (used as the JS filename, no spaces)'),
        task_description: z
          .string()
          .describe('One sentence describing what the algorithm should do')
      }
    },
    (args) => {
      const { algorithm_name: algorithmName, task_description: taskDescription } = args
      const safeName = algorithmName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()

      return promptMessage(
        [
          `Generate an Ocean Compute-to-Data Node.js algorithm called "${safeName}" that: ${taskDescription}`,
          '',
          '## C2D Conventions (strictly follow these):',
          '- Input DIDs come from `process.env.DIDS` (a JSON array string)',
          '- Input files are at `/data/inputs/<DID>/<filename>`',
          '- ALL outputs MUST be written to `/data/outputs/`',
          '- The script must exit with `process.exit(0)` on success, non-zero on failure',
          '- Use `console.log()` for logs so they appear in the job monitor',
          '',
          '## Template to build on:',
          '```javascript',
          JS_TEMPLATE(safeName, taskDescription),
          '```',
          '',
          '## Dockerfile template:',
          '```dockerfile',
          JS_DOCKERFILE_TEMPLATE(safeName),
          '```',
          '',
          '## package.json template:',
          '```json',
          JS_PACKAGE_JSON_TEMPLATE(safeName),
          '```',
          '',
          'Adapt the template to implement the described task. Add any necessary imports and dependencies.'
        ].join('\n')
      )
    }
  )

  server.registerPrompt(
    'setup_node',
    {
      description:
        'Generate a complete Ocean Node configuration for running a node and qualifying for the incentive program.',
      argsSchema: {
        public_ip: z
          .string()
          .describe('The public IP address or domain of your server, e.g. 1.2.3.4'),
        private_key: z
          .string()
          .optional()
          .describe(
            'Node wallet private key (optional - use a placeholder if not ready)'
          ),
        has_gpu: z
          .boolean()
          .optional()
          .describe('Whether the server has a GPU (default: true)'),
        setup_method: z
          .enum(['docker', 'npm'])
          .optional()
          .describe("Deployment method: 'docker' (default) or 'npm' (for development)")
      }
    },
    (args) => {
      const {
        public_ip: publicIp,
        private_key: privateKey,
        has_gpu: rawHasGpu,
        setup_method: rawSetupMethod
      } = args
      const hasGpu = rawHasGpu ?? true
      const setupMethod = rawSetupMethod ?? 'docker'
      const key = privateKey ?? '0xYOUR_PRIVATE_KEY'
      const gpuResource = hasGpu
        ? '\n              {"id": "gpu", "price": 0.1, "total": 1, "min": 1, "max": 1}'
        : ''
      const gpuNote = hasGpu
        ? ''
        : '\n# GPU not configured. At least one GPU environment is required for incentive eligibility.'

      const dockerComposeEnvConfig = `
# Ocean Node - Environment Configuration

PRIVATE_KEY=${key}
RPCS={"8453": "https://mainnet.base.org"}
HTTP_API_PORT=8000

ALLOWED_ADMINS=["0xYOUR_ADMIN_WALLET"]

P2P_ANNOUNCE_ADDRESSES=["/ip4/${publicIp}/tcp/8000"]
P2P_ENABLE_IPV4=true
P2P_ipV4BindTcpPort=8001
P2P_ipV4BindWsPort=8002${gpuNote}
ENABLE_BENCHMARK=true
DOCKER_COMPUTE_ENVIRONMENTS=[
  {
    "socketPath": "/var/run/docker.sock",
    "resources": [
      {"id": "cpu",  "price": 0.05, "total": 4,   "min": 1,  "max": 4},
      {"id": "ram",  "price": 0.05, "total": 8192, "min": 512, "max": 8192},
      {"id": "disk", "price": 0.02, "total": 50,   "min": 1,  "max": 50}${gpuResource}
    ],
    "fees": {
      "8453 ": [
        {
          "feeToken": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "prices": [
            {"id": "cpu",  "price": 0.05},
            {"id": "ram",  "price": 0.05},
            {"id": "disk", "price": 0.02}${hasGpu ? ',\n            {"id": "gpu",  "price": 0.10}' : ''}
          ]
        }
      ]
    },
    "free": {
      "maxJobDuration": 300,
      "maxJobs": 1
    },
    "maxJobDuration": 3600,
    "minJobDuration": 30,
    "imageRetentionDays": 7,
    "storageExpiry": 604800,
    "enableNetwork": false,
    "scanImages": true
  }
]

LOG_LEVEL=info
LOG_CONSOLE=true
ESCROW_CLAIM_TIMEOUT=3600
`.trim()

      const setupBody =
        setupMethod === 'docker'
          ? `## Docker Setup

1. Save the above as \`.env\` in your project directory.
2. Download the \`docker-compose.yml\` from the Dashboard wizard or Ocean Node repo.
3. Start: \`docker-compose up -d\`
4. Verify: http://${publicIp}:8000/api/services/info`
          : `## NPM (Development) Setup

1. Save the above as \`.env\` in the ocean-node directory.
2. \`npm install && npm run build\`
3. \`npm run start\``

      return promptMessage(
        [
          'Generate a complete Ocean Node setup for the following configuration:',
          `- Public IP: ${publicIp}`,
          `- GPU available: ${hasGpu}`,
          `- Deployment method: ${setupMethod}`,
          '',
          '## Generated .env Configuration',
          '```env',
          dockerComposeEnvConfig,
          '```',
          '',
          setupBody,
          '',
          '## Post-Setup Eligibility Checklist',
          '1. Node version >= 3.1.1 - check at /api/services/info',
          '2. P2P reachable - the monitoring service will test this',
          '3. Base chain configured',
          `4. Compute pricing: current total = ${hasGpu ? '0.22' : '0.12'} USDC/min (< 1 USDC/min keeps you benchmark eligible)`,
          '5. GPU resource listed (required for incentives)',
          '6. ENABLE_BENCHMARK set to true in config',
          '',
          'Use the **check_node_eligibility** tool to validate your final configuration.',
          '',
          'Replace all placeholder values before starting the node.'
        ].join('\n')
      )
    }
  )

  server.registerPrompt(
    'publish_asset',
    {
      description:
        'Generate the CLI commands and metadata JSON to publish a dataset or algorithm to Ocean Network.',
      argsSchema: {
        asset_type: z.enum(['dataset', 'algorithm']).describe('Type of asset to publish'),
        name: z.string().describe('Name of the asset'),
        description: z.string().describe('Short description of the asset'),
        algo_language: z
          .enum(['python', 'javascript'])
          .optional()
          .describe('For algorithms: the programming language (default: python)')
      }
    },
    (args) => {
      const {
        asset_type: assetType,
        name,
        description,
        algo_language: rawAlgoLanguage
      } = args
      const algoLanguage = rawAlgoLanguage ?? 'python'
      const isAlgorithm = assetType === 'algorithm'
      const metadataFile = `metadata/${name.toLowerCase().replace(/\s+/g, '-')}.json`
      const template = isAlgorithm
        ? ALGO_METADATA_TEMPLATE(name, description, algoLanguage)
        : DATASET_METADATA_TEMPLATE(name, description)

      return promptMessage(
        `
## Publish ${isAlgorithm ? 'Algorithm' : 'Dataset'}: "${name}"

### Step 1 - Set Environment Variables
\`\`\`bash
export PRIVATE_KEY=0xYOUR_PRIVATE_KEY
export RPC=https://mainnet.base.org
export NODE_URL=http://YOUR_NODE_URL:8000
\`\`\`

### Step 2 - Create Metadata File
Save the following as \`${metadataFile}\`:

\`\`\`json
${template}
\`\`\`

### Step 3 - Publish
\`\`\`bash
${isAlgorithm ? `npm run cli publishAlgo ${metadataFile}` : `npm run cli publish ${metadataFile}`}
\`\`\`

### Step 4 - Follow-up
- Save the returned DID.
- Update metadata later with \`npm run cli editAsset --did did:op:YOUR_DID --file ${metadataFile}\`.
${isAlgorithm ? '- Whitelist the algorithm on target datasets before running C2D jobs.' : '- Whitelist trusted algorithms on your dataset as needed.'}
`.trim()
      )
    }
  )

  server.registerPrompt(
    'run_service',
    {
      description:
        'Rent a long-running container service on an Ocean node end to end: find a service-capable environment, estimate cost, provision escrow, start, poll to Running, and hand back reachable endpoint URLs.',
      argsSchema: {
        goal: z
          .string()
          .describe(
            'What the service should be, e.g. "a vLLM server for Qwen2-0.5B" or "a Postgres instance for 2 hours"'
          ),
        node_peer_id: z
          .string()
          .optional()
          .describe('Target node peerID. Omit to discover one with findServiceNodes.'),
        duration_hours: z
          .string()
          .optional()
          .describe('How long the service should stay up (default: 1)')
      }
    },
    (args) => {
      const { goal, node_peer_id: nodePeerId, duration_hours: durationHours } = args
      const hours = Number(durationHours ?? '1')
      const durationSeconds = Math.max(
        60,
        Math.round((Number.isFinite(hours) ? hours : 1) * 3600)
      )

      return promptMessage(
        [
          `Start an Ocean Service-on-Demand for: ${goal}`,
          '',
          'Read the **ocean://docs/service-on-demand** resource first if you have not already —',
          'services behave very differently from compute jobs.',
          '',
          '## Steps',
          nodePeerId
            ? `1. **Pick the environment.** Call \`findServiceEnvironments\` on node \`${nodePeerId}\` with the chainId and fee token the user intends to pay with. Pick an env with \`eligible: true\`; if none is, report each env's \`mismatchReason\` rather than silently giving up.`
            : '1. **Find a node and environment.** Call `findServiceNodes` (optionally seeded with `list_discovered_peers` or `incentives_list_nodes`), then `findServiceEnvironments` on a promising peer. Only some nodes have services enabled — an unreachable peer is skipped, not a failure.',
          '2. **Optional starting point.** `getServiceTemplates` shows what the operator suggests. Use the returned `serviceStartArgs` projection verbatim — do **not** hand-copy `command`/`entrypoint` from `template`, they are `dockerCmd`/`dockerEntrypoint` on start and are silently dropped under their template names. An empty catalogue is normal; bring your own image instead.',
          `3. **Estimate the cost.** \`estimateServiceCost\` with the env, \`duration: ${durationSeconds}\`, chainId, token and resources. Report the figure as an **estimate** — there is no server-side quote. Denominate it with \`get_erc20_token_info\` before showing it; never format raw base units yourself.`,
          '4. **Provision escrow.** Feed the returned `payment` object straight into `escrow_preflight` with `maxJobDuration = duration`. If `escrowRequired` came back `false`, skip this step entirely. With a private key it auto-deposits and authorizes; otherwise show the Manage-escrow redirect and stop until the user has done it.',
          `5. **Start.** \`serviceStart\` with the env, container spec, \`duration: ${durationSeconds}\` and \`payment\`. Confirm the whole cost is committed up front and there is no refund for stopping early. Ports the container listens on must be ≥ 1024.`,
          '6. **Poll.** `serviceStatus` every ~5–10s until status `40` — **without asking the user between polls**. Image pulls and builds take minutes. `50 Stopping` is not an end state; keep going to `70`. Terminal failures are `12, 14, 15, 99`.',
          '7. **Hand over.** Report each `endpoints[].url` as returned, the `expiresAtIso`, and that the endpoints are **not authenticated by the node** — anyone with the URL can reach the container.',
          '',
          '## Afterwards',
          '- `serviceLogs` (with a bounded `since`, default 5m) to debug a container that is up but misbehaving.',
          '- `serviceExtend` to lengthen the window — it bills the additional duration alone, priced off the **stored** job resources and environment (read both from `serviceStatus`).',
          '- `serviceRestart` to bounce it. No container params = REUSE the stored spec. Any container param = RESPEC, where `image` is mandatory and anything omitted is empty rather than inherited — so to change one thing, re-send the whole spec.',
          '- `serviceStop` tears the container down but **keeps the paid reservation** until `expiresAt`. It does not refund and does not free capacity — do not offer it as a way to save money.',
          '',
          'If the user passes secrets (API keys, HF tokens) as `userData`, warn that the values transit this conversation, prefer short-lived tokens, and note that the node strips `userData` from every response so they can never be read back.'
        ].join('\n')
      )
    }
  )
}
