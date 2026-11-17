import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, writeJson, fingerprint, CATALOG, POLICY, argument, isMain } from './matrix_lib.mjs';
import { filesIn, isSource } from './change_impact.mjs';
import { runCases } from './matrix_cases.mjs';

export function sourceFingerprints(root = ROOT) {
  return Object.fromEntries(filesIn(root).filter(file => isSource(file) || file === POLICY)
    .map(file => [file, fingerprint(fs.readFileSync(path.join(root, file), 'utf8'))]));
}

export function verifyFreshness(evidence, root = ROOT) {
  if (evidence.schema_version !== 1 || !evidence.source_fingerprints) throw new Error('Evidence has no source provenance');
  const current = sourceFingerprints(root);
  if (fingerprint(current) !== fingerprint(evidence.source_fingerprints)) throw new Error('Evidence is stale; rebuild it from the current source');
}

if (isMain(import.meta)) {
  try {
    const args = process.argv.slice(2);
    const evidence = readJson(argument(args, '--evidence', 'artifacts/evidence.json'));
    verifyFreshness(evidence);
    const selection = readJson(argument(args, '--selection', 'artifacts/matrix-selection.json'));
    const report = runCases(readJson(CATALOG), selection.matrix_ids, evidence);
    writeJson(argument(args, '--output', 'artifacts/matrix-runtime.json'), report);
    console.log(JSON.stringify({ status: report.status, matrices: report.matrices.length }));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
