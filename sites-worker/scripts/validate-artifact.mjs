import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");
const openApiPath = resolve(projectRoot, "openapi.json");

const [source, manifest, openApiText] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
  readFile(openApiPath, "utf8"),
]);
JSON.parse(manifest);
const openApi = JSON.parse(openApiText);
assert.equal(openApi.openapi, "3.1.0");
assert.equal(openApi.servers[0]?.url, "https://api.genepedia.org/v1");
for (const route of [
  "/genepedia/auth/github/config",
  "/genepedia/auth/session",
  "/genepedia/files/commits",
  "/genepedia/page-edits",
  "/gravepedia/memorials",
  "/auth/github/callback",
]) {
  assert.ok(openApi.paths[route], `OpenAPI contract is missing ${route}`);
}
assert.equal(Object.keys(openApi.paths).some((path) => path.includes(".php")), false, "published OpenAPI paths must not expose file extensions");
assert.deepEqual(Object.keys(openApi.paths["/genepedia/profiles/self"] || {}).sort(), ["post"]);
assert.deepEqual(Object.keys(openApi.paths["/genepedia/statistics/flush"] || {}).sort(), ["get", "post"]);
assert.equal(openApi.paths["/gravepedia/maintainers"], undefined, "Genepedia-only operations must not appear under Gravepedia");

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

console.log("Artifact is valid ESM and exports default.fetch");
