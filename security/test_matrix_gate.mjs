import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { ROOT, CATALOG, BINDINGS, DECISIONS, readJson, fingerprint, selectedIds } from './matrix_lib.mjs';
import { sourceUnits, impactReport, yamlDocuments, isSource } from './change_impact.mjs';
import { reviewImpact, selectMatrices } from './boundary_review.mjs';
import { evaluate, permission } from './matrix_oracles.mjs';
import { createReport } from './matrix_report.mjs';
import { verifyFreshness } from './matrix_runtime.mjs';
import { tarEntries, inspectImage, sha256 } from './image_evidence.mjs';
import { validateCatalog } from './matrix_ci.mjs';
import { prepareEvidence } from './prepare_evidence.mjs';

const catalog = readJson(CATALOG);
const bindings = readJson(BINDINGS);
const decisions = readJson(DECISIONS);

test('every catalog scenario has an executable binding and every current source unit has a decision', () => {
  const result = validateCatalog();
  assert.deepEqual(result.errors, []);
  assert.equal(result.matrices, 13);
  assert.equal(result.scenarios, 41);
});

test('matrix IDs and scenario IDs select the same complete matrix', () => {
  const matrix = catalog.matrices.find(row => row.id === 'CLUSTER-ACCESS-01');
  assert.deepEqual(selectedIds(catalog, matrix.id), selectedIds(catalog, matrix.variants[0].id));
  assert.throws(() => selectedIds(catalog, 'UNKNOWN'), /Unknown matrix/);
});

