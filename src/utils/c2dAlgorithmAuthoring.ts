/** Markdown for MCP resource `ocean://docs/c2d-algorithm-authoring`. */
export const C2D_ALGORITHM_AUTHORING_MARKDOWN = `## Authoring a C2D algorithm (rawcode + prebuilt image)

The simplest way to run a Compute-to-Data (C2D) job is a **published \`oceanprotocol/c2d_examples\` image + inline \`rawcode\`** — no Docker build, no image push, no algorithm publish. Pick one of our images, paste your source as \`rawcode\`, submit. You **can** bring your own image, but only if you need libraries our images do not ship; starting with ours is easier.

### Pick a base image (match your imports)
Every image ships the language's **standard library** plus the third-party packages below. **Compare the algorithm's imports against these lists** and pick the **smallest** image that covers them — do not run an extra lookup, these are the contents. Lists are from \`oceanprotocol/c2d-examples\` (per-image \`requirements.txt\` / \`package.json\`), current 2026-05-27; verify there only if a match is borderline.

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
- **If any import is not covered by the chosen image, do not assume it is present.** Tell the user our prebuilt images lack that dependency and they should build and push their own image, then set \`container.image\` / \`tag\` / \`checksum\` to it. That is the only case where a custom image is needed.

Set \`checksum\` to the image's \`sha256\` digest. **Digests change whenever an image is rebuilt**, so confirm the current value by web-fetching the tags page \`hub.docker.com/r/oceanprotocol/c2d_examples/tags\` (or its API \`hub.docker.com/v2/repositories/oceanprotocol/c2d_examples/tags\`) before submitting. Digests observed 2026-05-26:
- \`py-lite\` → \`sha256:951799c978e94fb4138a8cba615b3ce718594f695e2c4dbbd2dbe83ed9407308\`
- \`py-general\` → \`sha256:2db2eb92bc92bcbd1bfbc4fd08de099d3f34594efddc474a82dd29126fa3698f\`
- \`py-panda\` → \`sha256:24a621eccc7cefdbc040017bc750dde657aae94b5583784497e4e813138c55fd\`
- \`py-sql\` → \`sha256:bc64ba614dc7a06fb30fdd3455a5eb71aaba9da48ca4325c68d3646c6ec8439b\`
- \`js-general\` → \`sha256:67a980bf617e1a8f288db4385bb94b1caf34698e5e7a5c351ebc315e0e749f80\`

### The algorithm object
Pass this as the **algorithm** argument to \`computeStart\` / \`freeComputeStart\`:
\`\`\`json
{
  "meta": {
    "container": {
      "image": "oceanprotocol/c2d_examples",
      "tag": "py-general",
      "checksum": "sha256:2db2eb92bc92bcbd1bfbc4fd08de099d3f34594efddc474a82dd29126fa3698f",
      "entrypoint": "python $ALGO"
    },
    "rawcode": "<your full source as a string>"
  }
}
\`\`\`
The node writes your \`rawcode\` to \`/data/transformations/algorithm\` and substitutes \`$ALGO\` in the entrypoint with that path. Use \`node $ALGO\` for JavaScript.

### Filesystem inside the container
- \`/data/inputs/\` — **walk recursively**. Layout is \`/data/inputs/<DID>/<file>\` for DID assets, or \`/data/inputs/<file>\` for URL \`fileObject\` inputs. **Skip \`algoCustomData.json\`** (it is custom job data, not a dataset file).
- \`/data/outputs/\` — write results here; the whole directory is returned as **\`outputs.tar\`**. Files written anywhere else are lost.
- env \`DIDS\` — JSON array string of input DIDs. May be \`"[]"\` or unset when all inputs are URL \`fileObject\`s.

### Constraints
- Use the **standard library** or whatever the chosen image ships. **No \`pip install\` / \`npm install\` at runtime** — the container has no network for installs.
- **Exit 0** = success; non-zero = failure.
- Anything written to **stdout** is captured as **\`algorithm.log\`**.

### Validate before submitting
Run the **validate_algo_structure** tool on your source to catch common mistakes (missing \`DIDS\` read, wrong input/output paths, missing exit code) before submitting.

### Auth for free compute
Free compute needs an auth token but **no on-chain transaction** (no escrow, no payment). You do **not** sign anything by hand — \`create_auth_token\` mints the JWT internally:
1. **create_auth_token** with \`ephemeral: true\` (a throwaway key is fine — free compute needs no funds), or pass the user's own \`privateKey\`. Returns a **JWT**.
2. Pass the JWT as \`authToken\` to **freeComputeStart**.

(If the user already has a JWT, skip this and pass it straight to \`freeComputeStart\` as \`authToken\`.)

### Targeting the node
Pass **\`multiaddress\`** explicitly — a bare \`nodeId\` often fails to dial. Use the node's **own announced multiaddr** from \`find_provider\`, \`node_status\`, or peer discovery; do not hardcode one. Host, port, and transport vary per node — the shape looks like \`["/dns4/<host>/tcp/<port>/ws/p2p/<peerId>"]\`, but the port is **not** always 9001.
`
