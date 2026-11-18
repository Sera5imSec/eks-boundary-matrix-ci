// This suite belongs to the separate manual workflow, outside npm test's PR glob.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, CATALOG, readJson, fingerprint } from './matrix_lib.mjs';
import { sourceUnits, yamlDocuments } from './change_impact.mjs';
import { sourceFingerprints } from './matrix_runtime.mjs';
import { sourceMutations, validateSourceMutations, applySourceMutation } from './source_mutations.mjs';
import { assertManualInvocation, copySource, snapshotSource, removeTemporarySource, runSourceSensitivity } from './matrix_sensitivity.mjs';

const catalog = readJson(CATALOG);
const context = { baseline: { release: { repository: '111122223333.dkr.ecr.us-west-2.amazonaws.com/matrix-demo' } } };
function temporarySource() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eks-source-mutant-'));
  copySource(ROOT, directory);
  return directory;
}

test('all 13 matrix mutations change only one actual source file and retain valid source syntax', () => {
  validateSourceMutations(catalog);
  assert.equal(sourceMutations.length, 13);
  const before = snapshotSource(ROOT);
  for (const mutation of sourceMutations) {
    const directory = temporarySource();
    try {
      const change = applySourceMutation(directory, mutation, context);
      const after = snapshotSource(directory);
      assert.deepEqual(Object.keys(before).filter(file => before[file] !== after[file]), [mutation.file]);
      assert.notEqual(change.before_sha256, change.after_sha256);
      assert.ok(sourceUnits(mutation.file, fs.readFileSync(path.join(directory, mutation.file), 'utf8')).length);
      assert.throws(() => applySourceMutation(directory, mutation, context), /exactly one source anchor/);
    } finally { removeTemporarySource(directory); }
  }
  assert.equal(fingerprint(snapshotSource(ROOT)), fingerprint(before));
  assert.throws(() => validateSourceMutations({ matrices: catalog.matrices.slice(1) }), /exactly one/);
});

test('source suite is restricted to explicit local use or GitHub manual dispatch', () => {
  assert.doesNotThrow(() => assertManualInvocation({}));
  assert.doesNotThrow(() => assertManualInvocation({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' }));
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_call']) {
    assert.throws(() => assertManualInvocation({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: event }), /manual-only/);
  }
  const manual = yamlDocuments(fs.readFileSync(path.join(ROOT, '.github/workflows/matrix-sensitivity.yml'), 'utf8'), 'manual')[0];
  assert.deepEqual(Object.keys(manual.on), ['workflow_dispatch']);
  const normal = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(normal, /matrix_sensitivity|source_mutations|matrix:sensitivity/);
});

test('temporary cleanup rejects source and arbitrary paths', () => {
  assert.throws(() => removeTemporarySource(ROOT), /Refusing/);
  assert.throws(() => removeTemporarySource(os.tmpdir()), /Refusing/);
});

async function lifecycle({ failPreparation = false, verdict, stale = false } = {}) {
  const root = temporarySource();
  const calls = [];
  let firstFingerprints;
  const prepare = async options => {
    calls.push(options);
    if (calls.length > 1 && failPreparation) throw new Error('Preparation failed before the oracle');
    const artifacts = path.join(options.root, 'artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const file of ['terraform-test.jsonl', 'terraform-provenance.json', 'image-evidence.json']) {
      fs.writeFileSync(path.join(artifacts, file), '{}\n');
    }
    const hashes = sourceFingerprints(options.root);
    firstFingerprints ??= hashes;
    return { schema_version: 1, source_fingerprints: stale && calls.length > 1 ? firstFingerprints : hashes,
      policy: readJson('security/matrices/policy.json', options.root),
      manifests: ['bootstrap.yaml', 'workload.yaml'].flatMap(file => yamlDocuments(
        fs.readFileSync(path.join(options.root, 'app/kubernetes', file), 'utf8'), file)) };
  };
  let oracleCalls = 0;
  const options = { root, catalog, ids: ['NETWORK-01'], prepare, onProgress: () => {} };
  if (verdict) options.oracle = () => ({ verdict: verdict(++oracleCalls) });
  try {
    const before = snapshotSource(root);
    const report = await runSourceSensitivity(options);
    assert.equal(report.original_source_unchanged, true);
    assert.equal(fingerprint(snapshotSource(root)), fingerprint(before));
    assert.ok(report.results[0].result);
    if (calls.length > 1) {
      assert.equal(calls[1].skipTerraform, true);
      assert.equal(calls[1].skipImage, true);
      assert.equal(fs.existsSync(calls[1].root), false);
    }
    return { report, calls };
  } finally { removeTemporarySource(root); }
}

test('source mutation is re-rendered and detected by the real network oracle with original source preserved', async () => {
  const { report, calls } = await lifecycle();
  assert.equal(report.status, 'PASS');
  assert.equal(report.results[0].result, 'DETECTED');
  assert.equal(calls.length, 2);
  assert.deepEqual(report.results[0].source_changes, ['app/kubernetes/workload.yaml']);
  assert.equal(report.results[0].control.verdict, 'PASS');
  assert.equal(report.results[0].observation.verdict, 'FAIL');
});

test('preparation errors never count as detected mutations', async () => {
  const { report } = await lifecycle({ failPreparation: true });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.results[0].result, 'ERROR');
});

test('a surviving source change fails sensitivity', async () => {
  const { report } = await lifecycle({ verdict: () => 'PASS' });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.results[0].result, 'SURVIVED');
});

test('REVIEW is an error rather than a detection', async () => {
  const { report } = await lifecycle({ verdict: call => call === 1 ? 'PASS' : 'REVIEW' });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.results[0].result, 'ERROR');
});

test('a broken control prevents source mutation', async () => {
  const { report, calls } = await lifecycle({ verdict: () => 'FAIL' });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.results[0].result, 'CONTROL_FAILED');
  assert.equal(calls.length, 1);
});

test('stale evidence cannot detect a source mutation', async () => {
  const { report } = await lifecycle({ stale: true });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.results[0].result, 'ERROR');
  assert.match(report.results[0].detail, /stale/);
});
