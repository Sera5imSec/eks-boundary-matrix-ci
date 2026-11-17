import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, argument, isMain, CATALOG } from './matrix_lib.mjs';

export function createReport(selection, review, runtime, catalog = readJson(CATALOG)) {
  const errors = [];
  if (!selection?.matrix_ids || !review?.rows || !runtime?.matrices) errors.push('Required evidence is missing');
  for (const issue of review?.errors ?? []) errors.push(issue);
  const rows = [];
  for (const id of selection?.matrix_ids ?? []) {
    const matches = (runtime?.matrices ?? []).filter(matrix => matrix.id === id);
    if (matches.length !== 1) { errors.push('Missing or duplicate matrix result ' + id); continue; }
    const matrix = matches[0];
    if (!Array.isArray(matrix.cases)) { errors.push(id + ': scenario evidence is malformed'); continue; }
    const expected = catalog.matrices.find(row => row.id === id)?.variants.map(row => row.id).sort();
    const actual = matrix.cases.map(row => row.id).sort();
    if (!expected || JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(id + ': scenario evidence is missing, duplicated or unknown');
    if (matrix.control?.verdict !== 'PASS' || matrix.cases.some(row => row.status !== 'PASS')) errors.push(id + ': scenario or normal control failed');
    rows.push({ matrix: id, status: matrix.status, scenarios: matrix.cases.length, passed: matrix.cases.filter(row => row.status === 'PASS').length });
    if (matrix.status !== 'PASS') errors.push(id + ': ' + matrix.control.verdict);
  }
  return {
    schema_version: 1, status: errors.length ? 'FAIL' : 'PASS', selection: selection?.mode ?? 'unknown',
    rows, errors, evidence_scope: 'Terraform configuration evaluated with mocked providers, local image artifact and declared workflow/policy checks',
    deployed_aws_and_kubernetes: 'PENDING'
  };
}

export function markdownReport(report) {
  return [
    '# Boundary Matrix Gate',
    '',
    'Result **' + report.status + '**',
    '',
    '| Matrix | Result | Scenarios passed |',
    '| --- | --- | --- |',
    ...report.rows.map(row => '| ' + row.matrix + ' | ' + row.status + ' | ' + row.passed + '/' + row.scenarios + ' |'),
    '',
    'Evidence scope — ' + report.evidence_scope + '.',
    '',
    'Deployed AWS and Kubernetes observations — ' + report.deployed_aws_and_kubernetes + '.',
    '',
    ...report.errors.map(error => '- ' + error.replaceAll('\n', ' ')),
    ''
  ].join('\n');
}

export function saveReport(report, outputDirectory = 'artifacts') {
  fs.mkdirSync(outputDirectory, { recursive: true });
  writeJson(path.join(outputDirectory, 'matrix-status.json'), report);
  const markdown = markdownReport(report);
  fs.writeFileSync(path.join(outputDirectory, 'matrix-status.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

if (isMain(import.meta)) {
  try {
    const args = process.argv.slice(2);
    const report = createReport(readJson(argument(args, '--selection', 'artifacts/matrix-selection.json')),
      readJson(argument(args, '--review', 'artifacts/boundary-review.json')), readJson(argument(args, '--runtime', 'artifacts/matrix-runtime.json')));
    saveReport(report);
    console.log(report.status);
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
