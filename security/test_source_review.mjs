import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, DECISIONS, readJson, writeJson, fingerprint } from './matrix_lib.mjs';
import { sourceUnits } from './change_impact.mjs';
import { reviewSource, runGate } from './matrix_ci.mjs';
import { sourceFingerprints } from './matrix_runtime.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-handoff-'));
  const ignored = new Set(['.git', '.terraform', 'node_modules', 'artifacts']);
  fs.cpSync(ROOT, root, { recursive: true, filter: file =>
    !path.relative(ROOT, file).split(path.sep).some(part => ignored.has(part)) });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Coverage Test', '-c', 'user.email=coverage@example.invalid', 'commit', '-qm', 'reviewed test base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  const close = () => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('coverage-handoff-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  return { root, base, git, close };
}

function changeEndpoint(root, publicAccess) {
  const file = 'patterns/fully-private-cluster/main.tf';
  const target = path.join(root, file);
  const original = fs.readFileSync(target, 'utf8');
  assert.match(original, /cluster_endpoint_public_access\s*=\s*false/);
  const text = original.replace(/cluster_endpoint_public_access\s*=\s*false/, 'cluster_endpoint_public_access = ' + publicAccess);
  fs.writeFileSync(target, text);
  return sourceUnits(file, text).find(row => row.symbol === 'module.eks.0.cluster_endpoint_public_access');
}

test('four simultaneous source edits retain exact classification, candidates and errors before any runtime', async () => {
  const task = fixture();
  try {
    const before = fingerprint(fs.readFileSync(path.join(task.root, DECISIONS), 'utf8'));
    const original = reviewSource({ root: task.root, base: task.base, summary: false });
    assert.equal(original.status, 'PASS');
    writeJson(path.join(task.root, 'artifacts/matrix-runtime.json'), { status: 'PASS', matrices: [{ id: 'old-result' }] });
    changeEndpoint(task.root, true);
    fs.appendFileSync(path.join(task.root, 'patterns/fully-private-cluster/main.tf'),
      '\nresource "aws_s3_bucket" "untracked_logs" { bucket = "temp-untracked-logs-test" }\n');
    fs.writeFileSync(path.join(task.root, 'patterns/fully-private-cluster/rogue_admin.tf'),
      'resource "aws_iam_role_policy_attachment" "rogue_admin" {\n role = aws_iam_role.workload.name\n policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"\n}\n');
    fs.appendFileSync(path.join(task.root, 'app/Dockerfile'), '\nUSER root\n');
    const report = await runGate({ root: task.root, base: task.base, evidence: 'must-not-read-runtime-evidence.json' });
    assert.equal(report.status, 'FAIL');
    assert.equal(report.phase, 'SOURCE_REVIEW');
    assert.equal(report.selection, 'blocked');
    assert.equal(report.errors.length, 6);
    assert(report.errors.every(error => error.includes('source coverage decision')));
    const impact = readJson('artifacts/change-impact.json', task.root);
    assert.equal(impact.changed_files.length, 3);
    assert.equal(impact.changed_units.length, 6);
    assert.equal(impact.changed_units.filter(row => row.status === 'modified').length, 2);
    assert.equal(impact.changed_units.filter(row => row.status === 'added').length, 4);
    const review = readJson('artifacts/boundary-review.json', task.root);
    assert.equal(review.status, 'REVIEW_REQUIRED');
    assert.deepEqual(review.rows.find(row => row.symbol.endsWith('cluster_endpoint_public_access')).candidate_matrix_ids, ['CLUSTER-ACCESS-01']);
    assert.deepEqual(review.rows.find(row => row.symbol === 'dockerfile').candidate_matrix_ids, ['IMAGE-BUILD-01']);
    assert(review.rows.filter(row => row.symbol.startsWith('resource.') || row.symbol === 'instruction.6.USER')
      .every(row => row.candidate_matrix_ids.length === 0));
    assert.equal(readJson('artifacts/matrix-runtime.json', task.root).status, 'NOT_RUN');
    assert.equal(readJson('artifacts/source-review.json', task.root).oracle_execution, 'NOT_RUN');
    const markdown = fs.readFileSync(path.join(task.root, 'artifacts/source-review.md'), 'utf8');
    assert.match(markdown, /CLUSTER-ACCESS-01/);
    assert.match(markdown, /rogue_admin/);
    assert.match(markdown, /modified/);
    assert.match(markdown, /added/);
    assert.equal(fingerprint(fs.readFileSync(path.join(task.root, DECISIONS), 'utf8')), before);
  } finally { task.close(); }
});

