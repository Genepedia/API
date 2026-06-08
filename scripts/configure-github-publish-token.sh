#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Create it from the API repository template first." >&2
  exit 1
fi

if [[ "${1:-}" == "" ]]; then
  echo "Paste a GitHub personal access token with WRITE access to Genepedia/Genepedia."
  echo "Create one at: https://github.com/settings/tokens"
  echo
  echo "Fine-grained PAT:"
  echo "  Repository access: Only select Genepedia/Genepedia"
  echo "  Contents: Read and write"
  echo "  Pull requests: Read and write"
  echo "  Metadata: Read-only"
  echo
  echo "Classic PAT:"
  echo "  Scope: public_repo"
  echo
  echo "If the Genepedia organization uses SSO, authorize the token after creating it."
  echo
  read -r -s -p "GITHUB_PUBLISH_TOKEN: " TOKEN
  echo
else
  TOKEN="$1"
fi

TOKEN="$(printf '%s' "${TOKEN}" | tr -d '[:space:]')"
if [[ "${TOKEN}" == "" ]]; then
  echo "No token provided." >&2
  exit 1
fi

python3 - "${ENV_FILE}" "${TOKEN}" <<'PY'
import pathlib
import re
import sys

env_path = pathlib.Path(sys.argv[1])
token = sys.argv[2]
lines = env_path.read_text(encoding="utf-8").splitlines()
found = False
output = []

for line in lines:
    if re.match(r"^\s*GITHUB_PUBLISH_TOKEN=", line):
        output.append(f"GITHUB_PUBLISH_TOKEN={token}")
        found = True
    else:
        output.append(line)

if not found:
    if output and output[-1].strip() != "":
        output.append("")
    output.append("# Server token for page publishing")
    output.append(f"GITHUB_PUBLISH_TOKEN={token}")

env_path.write_text("\n".join(output) + "\n", encoding="utf-8")
print(f"Updated {env_path}")
PY

echo
echo "Next steps:"
echo "1. Copy the updated API files and .env to api.shaunroselt.com"
echo "2. Verify: curl -s 'https://api.shaunroselt.com/genepedia/github-config.php'"