test('an unknown matrix ID writes an input error and returns exit code 2', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-input-'));
  const output = path.join(directory, 'result.json');
  try {
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'security/matrix_sensitivity.mjs'), '--matrix', 'UNKNOWN', '--output', output], { stdio: 'pipe' }),
      error => error.status === 2);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'ERROR');
    assert.match(fs.readFileSync(output.replace('.json', '.md'), 'utf8'), /Unknown matrix/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('HCL whitespace and comments preserve the parsed code unit fingerprint', () => {
  const first = sourceUnits('main.tf', 'module "eks" { cluster_endpoint_public_access = false }');
  const second = sourceUnits('main.tf', '# comment\nmodule "eks" {\n cluster_endpoint_public_access=false\n}');
  assert.deepEqual(first, second);
});

test('HCL changes inside a known module are visible at the changed field', () => {
  const first = sourceUnits('main.tf', 'module "eks" { cluster_endpoint_public_access = false }');
  const second = sourceUnits('main.tf', 'module "eks" { cluster_endpoint_public_access = true }');
  assert.equal(first[0].symbol, second[0].symbol);
  assert.notEqual(first[0].fingerprint, second[0].fingerprint);
});

test('an added field inside a known module needs a new decision', () => {
  const unit = sourceUnits('patterns/fully-private-cluster/main.tf', 'module "eks" { newly_added_field = true }')[0];
  const report = reviewImpact({ changed_units: [unit] }, catalog, bindings, decisions);
  assert.equal(report.status, 'REVIEW_REQUIRED');
});

test('a new Terraform file needs a coverage decision', () => {
  const unit = sourceUnits('patterns/fully-private-cluster/new.tf', 'resource "aws_s3_bucket" "extra" { bucket = "example" }')[0];
  assert.equal(reviewImpact({ changed_units: [unit] }, catalog, bindings, decisions).status, 'REVIEW_REQUIRED');
});

test('a new application language outside the original folders enters source review', () => {
  assert.equal(isSource('services/new_backend.py'), true);
  const unit = sourceUnits('services/new_backend.py', 'print("new service")')[0];
  assert.equal(reviewImpact({ changed_units: [unit] }, catalog, bindings, decisions).status, 'REVIEW_REQUIRED');
});

test('a changed fingerprint cannot reuse the old coverage decision', () => {
  const original = decisions.decisions[0];
  const unit = { path: original.path, symbol: original.symbol, fingerprint: '0'.repeat(64) };
  assert.equal(reviewImpact({ changed_units: [unit] }, catalog, bindings, decisions).status, 'REVIEW_REQUIRED');
});

test('a decision claiming a new matrix must introduce one relative to the Git base', () => {
  const original = decisions.decisions.find(row => row.matrix_ids.length > 0);
  const changed = { ...original, decision: 'new_matrix' };
  const impact = { changed_units: [original], base_catalog: catalog.matrices.map(row => ({ id: row.id, variant_ids: row.variants.map(variant => variant.id) })) };
  assert.equal(reviewImpact(impact, catalog, bindings, { decisions: [changed] }).status, 'REVIEW_REQUIRED');
});

test('a decision claiming a new scenario must introduce a new scenario', () => {
  const original = decisions.decisions.find(row => row.matrix_ids.length > 0);
  const changed = { ...original, decision: 'add_variant' };
  const impact = { changed_units: [original], base_catalog: catalog.matrices.map(row => ({ id: row.id, variant_ids: row.variants.map(variant => variant.id) })) };
  assert.equal(reviewImpact(impact, catalog, bindings, { decisions: [changed] }).status, 'REVIEW_REQUIRED');
});

test('a deletion needs an explicit deletion decision', () => {
  const original = decisions.decisions[0];
  const unit = { ...original, status: 'deleted' };
  assert.equal(reviewImpact({ changed_units: [unit] }, catalog, bindings, decisions).status, 'REVIEW_REQUIRED');
});

test('Kubernetes objects are inventoried separately inside a YAML file', () => {
  const text = 'kind: Service\nmetadata: {name: a}\nspec: {type: ClusterIP}\n---\nkind: ServiceAccount\nmetadata: {name: b}\n';
  const units = sourceUnits('app/kubernetes/objects.yaml', text);
  assert(units.some(row => row.symbol === 'Service.a.spec'));
  assert(units.some(row => row.symbol === 'ServiceAccount.b.metadata'));
});

test('ambiguous YAML and malformed HCL stop the parser', () => {
  assert.throws(() => yamlDocuments('kind: Service\nkind: Deployment\n', 'duplicate.yaml'), /unique|duplicate/i);
  assert.throws(() => sourceUnits('main.tf', 'module "eks" { broken = '), /parse failed/);
});

test('Docker COPY flags are part of the code fingerprint', () => {
  const first = sourceUnits('app/Dockerfile', 'COPY --chown=node:node a b\n');
  const second = sourceUnits('app/Dockerfile', 'COPY --chown=root:root a b\n');
  assert.notEqual(first[0].fingerprint, second[0].fingerprint);
});

test('a cluster endpoint field selects just its bound matrix', () => {
  const source = bindings.sources.find(row => row.path.endsWith('/main.tf') && row.symbol_prefixes[0].endsWith('cluster_endpoint_public_access'));
  const unit = decisions.decisions.find(row => row.path === source.path && row.symbol === source.symbol_prefixes[0]);
  const impact = { mode: 'incremental', changed_files: [unit.path], changed_units: [unit] };
  const review = reviewImpact(impact, catalog, bindings, decisions);
  assert.deepEqual(selectMatrices(impact, catalog, bindings, review).matrix_ids, ['CLUSTER-ACCESS-01']);
});

test('a documentation edit selects zero matrices', () => {
  const impact = { mode: 'incremental', changed_files: ['README.md'], changed_units: [] };
  assert.deepEqual(selectMatrices(impact, catalog, bindings, { errors: [], rows: [] }).matrix_ids, []);
});

test('the decisions file alone does not expand runtime selection', () => {
  const impact = { mode: 'incremental', changed_files: [DECISIONS], changed_units: [] };
  assert.deepEqual(selectMatrices(impact, catalog, bindings, { errors: [], rows: [] }).matrix_ids, []);
});

test('a gate implementation edit selects all matrices', () => {
  const impact = { mode: 'incremental', changed_files: ['security/matrix_oracles.mjs'], changed_units: [] };
  assert.equal(selectMatrices(impact, catalog, bindings, { errors: [], rows: [] }).matrix_ids.length, catalog.matrices.length);
});

test('unclassified source selects a full run and stays blocked for review', () => {
  const impact = { mode: 'incremental', changed_files: ['new.tf'], changed_units: [{ path: 'new.tf', symbol: 'file', fingerprint: 'f'.repeat(64) }] };
  const review = reviewImpact(impact, catalog, bindings, decisions);
  assert.equal(review.status, 'REVIEW_REQUIRED');
  assert.equal(selectMatrices(impact, catalog, bindings, review).matrix_ids.length, catalog.matrices.length);
});

test('Git impact discovers untracked additions and tracked deletions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-git-'));
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '-q']);
    fs.writeFileSync(path.join(directory, 'old.tf'), 'module "old" { source = "example" }\n');
    git(['add', 'old.tf']);
    git(['-c', 'user.name=Matrix Test', '-c', 'user.email=matrix@example.invalid', 'commit', '-qm', 'test base']);
    const base = git(['rev-parse', 'HEAD']).trim();
    fs.unlinkSync(path.join(directory, 'old.tf'));
    fs.writeFileSync(path.join(directory, 'new.tf'), 'module "new" { source = "example" }\n');
    const impact = impactReport({ root: directory, base });
    assert(impact.changed_units.some(row => row.path === 'old.tf' && row.status === 'deleted'));
    assert(impact.changed_units.some(row => row.path === 'new.tf' && row.status === 'added'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('IAM explicit deny takes precedence over a matching allow', () => {
  const policy = { Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: '*' },
    { Effect: 'Deny', Action: ['s3:GetObject'], Resource: 'arn:aws:s3:::example/private/*' }] };
  assert.equal(permission(policy, 's3:GetObject', 'arn:aws:s3:::example/private/item'), false);
  assert.equal(permission(policy, 's3:GetObject', 'arn:aws:s3:::example/public/item'), true);
});

test('unsupported IAM constructs request review', () => {
  assert.throws(() => permission({ Statement: [{ Effect: 'Allow', NotAction: 's3:*', Resource: '*' }] }, 's3:GetObject', '*'), /outside the demo evaluator/);
});

