import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './matrix_oracles.mjs';
import fs from 'node:fs';
import YAML from 'yaml';
import { runCases } from './matrix_cases.mjs';

function storageFixture() {
  const resources = ['demo', 'practice_logs'].flatMap(name => [
    { address: 'aws_s3_bucket.' + name, mode: 'managed', type: 'aws_s3_bucket', values: { id: 'fixture-' + name } },
    { address: 'aws_s3_bucket_public_access_block.' + name, mode: 'managed', type: 'aws_s3_bucket_public_access_block',
      values: { bucket: 'fixture-' + name, block_public_acls: true, block_public_policy: true,
        ignore_public_acls: true, restrict_public_buckets: true } }
  ]);
  return { terraform: { resources } };
}

test('private storage scenarios check both buckets and reject missing, disabled and misdirected restrictions', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('./matrices/catalog.json', import.meta.url), 'utf8'));
  const result = runCases(catalog, ['STORAGE-PRIVATE-01'], storageFixture());
  assert.equal(result.matrices.length, 1);
  assert.equal(result.matrices[0].control.verdict, 'PASS');
  assert.equal(result.matrices[0].cases.length, 4);
  assert.ok(result.matrices[0].cases.every(row => row.status === 'PASS'));
});

test('a protected demo bucket cannot hide an unprotected additional bucket', () => {
  const evidence = storageFixture();
  evidence.terraform.resources = evidence.terraform.resources.filter(row => row.address !== 'aws_s3_bucket_public_access_block.practice_logs');
  const result = evaluate('STORAGE-PRIVATE-01', evidence);
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.checks.some(row => !row.ok && row.rule.startsWith('aws_s3_bucket.practice_logs')));
});

test('every S3 public access flag is enforced on the additional bucket', () => {
  for (const flag of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) {
    const evidence = storageFixture();
    evidence.terraform.resources.find(row => row.address === 'aws_s3_bucket_public_access_block.practice_logs').values[flag] = false;
    assert.equal(evaluate('STORAGE-PRIVATE-01', evidence).verdict, 'FAIL', flag);
  }
});

test('a restriction attached to another bucket does not protect the additional bucket', () => {
  const evidence = storageFixture();
  evidence.terraform.resources.find(row => row.address === 'aws_s3_bucket_public_access_block.practice_logs').values.bucket = 'fixture-demo';
  assert.equal(evaluate('STORAGE-PRIVATE-01', evidence).verdict, 'FAIL');
});

test('unknown storage settings and indistinguishable mock identities require review', () => {
  const unknown = storageFixture();
  delete unknown.terraform.resources.find(row => row.address === 'aws_s3_bucket_public_access_block.practice_logs').values.block_public_policy;
  assert.equal(evaluate('STORAGE-PRIVATE-01', unknown).verdict, 'REVIEW');
  const duplicate = storageFixture();
  duplicate.terraform.resources.find(row => row.address === 'aws_s3_bucket.practice_logs').values.id = 'fixture-demo';
  assert.equal(evaluate('STORAGE-PRIVATE-01', duplicate).verdict, 'REVIEW');
});

function workloadFixture() {
  const issuer = 'oidc.eks.us-west-2.amazonaws.com/id/FIXTURE';
  const principal = 'arn:aws:iam::111122223333:oidc-provider/' + issuer;
  const role = { id: 'reader', name: 'reader', arn: 'arn:aws:iam::111122223333:role/reader' };
  const object = 'arn:aws:s3:::fixture/example.txt';
  role.assume_role_policy = JSON.stringify({
    Statement: [{
      Effect: 'Allow', Action: ['sts:AssumeRoleWithWebIdentity'], Principal: { Federated: principal },
      Condition: { StringEquals: { [issuer + ':aud']: 'sts.amazonaws.com', [issuer + ':sub']: 'system:serviceaccount:matrix-demo:matrix-reader' } }
    }]
  });
  const resources = [
    { address: 'aws_iam_role.workload', type: 'aws_iam_role', values: role },
    { address: 'aws_iam_role_policy.workload', type: 'aws_iam_role_policy', values: {
      role: 'reader', policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: object }] })
    } },
    { address: 'module.eks.aws_iam_openid_connect_provider.fixture', type: 'aws_iam_openid_connect_provider', values: { arn: principal, url: 'https://' + issuer } },
    { address: 'aws_vpc.fixture', type: 'aws_vpc', values: { id: 'vpc-fixture' } },
    { address: 'aws_vpc_endpoint.fixture', type: 'aws_vpc_endpoint', values: {
      service_name: 'com.amazonaws.us-west-2.sts', vpc_endpoint_type: 'Interface', private_dns_enabled: true, vpc_id: 'vpc-fixture'
    } },
    { address: 'aws_s3_bucket_public_access_block.demo', type: 'aws_s3_bucket_public_access_block',
      values: { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true } }
  ];
  return {
    policy: { namespace: 'matrix-demo', service_account: 'matrix-reader' },
    terraform: { resources, outputs: { delivery_contract: { demo_object_arn: object } } },
    manifests: [{
      kind: 'ServiceAccount', metadata: { namespace: 'matrix-demo', name: 'matrix-reader', annotations: {
        'eks.amazonaws.com/role-arn': role.arn, 'eks.amazonaws.com/sts-regional-endpoints': 'true'
      } }
    }, { kind: 'Deployment', spec: { template: { spec: { serviceAccountName: 'matrix-reader' } } } }]
  };
}

