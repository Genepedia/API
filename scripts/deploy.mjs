#!/usr/bin/env node
// Cross-platform deploy: uploads the API's PHP files to the live cPanel document
// root via the cPanel UAPI (Fileman::save_file_content) over HTTPS port 2083.
// Works on Windows and Linux with no npm dependencies.
//
// WHY THIS EXISTS: SSH and FTP are blocked on this host, but the cPanel API port
// (2083) is open and serves a valid TLS certificate for api.shaunroselt.com.
//
// USAGE:
//   1. Create a cPanel API token: cPanel -> "Manage API Tokens" -> Create.
//   2. Put it in your shell environment (NEVER commit it):
//        Windows PowerShell:  $env:CPANEL_API_TOKEN = 'your-token-here'
//        Linux/macOS bash:    export CPANEL_API_TOKEN='your-token-here'
//   3. Run from the API repo root:  node scripts/deploy.mjs
//
// Optional overrides (env): CPANEL_HOST, CPANEL_PORT, CPANEL_USER, CPANEL_DEPLOY_DIR

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import https from 'node:https';

const HOST = process.env.CPANEL_HOST || 'api.shaunroselt.com';
const PORT = Number(process.env.CPANEL_PORT || '2083');
const USER = process.env.CPANEL_USER || 'shauncpv';
const DEPLOY_DIR = process.env.CPANEL_DEPLOY_DIR || '/home/shauncpv/api.shaunroselt.com/genepedia';
const TOKEN = process.env.CPANEL_API_TOKEN || '';

if (!TOKEN) {
  console.error('ERROR: CPANEL_API_TOKEN is not set. Create a cPanel API token and export it first.');
  process.exit(2);
}

// The API repo root is the parent of this scripts/ folder.
const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = readdirSync(apiRoot).filter((name) => name.endsWith('.php')).sort();
try {
  statSync(join(apiRoot, '.user.ini'));
  files.push('.user.ini');
} catch {
  // .user.ini is optional.
}

if (files.length === 0) {
  console.log('No deployable files found at the repo root.');
  process.exit(0);
}

function upload(file) {
  return new Promise((done) => {
    const content = readFileSync(join(apiRoot, file), 'utf8');
    const body = new URLSearchParams({ dir: DEPLOY_DIR, file, content }).toString();
    const req = https.request(
      {
        host: HOST,
        port: PORT,
        path: '/execute/Fileman/save_file_content',
        method: 'POST',
        headers: {
          Authorization: `cpanel ${USER}:${TOKEN}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let ok = false;
          let detail = '';
          try {
            const json = JSON.parse(data);
            const result = json.result ?? json;
            ok = res.statusCode === 200 && String(result.status) === '1';
            if (!ok) detail = JSON.stringify(result.errors ?? result).slice(0, 300);
          } catch {
            detail = `non-JSON response (http ${res.statusCode})`;
          }
          done({ file, ok, detail });
        });
      },
    );
    req.on('error', (err) => done({ file, ok: false, detail: err.message }));
    req.write(body);
    req.end();
  });
}

console.log(`Deploying ${files.length} file(s) to ${DEPLOY_DIR} on ${HOST} ...`);
let failures = 0;
for (const file of files) {
  const result = await upload(file);
  if (result.ok) {
    console.log(`  ok    ${file}`);
  } else {
    console.error(`  FAIL  ${file} -> ${result.detail}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed to deploy.`);
  process.exit(1);
}
console.log(`\nDeployment complete: ${files.length} file(s) updated on the server.`);
