#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dist_root="$project_root/dist"

rm -rf "$dist_root"
mkdir -p "$dist_root/server" "$dist_root/.openai"
cp "$project_root/worker/index.js" "$dist_root/server/index.js"
cp "$project_root/.openai/hosting.json" "$dist_root/.openai/hosting.json"
node --input-type=module - "$project_root" "$dist_root/server/index.js" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";

const projectRoot = process.argv[2];
const workerPath = process.argv[3];
const marker = 'const OPENAPI_SPEC_JSON = "__OPENAPI_SPEC_JSON__";';
const [worker, openapi] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(`${projectRoot}/openapi.json`, "utf8"),
]);
if (!worker.includes(marker)) throw new Error("Worker OpenAPI injection marker is missing.");
await writeFile(workerPath, worker.replace(marker, `const OPENAPI_SPEC_JSON = ${JSON.stringify(openapi)};`));
NODE

echo "Built $dist_root"
