/** Markdown for MCP resource `ocean://docs/c2d-algorithm-authoring`. */
export const C2D_ALGORITHM_AUTHORING_MARKDOWN = `## Authoring a C2D algorithm (rawcode + prebuilt image)

Run C2D with a **published \`oceanprotocol/c2d_examples\` image + inline \`rawcode\`** — no Docker build/push/publish. **Use exactly one of the five tags below — never \`latest\` or any other tag/image.** If unsure, pick the closest from the table.

### Pick a base image (closed list)
Each image ships the language stdlib plus the packages below. Pick the **smallest** image that covers the algorithm's imports.

| Tag | Third-party packages (import name in parens where it differs) |
|-----|---------------------------------------------------------------|
| \`py-lite\` | \`web3\`, \`requests\`, \`opencv-python\` (\`cv2\`) |
| \`py-panda\` | \`numpy\`, \`pandas\`, \`scikit-learn\` (\`sklearn\`), \`matplotlib\`, \`openpyxl\`, \`xlrd\`, \`python-dateutil\` (\`dateutil\`), \`pytz\`, \`six\` |
| \`py-sql\` | \`numpy\`, \`pandas\`, \`requests\`, \`SQLAlchemy\` (\`sqlalchemy\`), \`PyMySQL\` (\`pymysql\`) — pinned to older versions (numpy 1.19, pandas 1.1) |
| \`py-general\` | broad ML/CV stack: \`numpy\`, \`pandas\`, \`torch\`, \`tensorflow\`, \`keras\`, \`keras-unet-collection\`, \`yolov5\`, \`albumentations\`, \`opencv-python\` (\`cv2\`), \`Pillow\` (\`PIL\`), \`matplotlib\`, \`plotly\`, \`reportlab\`, \`SQLAlchemy\` (\`sqlalchemy\`), \`requests\`, \`web3\` |
| \`js-general\` | \`ethers\`, \`web3\`, \`axios\`, \`bignumber.js\`, \`@tensorflow/tfjs-node\`, \`@tensorflow/tfjs-core\`, \`face-api.js\`, \`node-vibrant\`, \`sharp\`, \`canvas\`, \`fluent-ffmpeg\`, \`path\` |

**Choosing:**
- Only stdlib (optionally \`web3\` / \`requests\` / \`cv2\`) → **\`py-lite\`** (smallest, fastest pull).
- pandas / numpy / scikit-learn data work → **\`py-panda\`**.
- SQL / database clients → **\`py-sql\`**.
- Deep learning / computer vision (\`torch\`, \`tensorflow\`, \`keras\`, \`yolov5\`, \`cv2\`, \`PIL\`) → **\`py-general\`**.
- Node.js → **\`js-general\`**.
- **If an import isn't covered, do NOT invent tags** (no \`latest\`, no other names). Pick the closest tag above, tell the user which library is missing, and let them decide.

**Omit \`checksum\`** — submitting against the curated tags works without a digest, and a stale digest only causes pull failures.

### The algorithm object
Pass this as the **algorithm** argument to \`computeStart\` / \`freeComputeStart\`:
\`\`\`json
{
  "meta": {
    "container": {
      "image": "oceanprotocol/c2d_examples",
      "tag": "py-general",
      "entrypoint": "python $ALGO"
    },
    "rawcode": "<your full source as a string>"
  }
}
\`\`\`
The node writes your \`rawcode\` to \`/data/transformations/algorithm\` and substitutes \`$ALGO\` in the entrypoint with that path. Use \`node $ALGO\` for JavaScript.

### Filesystem inside the container
- \`/data/inputs/\` — **walk recursively**. Layout is \`/data/inputs/<DID>/<file>\` for DID assets, or \`/data/inputs/<file>\` for URL \`fileObject\` inputs. **Skip \`algoCustomData.json\`** (it is custom job data, not a dataset file).
- \`/data/persistentStorage/<bucketId>/<fileName>\` — **\`nodePersistentStorage\`** inputs mount here (not under \`/data/inputs/\`). Read by exact path.
- \`/data/outputs/\` — write results here; the whole directory is returned as **\`outputs.tar\`**. Files written anywhere else are lost.
- env \`DIDS\` — JSON array string of input DIDs. May be \`"[]"\` or unset when all inputs are URL \`fileObject\`s.

### Constraints
- Use the **standard library** or whatever the chosen image ships. **No \`pip install\` / \`npm install\` at runtime** — the container has no network for installs.
- **Exit 0** = success; non-zero = failure.
- Anything written to **stdout** is captured as **\`algorithm.log\`**.

### Validate before submitting
Run the **validate_algo_structure** tool on your source to catch common mistakes (missing \`DIDS\` read, wrong input/output paths, missing exit code) before submitting.

### Auth for free compute
Free compute needs a JWT but no on-chain transaction. If the user has a JWT, pass it as \`authToken\` to **freeComputeStart**. Otherwise call **create_auth_token** with \`ephemeral: true\` (or the user's \`privateKey\`) and pass the returned JWT.

### Targeting the node
Pass **\`multiaddress\`** explicitly — a bare \`nodeId\` often fails to dial. Use the node's **own announced multiaddr** from \`find_provider\`, \`node_status\`, or peer discovery; do not hardcode one. Host, port, and transport vary per node — the shape looks like \`["/dns4/<host>/tcp/<port>/ws/p2p/<peerId>"]\`, but the port is **not** always 9001.
`