test('missing cloud evidence requests review', () => {
  assert.equal(evaluate('CLUSTER-ACCESS-01', { terraform: { resources: [] } }).verdict, 'REVIEW');
});

test('only a fresh mocked custom subnet can use its documented creation default', () => {
  const evidence = {
    policy: { provider_contracts: { new_custom_subnet_public_ipv4_default: false } },
    terraform: { evidence_level: 'TERRAFORM_MOCK_STATE', resources: [
      { type: 'aws_eks_node_group', address: 'aws_eks_node_group.demo', values: { subnet_ids: ['subnet-example'] } },
      { type: 'aws_subnet', address: 'module.vpc.aws_subnet.private[0]', values: { id: 'subnet-example', map_public_ip_on_launch: null } },
      { type: 'aws_route_table_association', address: 'module.vpc.aws_route_table_association.private[0]', values: { subnet_id: 'subnet-example', route_table_id: 'rtb-example' } },
      { type: 'aws_route_table', address: 'module.vpc.aws_route_table.private[0]', values: { id: 'rtb-example', route: [] } }
    ] }
  };
  assert.equal(evaluate('NODE-NETWORK-01', evidence).verdict, 'PASS');
  const missingContract = structuredClone(evidence);
  missingContract.policy = {};
  assert.equal(evaluate('NODE-NETWORK-01', missingContract).verdict, 'REVIEW');
  const deployed = structuredClone(evidence);
  deployed.terraform.evidence_level = 'DEPLOYED_AWS_STATE';
  assert.equal(evaluate('NODE-NETWORK-01', deployed).verdict, 'REVIEW');
  const publicSubnet = structuredClone(evidence);
  publicSubnet.terraform.resources[1].values.map_public_ip_on_launch = true;
  assert.equal(evaluate('NODE-NETWORK-01', publicSubnet).verdict, 'FAIL');
  const partial = structuredClone(evidence);
  partial.terraform.resources.pop();
  assert.equal(evaluate('NODE-NETWORK-01', partial).verdict, 'REVIEW');
});

test('Terraform log reuse requires matching source provenance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-cache-'));
  try {
    await assert.rejects(prepareEvidence({ root: directory, skipTerraform: true, skipImage: true }), /stale or has no provenance/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the final report rejects missing evidence and missing scenario rows', () => {
  const id = catalog.matrices[0].id;
  assert.equal(createReport(undefined, undefined, undefined).status, 'FAIL');
  const report = createReport({ matrix_ids: [id], mode: 'full' }, { rows: [], errors: [] },
    { matrices: [{ id, status: 'PASS', control: { verdict: 'PASS' }, cases: [] }] });
  assert.equal(report.status, 'FAIL');
});

test('source provenance rejects stale evidence', () => {
  assert.throws(() => verifyFreshness({ schema_version: 1, source_fingerprints: {} }), /stale/);
});

async function archive(entries) {
  const pack = tar.pack();
  const chunks = [];
  const completed = new Promise((resolve, reject) => { pack.on('data', bytes => chunks.push(bytes)); pack.on('end', resolve); pack.on('error', reject); });
  for (const [name, bytes] of Object.entries(entries)) pack.entry({ name }, bytes);
  pack.finalize();
  await completed;
  return Buffer.concat(chunks);
}

async function imageArchive(marker, location = null) {
  const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Env: location === 'metadata' ? ['TOKEN=' + marker] : [] } }));
  const layer = gzipSync(await archive({ 'example.txt': Buffer.from(location === 'layer' ? marker : 'hello') }));
  const descriptor = bytes => ({ digest: 'sha256:' + sha256(bytes), size: bytes.length });
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...descriptor(config) },
    layers: [{ mediaType: location === 'unsupported' ? 'application/vnd.oci.image.layer.v1.tar+zstd' : 'application/vnd.oci.image.layer.v1.tar+gzip', ...descriptor(layer) }] }));
  return archive({
    'oci-layout': Buffer.from('{"imageLayoutVersion":"1.0.0"}'),
    'index.json': Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [descriptor(manifest)] })),
    ['blobs/sha256/' + sha256(config)]: config,
    ['blobs/sha256/' + sha256(layer)]: layer,
    ['blobs/sha256/' + sha256(manifest)]: manifest
  });
}

test('the image inspector reads actual OCI metadata and compressed layers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-image-'));
  const file = path.join(directory, 'image.tar');
  const marker = 'matrix-example-synthetic-value';
  try {
    fs.writeFileSync(file, await imageArchive(marker));
    const clean = await inspectImage(file, marker);
    assert.deepEqual(clean.marker_hits, []);
    assert.equal(clean.layers_checked, 1);
    fs.writeFileSync(file, await imageArchive(marker, 'metadata'));
    assert.deepEqual((await inspectImage(file, marker)).marker_hits, ['image configuration or history']);
    fs.writeFileSync(file, await imageArchive(marker, 'layer'));
    assert.deepEqual((await inspectImage(file, marker)).marker_hits, ['exported layer 0']);
    fs.writeFileSync(file, await imageArchive(marker, 'unsupported'));
    await assert.rejects(inspectImage(file, marker), /Unsupported image layer format/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
