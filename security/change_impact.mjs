import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import hcl from 'hcl2-parser';
import YAML from 'yaml';
import { DockerfileParser } from 'dockerfile-ast';
import { ROOT, fingerprint, writeJson, argument, isMain } from './matrix_lib.mjs';

const ignored = new Set(['.git', '.terraform', 'node_modules', 'artifacts']);

export function filesIn(root, directory = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('A source symlink needs review: ' + file);
    if (entry.isDirectory()) result.push(...filesIn(root, file));
    else result.push(file);
  }
  return result.sort();
}

export function isSource(file) {
  if (file.startsWith('security/') || ['package.json', 'package-lock.json'].includes(file)) return false;
  return /\.(tf|tfvars|hcl|json|ya?ml|sh|mjs|cjs|js|ts|tsx|jsx|py|go|rb|rs|java|c|cpp|toml|ini|conf)$/.test(file) ||
    file.endsWith('.terraform.lock.hcl') || path.posix.basename(file) === 'Dockerfile' ||
    (file.startsWith('app/') || file.startsWith('patterns/')) && !file.endsWith('.md') ||
    file.startsWith('scripts/');
}

export function yamlDocuments(text, label) {
  return YAML.parseAllDocuments(text, { uniqueKeys: true }).map(doc => {
    if (doc.errors.length) throw new Error(label + ': ' + doc.errors[0].message);
    const value = doc.toJS({ maxAliasCount: 50 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ': expected a YAML object');
    return value;
  });
}

export function sourceUnits(file, text) {
  const units = [];
  const add = (symbol, value) => units.push({ path: file, symbol, fingerprint: fingerprint(value) });
  if (file.endsWith('.tf') || file.endsWith('.tfvars')) {
    const [parsed, diagnostics] = hcl.parseToObject(text);
    if (!parsed || diagnostics) throw new Error(file + ': HCL parse failed');
    for (const [kind, blocks] of Object.entries(parsed)) {
      if (kind === 'locals' || kind === 'terraform') {
        for (const [index, block] of blocks.entries()) {
          for (const [field, value] of Object.entries(block)) add(kind + '.' + index + '.' + field, value);
        }
      } else if (['module', 'variable', 'output', 'provider'].includes(kind)) {
        for (const [name, instances] of Object.entries(blocks)) {
          for (const [index, block] of instances.entries()) {
            for (const [field, value] of Object.entries(block)) add(kind + '.' + name + '.' + index + '.' + field, value);
          }
        }
      } else if (kind === 'resource' || kind === 'data') {
        for (const [type, named] of Object.entries(blocks)) {
          for (const [name, instances] of Object.entries(named)) {
            for (const [index, block] of instances.entries()) {
              for (const [field, value] of Object.entries(block)) add(kind + '.' + type + '.' + name + '.' + index + '.' + field, value);
            }
          }
        }
      } else throw new Error(file + ': unclassified HCL block ' + kind);
    }
  } else if (/\.ya?ml$/.test(file)) {
    const documents = yamlDocuments(text, file);
    for (const [index, document] of documents.entries()) {
      const prefix = document.kind ? document.kind + '.' + (document.metadata?.name ?? index) : 'workflow';
      for (const [field, value] of Object.entries(document)) {
        if (field === 'jobs') {
          for (const [job, settings] of Object.entries(value)) add(prefix + '.jobs.' + job, settings);
        } else add(prefix + '.' + field, value);
      }
    }
  } else if (path.posix.basename(file) === 'Dockerfile') {
    const document = DockerfileParser.parse(text);
    for (const [index, instruction] of document.getInstructions().entries()) {
      add('instruction.' + index + '.' + instruction.getInstruction(), instruction.getTextContent());
    }
    // Parser directives and every byte are included so a new syntax directive is visible.
    add('dockerfile', text.replace(/\r\n/g, '\n'));
  } else add('file', text.replace(/\r\n/g, '\n'));
  if (!units.length && text.trim()) add('file', text);
  const keys = units.map(unit => unit.symbol);
  if (new Set(keys).size !== keys.length) throw new Error(file + ': duplicate source unit');
  return units;
}

function git(root, args) {
  return execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), '-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
}

export function impactReport({ root = ROOT, base = null, full = false } = {}) {
  const currentFiles = filesIn(root);
  const current = currentFiles.filter(isSource).flatMap(file => sourceUnits(file, fs.readFileSync(path.join(root, file), 'utf8')));
  if (full) return { schema_version: 1, mode: 'full', changed_files: currentFiles, changed_units: current.map(unit => ({ ...unit, status: 'current' })) };
  if (!base || !/^[0-9a-f]{7,40}$/.test(base) || /^0+$/.test(base)) {
    throw new Error('A valid base commit is required for incremental selection; use --full for the first run');
  }
  git(root, ['cat-file', '-e', base + '^{commit}']);
  const baseFiles = git(root, ['ls-tree', '-r', '--name-only', base]).trim().split('\n').filter(Boolean);
  const before = new Map();
  for (const file of baseFiles.filter(isSource)) {
    for (const unit of sourceUnits(file, git(root, ['show', base + ':' + file]))) before.set(file + ':' + unit.symbol, unit);
  }
  const after = new Map(current.map(unit => [unit.path + ':' + unit.symbol, unit]));
  const changedUnits = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key);
    const next = after.get(key);
    if (old?.fingerprint === next?.fingerprint) continue;
    changedUnits.push({
      ...(next ?? old), before_fingerprint: old?.fingerprint ?? null,
      after_fingerprint: next?.fingerprint ?? null, status: !old ? 'added' : !next ? 'deleted' : 'modified'
    });
  }
  const changedFiles = new Set(git(root, ['diff', '--name-only', base, '--']).trim().split('\n').filter(Boolean));
  for (const file of git(root, ['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean)) changedFiles.add(file);
  let baseCatalog = [];
  const catalogFile = 'security/matrices/catalog.json';
  if (baseFiles.includes(catalogFile)) {
    baseCatalog = JSON.parse(git(root, ['show', base + ':' + catalogFile])).matrices
      .map(matrix => ({ id: matrix.id, variant_ids: matrix.variants.map(variant => variant.id) }));
  }
  return { schema_version: 1, mode: 'incremental', base, base_catalog: baseCatalog,
    changed_files: [...changedFiles].sort(), changed_units: changedUnits };
}

if (isMain(import.meta)) {
  try {
    const args = process.argv.slice(2);
    const result = impactReport({ base: argument(args, '--base'), full: args.includes('--full') });
    writeJson(argument(args, '--output', 'artifacts/change-impact.json'), result);
    console.log(JSON.stringify({ files: result.changed_files.length, units: result.changed_units.length }));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