test('an unchanged overlooked unit still blocks a documentation-only PR and remains in the handoff errors', () => {
  const task = fixture();
  try {
    fs.writeFileSync(path.join(task.root, 'patterns/fully-private-cluster/overlooked.tf'), 'locals { overlooked = true }\n');
    task.git(['add', '.']);
    task.git(['-c', 'user.name=Coverage Test', '-c', 'user.email=coverage@example.invalid', 'commit', '-qm', 'overlooked source in base']);
    const base = task.git(['rev-parse', 'HEAD']).trim();
    fs.appendFileSync(path.join(task.root, 'README.md'), '\nDocumentation-only edit.\n');
    const report = reviewSource({ root: task.root, base, summary: false });
    assert.equal(report.status, 'FAIL');
    assert.equal(report.changed_units, 0);
    assert(report.errors.some(error => error.includes('overlooked.tf')));
    assert.match(fs.readFileSync(path.join(task.root, 'artifacts/source-review.md'), 'utf8'), /overlooked.tf/);
  } finally { task.close(); }
});

test('a current coverage decision permits the same oracle to reject an unsafe configuration', async () => {
  const task = fixture();
  try {
    const unit = changeEndpoint(task.root, true);
    assert.equal(reviewSource({ root: task.root, base: task.base, summary: false }).status, 'FAIL');
    const journal = readJson(DECISIONS, task.root);
    const original = journal.decisions.find(row => row.path === unit.path && row.symbol === unit.symbol);
    journal.decisions.push({ ...original, fingerprint: unit.fingerprint, decision: 'existing_rule', reason: 'Keep the existing private API rule and scenarios.' });
    writeJson(path.join(task.root, DECISIONS), journal);
    const review = reviewSource({ root: task.root, base: task.base, summary: false });
    assert.equal(review.status, 'PASS');
    assert.deepEqual(review.selection.matrix_ids, ['CLUSTER-ACCESS-01']);
    assert.equal(readJson('artifacts/matrix-status.json', task.root).status, 'NOT_RUN');
    // A component fixture exercises orchestration, freshness and the real oracle;
    // it is not fresh Terraform or deployed AWS evidence.
    writeJson(path.join(task.root, 'artifacts/component-evidence.json'), {
      schema_version: 1, source_fingerprints: sourceFingerprints(task.root),
      terraform: { resources: [{ address: 'module.eks.aws_eks_cluster.this[0]', type: 'aws_eks_cluster',
        values: { vpc_config: [{ endpoint_private_access: true, endpoint_public_access: true }] } }] }
    });
    const report = await runGate({ root: task.root, base: task.base, evidence: 'artifacts/component-evidence.json' });
    assert.equal(report.status, 'FAIL');
    assert.equal(report.rows[0].matrix, 'CLUSTER-ACCESS-01');
    assert.equal(readJson('artifacts/matrix-runtime.json', task.root).matrices[0].control.verdict, 'FAIL');
  } finally { task.close(); }
});

test('parser errors replace earlier reports with explicit errors and NOT_RUN runtime', () => {
  const task = fixture();
  try {
    assert.equal(reviewSource({ root: task.root, base: task.base, summary: false }).status, 'PASS');
    fs.appendFileSync(path.join(task.root, 'patterns/fully-private-cluster/main.tf'), '\nresource "incomplete" {\n');
    const report = reviewSource({ root: task.root, base: task.base, summary: false });
    assert.equal(report.status, 'FAIL');
    assert.equal(readJson('artifacts/catalog-validation.json', task.root).status, 'ERROR');
    assert.equal(readJson('artifacts/change-impact.json', task.root).status, 'ERROR');
    assert.equal(readJson('artifacts/boundary-review.json', task.root).status, 'ERROR');
    assert.equal(readJson('artifacts/matrix-runtime.json', task.root).status, 'NOT_RUN');
    assert.match(fs.readFileSync(path.join(task.root, 'artifacts/source-review.md'), 'utf8'), /HCL parse failed/);
  } finally { task.close(); }
});

test('coverage-only CLI returns 0 or 1, writes an Actions summary and never claims a runtime pass', () => {
  const task = fixture();
  try {
    const summary = path.join(task.root, 'summary.md');
    const args = [path.join(task.root, 'security/matrix_ci.mjs'), 'review', '--base', task.base];
    const options = { cwd: task.root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, stdio: ['ignore', 'pipe', 'pipe'] };
    const passing = JSON.parse(execFileSync(process.execPath, args, options));
    assert.equal(passing.status, 'PASS');
    assert.equal(readJson('artifacts/matrix-status.json', task.root).status, 'NOT_RUN');
    changeEndpoint(task.root, true);
    assert.throws(() => execFileSync(process.execPath, args, options), error => {
      assert.equal(error.status, 1);
      assert.equal(JSON.parse(error.stdout).coverage_status, 'REVIEW_REQUIRED');
      return true;
    });
    assert.match(fs.readFileSync(summary, 'utf8'), /Source coverage review/);
    assert.match(fs.readFileSync(summary, 'utf8'), /CLUSTER-ACCESS-01/);
    assert.equal(readJson('artifacts/matrix-status.json', task.root).status, 'FAIL');
  } finally { task.close(); }
});