test('the workload oracle detects a newly granted delete action', () => {
  const evidence = workloadFixture();
  assert.equal(evaluate('WORKLOAD-IAM-01', evidence).verdict, 'PASS');
  const inline = evidence.terraform.resources.find(row => row.address === 'aws_iam_role_policy.workload');
  const policy = JSON.parse(inline.values.policy);
  policy.Statement.push({ Effect: 'Allow', Action: ['s3:DeleteObject'], Resource: 'arn:aws:s3:::fixture/example.txt' });
  inline.values.policy = JSON.stringify(policy);
  assert.equal(evaluate('WORKLOAD-IAM-01', evidence).verdict, 'FAIL');
});

test('an extra managed policy on the workload role fails its declared scope', () => {
  const evidence = workloadFixture();
  evidence.terraform.resources.push({ type: 'aws_iam_role_policy_attachment', address: 'aws_iam_role_policy_attachment.extra',
    values: { role: 'reader', policy_arn: 'arn:aws:iam::aws:policy/AdministratorAccess' } });
  assert.equal(evaluate('WORKLOAD-IAM-01', evidence).verdict, 'FAIL');
});

test('the workload grant must actually be attached to the workload role', () => {
  const evidence = workloadFixture();
  evidence.terraform.resources.find(row => row.address === 'aws_iam_role_policy.workload').values.role = 'unrelated-role';
  assert.equal(evaluate('WORKLOAD-IAM-01', evidence).verdict, 'FAIL');
});

test('workflow scalar forms are recognized and write-all cannot pass the PR token check', () => {
  const principal = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com';
  const subject = 'repo:fixture/repository:ref:refs/heads/main';
  const trust = JSON.stringify({ Statement: [{
    Effect: 'Allow', Action: ['sts:AssumeRoleWithWebIdentity'], Principal: { Federated: principal },
    Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': subject } }
  }] });
  const condition = "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'";
  const evidence = {
    policy: { github_repository: 'fixture/repository' },
    terraform: { resources: [
      { address: 'aws_iam_openid_connect_provider.github', values: { arn: principal } },
      { address: 'aws_iam_role.publisher', values: { assume_role_policy: trust } },
      { address: 'aws_iam_role.deployer', values: { assume_role_policy: trust } }
    ] },
    workflows: {
      '.github/workflows/ci.yml': { on: 'pull_request', permissions: 'read-all', jobs: { check: {} } },
      '.github/workflows/cd.yml': YAML.parse(fs.readFileSync(new URL('../.github/workflows/cd.yml', import.meta.url), 'utf8')),
      '.github/workflows/release.yml': { on: 'workflow_dispatch', jobs: {
        gate: { uses: './.github/workflows/ci.yml' },
        publish: { if: condition, needs: 'gate' }, deploy: { if: condition }
      } }
    }
  };
  assert.equal(evaluate('CI-DEPLOY-01', evidence).verdict, 'PASS');
  evidence.workflows['.github/workflows/ci.yml'].permissions = 'write-all';
  assert.equal(evaluate('CI-DEPLOY-01', evidence).verdict, 'FAIL');
});
