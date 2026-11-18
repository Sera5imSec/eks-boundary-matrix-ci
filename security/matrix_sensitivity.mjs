import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, readJson, writeJson, CATALOG, selectedIds, argument, isMain, fingerprint } from './matrix_lib.mjs';
import { filesIn } from './change_impact.mjs';
import { verifyFreshness } from './matrix_runtime.mjs';
import { prepareEvidence } from './prepare_evidence.mjs';
import { evaluate } from './matrix_oracles.mjs';
import { sourceMutations, validateSourceMutations, applySourceMutation, sourceHash } from './source_mutations.mjs';

const terraformDirectory = 'patterns/fully-private-cluster';
const temporaryPrefix = 'eks-source-mutant-';

export function assertManualInvocation(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Source sensitivity is manual-only: use the separate workflow_dispatch workflow');
  }
}

export function snapshotSource(root) {
  return Object.fromEntries(filesIn(root).map(file => [file, sourceHash(fs.readFileSync(path.join(root, file)))]));
}

export function copySource(root, target) {
  for (const file of filesIn(root)) {
    if (/\.tfstate(?:\..*)?$|\.tfplan$/.test(file)) continue;
    const destination = path.join(target, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }
}

function seedReusableEvidence(root, target) {
  fs.mkdirSync(path.join(target, 'artifacts'), { recursive: true });
  for (const file of ['terraform-test.jsonl', 'terraform-provenance.json', 'image-evidence.json']) {
    fs.copyFileSync(path.join(root, 'artifacts', file), path.join(target, 'artifacts', file));
  }
}

function seedTerraformCache(root, target) {
  const source = path.join(root, terraformDirectory, '.terraform');
  const destination = path.join(target, terraformDirectory, '.terraform');
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  if (fs.existsSync(path.join(source, 'modules'))) {
    fs.cpSync(path.join(source, 'modules'), path.join(destination, 'modules'), { recursive: true });
  }
  // Share only immutable provider executables, never source, state or evaluated values.
  if (fs.existsSync(path.join(source, 'providers'))) {
    fs.symlinkSync(path.join(source, 'providers'), path.join(destination, 'providers'), process.platform === 'win32' ? 'junction' : 'dir');
  }
}

export function removeTemporarySource(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(temporaryPrefix)) {
    throw new Error('Refusing to remove a directory outside the source-mutation temporary area');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function saveRowEvidence(target, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['evidence.json', 'terraform-provenance.json', 'terraform-test.jsonl', 'image-evidence.json']) {
    const file = path.join(target, 'artifacts', name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(destination, name));
  }
}

export function saveSensitivityReport(output, report, githubSummary = null) {
  writeJson(output, report);
  const clean = value => String(value ?? '').replace(/[\r\n|]/g, ' ');
  const lines = ['# Manual source matrix sensitivity', '',
    'Current source control -> disposable source edit -> fresh evaluation of the changed domain -> the same matrix oracle.', '',
    '| Matrix | Result | Source | Preparation |', '| --- | --- | --- | --- |',
    ...report.results.map(row => '| ' + [row.matrix, row.result, row.mutation?.path ?? '', row.detail ?? row.preparation ?? ''].map(clean).join(' | ') + ' |'), '',
    'DETECTED requires a passing control, successful preparation and a FAIL from the selected matrix oracle.',
    'Preparation/build errors and REVIEW results are not detections. One representative source mutation is tested per matrix.',
    'Terraform uses mocked providers. The Docker mutation rebuilds a real local image. Deployed AWS/Kubernetes behavior remains pending.', '',
    ...(report.detail ? [clean(report.detail), ''] : [])];
  const markdown = lines.join('\n');
  fs.writeFileSync(output.replace(/\.json$/, '') + '.md', markdown);
  if (githubSummary) fs.appendFileSync(githubSummary, markdown + '\n');
}

export async function runSourceSensitivity({ root = ROOT, catalog = readJson(CATALOG, root), ids,
  terraform = 'terraform', prepare = prepareEvidence, oracle = evaluate,
  output = path.join(root, 'artifacts/matrix-sensitivity.json'), onProgress = console.log } = {}) {
  assertManualInvocation();
  validateSourceMutations(catalog);
  if (!ids?.length || ids.some(id => !catalog.matrices.some(row => row.id === id))) throw new Error('No valid source mutation selection');
  const before = snapshotSource(root);
  const retainedBase = path.join(root, 'artifacts/source-sensitivity');
  fs.mkdirSync(retainedBase, { recursive: true });
  const retained = fs.mkdtempSync(path.join(retainedBase, 'run-'));
  const report = { schema_version: 2, execution: 'SOURCE_MUTATION', status: 'RUNNING',
    started_at: new Date().toISOString(), selected_matrix_ids: ids, evidence_directory: retained,
    original_source_fingerprint: fingerprint(before), original_source_unchanged: null,
    evidence_scope: 'Re-evaluated source configuration with mocked Terraform providers and local OCI artifacts; deployed AWS/Kubernetes pending',
    results: [] };
  saveSensitivityReport(output, report);
  try {
    onProgress('Preparing the current-source control');
    const baseline = await prepare({ root, terraform });
    verifyFreshness(baseline, root);
    saveRowEvidence(root, path.join(retained, 'control'));
    for (const id of ids) {
      const mutation = sourceMutations.find(row => row.matrix === id);
      const control = oracle(id, baseline);
      const row = { matrix: id, result: 'ERROR', control, description: mutation.description };
      report.results.push(row);
      if (control.verdict !== 'PASS') {
        row.result = 'CONTROL_FAILED';
        saveSensitivityReport(output, report);
        continue;
      }
      let temporary;
      try {
        if (fingerprint(snapshotSource(root)) !== fingerprint(before)) throw new Error('Original source changed during sensitivity run');
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), temporaryPrefix));
        copySource(root, temporary);
        seedReusableEvidence(root, temporary);
        if (mutation.domain === 'terraform') seedTerraformCache(root, temporary);
        row.mutation = applySourceMutation(temporary, mutation, { baseline });
        if (mutation.domain === 'terraform') {
          execFileSync(terraform, ['-chdir=' + path.join(temporary, terraformDirectory), 'fmt', '-recursive'], { stdio: 'inherit', timeout: 60_000 });
        }
        const changed = snapshotSource(temporary);
        const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(changed)])]
          .filter(file => before[file] !== changed[file]);
        if (JSON.stringify(changedPaths) !== JSON.stringify([mutation.file])) throw new Error('Mutation changed an unexpected source set: ' + changedPaths.join(', '));
        row.mutation.after_sha256 = changed[mutation.file];
        row.source_changes = changedPaths;
        row.preparation = mutation.domain === 'terraform' ? 'fresh Terraform mock evaluation; verified unchanged image reused' :
          mutation.domain === 'image' ? 'real uncached Docker rebuild and OCI scan; verified unchanged Terraform reused' :
            'fresh manifest/workflow rendering; verified unchanged Terraform and image reused';
        onProgress('Checking ' + id + ': ' + mutation.description);
        const evidence = await prepare({ root: temporary, terraform,
          skipTerraform: mutation.domain !== 'terraform', skipImage: mutation.domain !== 'image', imageNoCache: mutation.domain === 'image' });
        verifyFreshness(evidence, temporary);
        if (evidence.source_fingerprints[mutation.file] === baseline.source_fingerprints[mutation.file]) throw new Error('Mutation was not reached by evidence collection');
        row.observation = oracle(id, evidence);
        row.result = row.observation.verdict === 'FAIL' ? 'DETECTED' : row.observation.verdict === 'PASS' ? 'SURVIVED' : 'ERROR';
        if (row.observation.verdict === 'REVIEW') row.detail = row.observation.detail ?? 'Mutant evidence requires review';
      } catch (error) {
        row.result = 'ERROR';
        row.detail = error.message;
      } finally {
        if (temporary) {
          const destination = path.join(retained, id);
          try { saveRowEvidence(temporary, destination); row.evidence_directory = destination; }
          finally { removeTemporarySource(temporary); }
        }
        onProgress(row.result + ' ' + id + (row.detail ? ': ' + row.detail : ''));
        saveSensitivityReport(output, report);
      }
    }
  } catch (error) {
    report.detail = error.message;
  } finally {
    report.original_source_unchanged = fingerprint(snapshotSource(root)) === fingerprint(before);
    report.finished_at = new Date().toISOString();
    report.status = !report.detail && report.original_source_unchanged && report.results.length === ids.length &&
      report.results.every(row => row.result === 'DETECTED') ? 'PASS' : 'FAIL';
    if (!report.original_source_unchanged) report.detail = 'Original source changed during sensitivity run; no automatic restoration was attempted';
    saveSensitivityReport(output, report);
  }
  return report;
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const output = path.resolve(argument(args, '--output', path.join(ROOT, 'artifacts/matrix-sensitivity.json')));
  try {
    const catalog = readJson(CATALOG);
    const ids = selectedIds(catalog, argument(args, '--matrix', 'all'));
    assertManualInvocation();
    const report = await runSourceSensitivity({ catalog, ids, output, terraform: argument(args, '--terraform', 'terraform') });
    if (process.env.GITHUB_STEP_SUMMARY) saveSensitivityReport(output, report, process.env.GITHUB_STEP_SUMMARY);
    console.log(JSON.stringify({ status: report.status, results: report.results.map(row => ({ matrix: row.matrix, result: row.result })) }));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    const report = { schema_version: 2, execution: 'SOURCE_MUTATION', status: 'ERROR', detail: error.message, results: [] };
    saveSensitivityReport(output, report, process.env.GITHUB_STEP_SUMMARY);
    console.error(error.message);
    process.exitCode = 2;
  }
}
