'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist', 'memory-layer-extension');
const manifestPath = path.join(root, 'manifest.json');

const files = [
  'manifest.json',
  'memory_layer_background.js',
  'memory_layer_sidepanel.html',
  'memory_layer_sidepanel.css',
  'memory_layer_sidepanel.js',
  'memory_layer_content.js',
  'memory_layer_extractors.js',
  'memory_layer_picker.js',
  'memory_layer_quantizer.js',
  path.join('images', 'icon16.png'),
  path.join('images', 'icon48.png'),
  path.join('images', 'icon128.png'),
];

function ensureInsideRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write outside extension root: ${resolved}`);
  }
  return resolved;
}

function copyFile(relativeSource, relativeTarget = relativeSource) {
  const source = path.join(root, relativeSource);
  const target = ensureInsideRoot(path.join(outDir, relativeTarget));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

if (!fs.existsSync(manifestPath)) {
  throw new Error('manifest.json is missing.');
}

fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  copyFile(file);
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(fullPath, base);
    }
    return path.relative(base, fullPath).replace(/\\/g, '/');
  });
}

const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
const copiedFiles = files.map(file => file.replace(/\\/g, '/'));
const allowedFiles = new Set(copiedFiles);
const extraFiles = listFiles(outDir).filter(file => !allowedFiles.has(file));

if (extraFiles.length > 0) {
  throw new Error(`Build output contains files outside the memory-layer release profile: ${extraFiles.join(', ')}`);
}

console.log(JSON.stringify({
  outDir,
  name: manifest.name,
  contentScripts: manifest.content_scripts.flatMap(entry => entry.js),
  background: manifest.background?.service_worker,
  files: copiedFiles,
}, null, 2));
