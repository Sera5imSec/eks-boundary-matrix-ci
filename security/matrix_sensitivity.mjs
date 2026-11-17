import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, CATALOG, selectedIds, argument, isMain } from './matrix_lib.mjs';
import { verifyFreshness } from './matrix_runtime.mjs';
import { evaluate } from './matrix_oracles.mjs';
import { changedEvidence } from './matrix_cases.mjs';

export function runSensitivity(catalog, ids, evidence) {
  const results = ids.map(id => {
    const matrix = catalog.matrices.find(row => row.id === id);
    const control = evaluate(id, evidence);
    if (control.verdict !== 'PASS') return { matrix: id, result: 'CONTROL_FAILED', control };
    const scenario = matrix.variants.find(variant => variant.kind === 'negative');
    const observation = evaluate(id, changedEvidence(scenario.id, evidence));
    return { matrix: id, result: observation.verdict === 'FAIL' ? 'DETECTED' : observation.verdict === 'PASS' ? 'SURVIVED' : 'ERROR',
      changed_fixture: scenario.id, control, observation, evidence_level: 'CONTROLLED_POLICY_FIXTURE' };
  });
  return { schema_version: 1, status: results.every(row => row.result === 'DETECTED') ? 'PASS' : 'FAIL', results };
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const output = argument(args, '--output', 'artifacts/matrix-sensitivity.json');
  try {
    const catalog = readJson(CATALOG);
    const ids = selectedIds(catalog, argument(args, '--matrix', 'all'));
    const evidence = readJson(argument(args, '--evidence', 'artifacts/evidence.json'));
    verifyFreshness(evidence);
    const report = runSensitivity(catalog, ids, evidence);
    writeJson(output, report);
    const summary = ['# Manual Matrix Sensitivity', '', '| Matrix | Result |', '| --- | --- |',
      ...report.results.map(row => '| ' + row.matrix + ' | ' + row.result + ' |'), '',
      'A DETECTED result means the oracle rejected the controlled fixture after its normal control passed.', ''].join('\n');
    fs.writeFileSync(output.replace(/\.json$/, '') + '.md', summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(JSON.stringify({ status: report.status, results: report.results.map(row => ({ matrix: row.matrix, result: row.result })) }));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    writeJson(output, { schema_version: 1, status: 'ERROR', detail: error.message, results: [] });
    const summary = '# Manual Matrix Sensitivity\n\nInput or execution error\n\n' + error.message.replace(/[\r\n]/g, ' ') + '\n';
    fs.writeFileSync(output.replace(/\.json$/, '') + '.md', summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.error(error.message);
    process.exitCode = 2;
  }
}
