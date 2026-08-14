import { readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import {
  type RegistryItem,
  createRegistryModuleArtifactEnvelope,
  validateRegistryModuleManifest,
} from '@kortix/registry';

const root = resolve(import.meta.dir, '..');
const item = JSON.parse(
  await readFile(resolve(root, 'registry-item.json'), 'utf8'),
) as RegistryItem;
const manifest = item.module;
const validation = validateRegistryModuleManifest(manifest);
if (!validation.valid) {
  throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
}

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await files(path)));
    else if (entry.isFile()) output.push(path);
    else throw new Error(`Unsupported artifact entry: ${path}`);
  }
  return output;
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
      return 'text/javascript';
    case '.json':
      return 'application/json';
    case '.md':
    case '.txt':
    case '':
      return 'text/plain';
    case '.glb':
      return 'model/gltf-binary';
    default:
      return 'application/octet-stream';
  }
}

const dist = resolve(root, 'dist');
const resolvedFiles = await files(dist);
const declared = new Set((item.files ?? []).map((file) => file.path));
const actual = resolvedFiles.map((path) => relative(root, path).replaceAll('\\', '/')).sort();
if (actual.length !== declared.size || actual.some((path) => !declared.has(path))) {
  throw new Error(`registry-item.json files do not match dist: ${actual.join(', ')}`);
}

const envelope = createRegistryModuleArtifactEnvelope({
  item,
  files: await Promise.all(
    resolvedFiles.map(async (path) => {
      const itemPath = relative(root, path).replaceAll('\\', '/');
      return {
        path: itemPath,
        target: itemPath,
        mediaType: mediaType(path),
        bytes: new Uint8Array(await readFile(path)),
      };
    }),
  ),
  lockGraph: { format: 'openopc-lock.v1', nodes: [] },
  source: {
    uri: 'https://github.com/tigerowo/infinite-canvas',
    revision: '6d0bed4eb1ad9f1ec4fe0ec635b267bcb3bc901b',
    registryItemAddress: 'openopc/infinite-canvas',
  },
});

console.log(`Manifest valid: ${manifest?.id}@${manifest?.version}`);
console.log(`Files: ${envelope.descriptor.blobs.length}`);
console.log(`Artifact digest: ${envelope.artifactDigest}`);
