import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOG = 'security/matrices/catalog.json';
export const BINDINGS = 'security/matrices/bindings.json';
export const DECISIONS = 'security/matrices/code_decisions.json';
export const POLICY = 'security/matrices/policy.json';

export function readJson(file, root = ROOT) {
  return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function argument(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(name + ' needs a value');
  return args[index + 1];
}

export function selectedIds(catalog, input = 'all') {
  if (input === 'all') return catalog.matrices.map(matrix => matrix.id);
  const requested = input.split(',').map(value => value.trim());
  return [...new Set(requested.map(id => {
    const matrix = catalog.matrices.find(row => row.id === id || row.variants.some(variant => variant.id === id));
    if (!matrix) throw new Error('Unknown matrix or scenario ID ' + id + '. Matrix IDs: ' + catalog.matrices.map(row => row.id).join(', '));
    return matrix.id;
  }))];
}

export function isMain(meta) {
  return meta.url === new URL(process.argv[1], 'file:///').href ||
    fileURLToPath(meta.url) === path.resolve(process.argv[1] ?? '');
}
