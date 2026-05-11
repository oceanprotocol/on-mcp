# on-mcp

**on-mcp** is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for the [Ocean Protocol](https://oceanprotocol.com/) network. It exposes Ocean **ocean-node** and **libp2p** capabilities as MCP **tools** and **resources**, so coding agents and other MCP clients can discover providers, run compute jobs, resolve DIDs, manage persistent storage, and perform other P2P operations through a consistent, schema-driven interface.

The server name reported to clients is `ocean-mcp` (see `src/server/createServer.ts`).

---

## What it does

- **P2P-first:** On startup the process joins the Ocean libp2p network (with configurable bootstrap peers). Most operations talk to **ocean-node** instances over **libp2p** via `@oceanprotocol/lib` (`ProviderInstance` / `P2pProvider`), not only over HTTP to a single gateway.
- **MCP tools:** Dozens of tools wrap node status, DHT `find_provider` discovery (including C2D capacity search strings), DDO resolution and validation, compute lifecycle (initialize, start, stop, status, results, logs), downloads, encryption helpers, auth tokens, policy-server flows, persistent storage, admin config, and peer utilities.
- **MCP resources:** Static documentation is exposed for C2D provider discovery (URI `ocean://docs/c2d-find-provider-search`) so agents can fetch how `find_provider` and `buildFindProviderC2dContent` align with ocean-node announcements.
- **Transports:** Supports **stdio** (typical for local editors and Claude Desktop) and **Streamable HTTP** (`MCP_TRANSPORT=sse`) for remote or containerized deployments.
- **EVM (optional):** If `EVM_CHAIN_RPCS` is set, the process builds an ethers **FallbackProvider** per chain; upcoming tools will use these for on-chain operations.

---

## Architecture (high level)

| Piece | Role |
|--------|------|
| `src/index.ts` | Chooses transport (stdio vs HTTP), initializes libp2p (`ProviderInstance.setupP2P`), optional HTTP app on `MCP_HOST` / `MCP_PORT`. |
| `src/server/createServer.ts` | Builds the `McpServer`, wires `NodeClient`, registers tools and resources. |
| `src/clients/nodeClient.ts` | Thin wrapper around `ProviderInstance` P2P APIs (status, compute, storage, DDO, fees, etc.). |
| `src/tools/p2pProviderTools.ts` | Registers all active MCP tools (Zod schemas, descriptions for agents). |
| `src/resources/registerResources.ts` | Registers MCP resources (markdown docs). |
| `src/config/env.ts` | Reads `NODE_URL`, `RPC`, `CHAIN_ID` for server-side config (defaults and chain context). |
| `src/evm/chainRpcConfig.ts` | Parses `EVM_CHAIN_RPCS` JSON into per-chain RPC URL lists. |
| `src/evm/evmProviderRegistry.ts` | One ethers `FallbackProvider` per configured chain (singleton, initialized in `main`). |


---

## Requirements

- **Node.js 22** (see `.nvmrc`).
- Network access for libp2p bootstrap and peer connections.
- A **private key** for signing where the protocol requires it. If `PRIVATE_KEY` is unset, the server generates an **ephemeral** key and logs a warning—fine for experiments, not for production identities.

---

## Install and build

```bash
nvm use   # if you use nvm
npm ci
npm run build
```

Output is emitted to `dist/`. Typecheck only: `npm run type-check`.

---

## Run locally

### Stdio (default): editor and CLI MCP clients

```bash
npm start
# or
node --max-old-space-size=28784 --trace-warnings --experimental-specifier-resolution=node dist/index.js
```

Ensure `MCP_TRANSPORT` is unset or not `sse` so the server uses stdio.

### Streamable HTTP: remote access or Docker

```bash
export MCP_TRANSPORT=sse
export MCP_HOST=0.0.0.0    # listen on all interfaces
export MCP_PORT=3000
npm start
```

The MCP HTTP endpoint is **`http://<host>:<port>/mcp`** (and `/` is also wired for the same handler). Clients must support **Streamable HTTP** transport where used.

### Development (TypeScript without full build)

```bash
npm run dev:server
```

For MCP Inspector–style debugging:

```bash
npm run dev
```

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PRIVATE_KEY` | Hex private key for p2p node. If omitted, a random ephemeral key is generated. |
| `BOOTSTRAP_PEERS` | Comma-separated libp2p multiaddrs **prepended** to the built-in Ocean bootstrap list (passing custom peers replaces library defaults, so extras are merged with Ocean defaults in code). |
| `MCP_TRANSPORT` | `stdio` (default) or `sse` for Streamable HTTP. |
| `MCP_HOST` | Bind address for HTTP mode (default `127.0.0.1`). |
| `MCP_PORT` | Port for HTTP mode (default `3000`). |
| `EVM_CHAIN_RPCS` | Optional JSON object mapping **chain id strings** to **arrays of RPC URLs** (primary first, fallbacks next). Used to build an ethers v6 `FallbackProvider` per chain for EVM tools. Example (shell-safe quoting) with public RPCs for **mainnet (1)**, **sepolia (11155111)**, **base (8453)**, **optimism (10)**: `EVM_CHAIN_RPCS='{"1":["https://cloudflare-eth.com","https://rpc.ankr.com/eth"],"11155111":["https://rpc.sepolia.org","https://rpc.ankr.com/eth_sepolia"],"8453":["https://mainnet.base.org","https://base.publicnode.com"],"10":["https://mainnet.optimism.io","https://optimism.publicnode.com"]}'`. Empty or unset means no EVM providers are registered. Invalid JSON causes startup to fail. |

---

## Docker

Build and run (HTTP mode is the default in the image):

```bash
docker build -t on-mcp .
docker run --rm -p 3000:3000 on-mcp
```

Set a wallet and optional bootstrap peers:

```bash
docker run --rm -p 3000:3000 \
  -e PRIVATE_KEY=0x... \
  -e BOOTSTRAP_PEERS=/ip4/.../p2p/... \
  on-mcp
```

For stdio MCP (e.g. wiring the container to a host process), override transport and drop port publishing as needed:

```bash
docker run --rm -i -e MCP_TRANSPORT=stdio on-mcp
```

Override transport or port as needed for HTTP, for example `-e MCP_PORT=8080 -p 8080:8080`.

---

## MCP tools (overview)

Tools are defined in `src/tools/`. Names are stable identifiers for agents and client configs. Current tool ids include:

**Peers and discovery:** `mcp_server_peers`, `find_provider`, `buildFindProviderC2dContent`, `list_discovered_peers`, `resolve_peer_multiaddr`, `is_valid_provider`, `cid_from_raw_string`

**Node and DDO:** `node_status`, `getComputeEnvironments`, `resolveDdo`, `validateDdo`, `getNodeJobs`, `getNonce`, `getFileInfo`, `check_did_files`

**Compute:** `initializeCompute`, `computeStart`, `freeComputeStart`, `computeStop`, `computeStatus`, `getComputeResult`, `get_compute_result_url`, `compute_streamable_logs`, `downloadNodeLogs`

**Storage and downloads:** `createPersistentStorageBucket`, `getPersistentStorageBuckets`, `listPersistentStorageFiles`, `getPersistentStorageFileObject`, `deletePersistentStorageFile`, `upload_persistent_storage_file`, `get_download_fees`, `download_asset_file`

**Auth and crypto:** `create_auth_token`, `p2p_encrypt`

**Policy server:** `policy_server_passthrough`, `policy_server_initialize_verification`

**Admin / config:** `fetch_node_config`, `push_node_config`

**Resource access (for tool-only clients):** `list_resources`, `get_resource`

**EVM escrow and access lists:** `broadcast_transaction`, `escrow_get_funds`, `escrow_get_user_funds`, `escrow_get_user_tokens`, `escrow_get_locks`, `escrow_get_authorizations`, `escrow_deposit`, `escrow_withdraw`, `escrow_authorize`, `accesslist_get_details`, `accesslist_get_token_uri`, `accesslist_mint`, `accesslist_factory_is_deployed`, `accesslist_factory_deploy`

Many tools require targeting a peer via **`nodeId`** and/or **`multiaddress`** (see schemas in `src/tools/p2pSchemas.ts`). Operations that mutate state or access paid resources typically need **`authToken`** or a **`completeSignature`** payload—follow each tool’s description and `P2P_AUTH_SIGNING_GUIDE` in code.

---

## MCP resources

| Name | URI | Content |
|------|-----|--------|
| `c2d-find-provider-search` | `ocean://docs/c2d-find-provider-search` | Markdown: how C2D provider strings are advertised and how to combine `find_provider` results for multi-dimensional requirements. |
| `evm-supported-chains` | `ocean://evm/supported-chains` | JSON: configured EVM chains with latest block number and block timestamp from each chain's fallback provider. |

If your MCP client only shows **tools** (not resources), use `list_resources` and `get_resource` to discover and fetch these same contents.

Agents should **`read_resource`** on this URI when planning C2D discovery or intersecting multiple `find_provider` queries.

---

## Using with AI clients

This section describes how to attach **on-mcp** to common agent hosts. Exact UI paths change between product versions; if a menu differs, look for **MCP**, **Model Context Protocol**, or **Tools** in settings.

### General guidance (all agents)

1. **Build the project** (`npm run build`) unless you point the client at `tsx`/dev entrypoints.
2. Prefer a **fixed `PRIVATE_KEY`** when you need stable signatures across restarts.
3. Ensure **bootstrap connectivity** so libp2p can reach Ocean peers (firewall/NAT allowing outbound WebSocket to bootstrap hosts).
4. For **C2D discovery**, use `buildFindProviderC2dContent` → `find_provider`, and read the **`ocean://docs/c2d-find-provider-search`** resource for compound CPU/RAM/GPU queries.
5. Check **`node_status`** for **persistent storage** capabilities before using bucket/file tools.

### Cursor

1. Open **Cursor Settings → MCP** (or **Features → MCP**), or edit the MCP configuration file if your build exposes one (often under the user config directory for Cursor).
2. Add a server that runs the **compiled** entrypoint with **stdio**:

```json
{
  "mcpServers": {
    "ocean-mcp": {
      "command": "node",
      "args": [
        "--max-old-space-size=8192",
        "--trace-warnings",
        "--experimental-specifier-resolution=node",
        "/ABSOLUTE/PATH/TO/on-mcp/dist/index.js"
      ],
      "env": {
        "PRIVATE_KEY": "0xYOUR_KEY",
        "NODE_URL": "http://localhost:8000"
      }
    }
  }
}
```

3. Use **`cwd`** only if your install requires it; otherwise `args` may use a path relative to the project after `npm run build`.
4. Do **not** set `MCP_TRANSPORT=sse` for stdio—leave it unset for the default stdio transport.
5. After saving, restart Cursor or reload MCP servers so the new server appears. Enable **ocean-mcp** for the workspace or chat where you need Ocean tools.

For **remote HTTP** MCP (if your Cursor version supports URL-based Streamable HTTP servers), point the client at `http://<host>:<port>/mcp` with the transport your UI specifies; run the server with `MCP_TRANSPORT=sse` and reachable `MCP_HOST` / `MCP_PORT`.

### VS Code and GitHub Copilot (MCP-capable setups)

Recent VS Code builds and extensions can register MCP servers in **`mcp.json`** (user or workspace) or in settings under MCP-related keys, depending on version.

1. Install or enable the **MCP** support your workflow uses (built-in or extension).
2. Register a server using the same **`command` / `args` / `env`** pattern as in the Cursor example, with paths adjusted for your machine.
3. When using **GitHub Copilot** as the chat agent, ensure the Copilot session is allowed to use **MCP tools** for that workspace (policy depends on org and extension settings).

Because product names and settings move quickly, if the UI does not match: search the VS Code docs for **“MCP server configuration”** and mirror the documented JSON shape, substituting the `ocean-mcp` `command` and `args` above.

### Claude Desktop (Anthropic)

Edit the Claude Desktop MCP config (platform-specific path, e.g. macOS `~/Library/Application Support/Claude/claude_desktop_config.json`) and add a `mcpServers` entry with the same **`command`**, **`args`**, and **`env`** as for Cursor. Restart Claude Desktop after changes.

### Other agents and custom clients

Any MCP client that supports:

- **Stdio:** spawn `node … dist/index.js` with the env vars you need.
- **Streamable HTTP:** connect to `http://<host>:<port>/mcp` with session handling as required by `@modelcontextprotocol/sdk` (initialize POST, then session id on subsequent requests).

For **headless automation**, run the HTTP server and use an MCP client library that speaks Streamable HTTP to the same URL.

---

## Logging

`console.error` and libp2p stderr are redirected to **`debug.log`** in the process working directory (`src/index.ts`). Check this file when diagnosing connection or protocol errors.

---

## Scripts (npm)

| Script | Description |
|--------|-------------|
| `npm run build` | Clean `dist/`, compile TypeScript. |
| `npm start` | Run compiled server (`dist/index.js`). |
| `npm run dev` | MCP Inspector + `tsx` on `src/index.ts`. |
| `npm run dev:server` | `tsx src/index.ts` without Inspector. |
| `npm run lint` | ESLint + `tsc --noEmit`. |
| `npm test` | Lint and tests (see `package.json` for full pipeline). |

---

## License

Apache-2.0. See `package.json` for metadata and issue tracker links.

---

## Contributing and issues

Report issues at the repository linked from `package.json` (`bugs.url`). When opening bug reports, include relevant **`debug.log`** snippets (redact keys), transport mode (stdio vs HTTP), and whether libp2p peers were reachable.
