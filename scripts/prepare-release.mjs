import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (name) => JSON.parse(await readFile(resolve(root, name), "utf8"));
const manifest = await readJson("manifest.json");
const pkg = await readJson("package.json");
const lock = await readJson("package-lock.json");
const versions = await readJson("versions.json");

// https://docs.obsidian.md/Reference/Manifest
assert.match(manifest.id, /^[a-z]+(?:-[a-z]+)*$/, "Plugin ID must contain only lowercase letters and hyphens");
assert.ok(!manifest.id.includes("obsidian"), "Plugin ID must not contain obsidian");
assert.ok(!manifest.id.endsWith("plugin"), "Plugin ID must not end with plugin");
assert.equal(manifest.id, "img-copy-paste");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.version, lock.version);
assert.equal(manifest.version, lock.packages[""].version);
assert.equal(pkg.name, lock.name);
assert.equal(pkg.name, lock.packages[""].name);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith("."));
for (const name of ["README.md", "LICENSE"]) {
  assert.ok((await readFile(resolve(root, name), "utf8")).trim(), `${name} is required`);
}
const bundle = await readFile(resolve(root, "main.js"), "utf8");
assert.ok(bundle.includes("Export markdown"), "Build is missing the export command");
assert.ok(!bundle.includes("sourceMappingURL="), "Release must not include a development source map");

const output = resolve(root, "release", manifest.id);
await mkdir(output, { recursive: true });
for (const name of ["main.js", "manifest.json", "versions.json"]) {
  await copyFile(resolve(root, name), resolve(output, name));
  assert.deepEqual(await readFile(resolve(output, name)), await readFile(resolve(root, name)));
}
console.log(`Release ${manifest.version} validated and staged in release/${manifest.id}/`);
