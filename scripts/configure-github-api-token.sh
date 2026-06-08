#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${ROOT_DIR}/.env.example" "${ENV_FILE}"
  echo "Created ${ENV_FILE} from .env.example"
fi

if [[ "${1:-}" == "" ]]; then
  echo "Paste a GitHub personal access token with read access to the Genepedia repository."
  echo "Create one at: https://github.com/settings/tokens"
  echo "Classic PAT scope: public_repo"
  echo "Fine-grained PAT: Contents (Read) + Metadata (Read) on Genepedia/Genepedia"
  echo
  read -r -s -p "GITHUB_API_TOKEN: " TOKEN
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
updated = False
found = False
output = []

for line in lines:
    if re.match(r"^\s*GITHUB_API_TOKEN=", line):
        output.append(f"GITHUB_API_TOKEN={token}")
        updated = True
        found = True
    else:
        output.append(line)

if not found:
    if output and output[-1].strip() != "":
        output.append("")
    output.append("# Server token for commit history (5,000 GitHub API requests/hour)")
    output.append(f"GITHUB_API_TOKEN={token}")
    updated = True

env_path.write_text("\n".join(output) + "\n", encoding="utf-8")
print(f"Updated {env_path}")
PY

echo
echo "Next steps:"
echo "1. Copy the updated API files and .env to api.shaunroselt.com"
echo "2. Verify: curl -s 'https://api.shaunroselt.com/genepedia/github-config.php'"
