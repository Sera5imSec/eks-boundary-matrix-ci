import { evaluate, managed, resource } from './matrix_oracles.mjs';

function changePolicy(evidence, address, update) {
  const target = resource(evidence, address);
  const policy = JSON.parse(target.policy);
  update(policy);
  target.policy = JSON.stringify(policy);
}

function changeTrust(evidence, address, update) {
  const target = resource(evidence, address);
  const policy = JSON.parse(target.assume_role_policy);
  update(policy);
  target.assume_role_policy = JSON.stringify(policy);
}

function cluster(evidence) {
  return managed(evidence, 'aws_eks_cluster')[0].values.vpc_config[0];
}

function endpoint(evidence, suffix) {
  return managed(evidence, 'aws_vpc_endpoint').find(row => row.values.service_name.endsWith('.' + suffix)).values;
}

const negativeChanges = {
  'PLATFORM-BASELINE-01-ADDON-N': evidence => {
    evidence.terraform.resources = evidence.terraform.resources.filter(row => !(row.type === 'aws_eks_addon' && row.values.addon_name === 'coredns'));
  },
  'PLATFORM-BASELINE-01-VERSION-N': evidence => { managed(evidence, 'aws_eks_cluster')[0].values.version = '1.30'; },
  'CLUSTER-ACCESS-01-PUBLIC-N': evidence => { cluster(evidence).endpoint_public_access = true; },
  'CLUSTER-ACCESS-01-NO-PRIVATE-N': evidence => { cluster(evidence).endpoint_private_access = false; },
  'NODE-NETWORK-01-ROUTE-N': evidence => {
    const association = managed(evidence, 'aws_route_table_association').find(row => row.address.startsWith('module.vpc.aws_route_table_association.private['));
    evidence.terraform.resources.push({ address: 'aws_route.fixture', mode: 'managed', type: 'aws_route',
      values: { route_table_id: association.values.route_table_id, destination_cidr_block: '0.0.0.0/0', gateway_id: 'igw-fixture' } });
  },
  'NODE-NETWORK-01-SUBNET-N': evidence => {
    managed(evidence, 'aws_subnet').find(row => row.address.startsWith('module.vpc.aws_subnet.private[')).values.map_public_ip_on_launch = true;
  },
  'ECR-PRIVATE-PULL-01-DNS-N': evidence => { endpoint(evidence, 'ecr.api').private_dns_enabled = false; },
  'ECR-PRIVATE-PULL-01-S3-N': evidence => { endpoint(evidence, 's3').route_table_ids = []; },
  'ENDPOINT-ACCESS-01-SOURCE-N': evidence => {
    const group = endpoint(evidence, 'ecr.api').security_group_ids[0];
    const rule = managed(evidence, 'aws_security_group_rule').find(row => row.values.security_group_id === group && row.values.type === 'ingress');
    rule.values.cidr_blocks = ['0.0.0.0/0'];
  },
  'ENDPOINT-ACCESS-01-ATTACHMENT-N': evidence => {
    endpoint(evidence, 'ecr.api').security_group_ids.push('sg-fixture-extra');
    evidence.terraform.resources.push({ address: 'aws_security_group.fixture', type: 'aws_security_group', mode: 'managed',
      values: { id: 'sg-fixture-extra', ingress: [{ protocol: 'tcp', from_port: 443, to_port: 443, cidr_blocks: ['0.0.0.0/0'] }] } });
  },
  'VPC-SCOPE-01-DEFAULT-N': evidence => {
    evidence.terraform.resources.push({ address: 'aws_default_vpc.fixture', type: 'aws_default_vpc', mode: 'managed', values: { id: 'vpc-fixture-default' } });
  },
  'CI-DEPLOY-01-PR-N': evidence => { evidence.workflows['.github/workflows/ci.yml'].permissions['id-token'] = 'write'; },
  'CI-DEPLOY-01-IDENTITY-N': evidence => {
    changeTrust(evidence, 'aws_iam_role.deployer', policy => {
      policy.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'] = 'repo:unrelated/repository:ref:refs/heads/main';
    });
  },
  'CI-DEPLOY-01-REF-N': evidence => { evidence.workflows['.github/workflows/release.yml'].jobs.deploy.if = 'always()'; },
  'CI-DEPLOY-01-LOCAL-N': evidence => { evidence.workflows['.github/workflows/cd.yml'].jobs.delivery.if = 'always()'; },
  'IMAGE-BUILD-01-METADATA-N': evidence => { evidence.image.marker_hits = ['image configuration or history']; },
  'IMAGE-BUILD-01-LAYER-N': evidence => { evidence.image.marker_hits = ['exported layer 0']; },
  'REGISTRY-IAM-01-ROLE-N': evidence => {
    changePolicy(evidence, 'aws_iam_role_policy.deployer', policy => {
      policy.Statement.push({ Effect: 'Allow', Action: ['ecr:PutImage'], Resource: resource(evidence, 'aws_ecr_repository.demo').arn });
    });
  },
  'REGISTRY-IAM-01-REPO-N': evidence => {
    changePolicy(evidence, 'aws_iam_role_policy.publisher', policy => {
      policy.Statement.push({ Effect: 'Allow', Action: ['ecr:PutImage'], Resource: '*' });
    });
  },
  'IMAGE-01-MISMATCH-N': evidence => {
    evidence.manifests.find(row => row.kind === 'Deployment').spec.template.spec.containers[0].image = evidence.release.repository + '@sha256:' + 'f'.repeat(64);
  },
  'IMAGE-01-TAG-N': evidence => {
    evidence.manifests.find(row => row.kind === 'Deployment').spec.template.spec.containers[0].image = evidence.release.repository + ':latest';
  },
  'DEPLOY-RBAC-01-OTHER-NAMESPACE-N': evidence => {
    for (const row of evidence.manifests.filter(row => ['Role', 'RoleBinding'].includes(row.kind))) row.metadata.namespace = 'unrelated-fixture';
  },
  'DEPLOY-RBAC-01-CLUSTER-N': evidence => {
    evidence.manifests.find(row => row.kind === 'RoleBinding').kind = 'ClusterRoleBinding';
  },
  'WORKLOAD-IAM-01-ACCOUNT-N': evidence => {
    changeTrust(evidence, 'aws_iam_role.workload', policy => {
      const key = Object.keys(policy.Statement[0].Condition.StringEquals).find(name => name.endsWith(':sub'));
      policy.Statement[0].Condition.StringEquals[key] = 'system:serviceaccount:unrelated:reader';
    });
  },
  'WORKLOAD-IAM-01-OBJECT-N': evidence => {
    changePolicy(evidence, 'aws_iam_role_policy.workload', policy => { policy.Statement[0].Resource = '*'; });
  },
  'WORKLOAD-IAM-01-PUBLIC-STORAGE-N': evidence => { resource(evidence, 'aws_s3_bucket_public_access_block.demo').block_public_policy = false; },
  'WORKLOAD-IAM-01-STS-N': evidence => {
    evidence.terraform.resources = evidence.terraform.resources.filter(row => !(row.type === 'aws_vpc_endpoint' && row.values.service_name.endsWith('.sts')));
  },
  'NETWORK-01-PUBLIC-N': evidence => {
    evidence.manifests.find(row => row.kind === 'Service').spec.type = 'LoadBalancer';
  }
};

export const negativeCaseIds = Object.keys(negativeChanges);

export function changedEvidence(caseId, baseline) {
  if (!negativeChanges[caseId]) throw new Error('Missing controlled fixture for ' + caseId);
  const copy = structuredClone(baseline);
  negativeChanges[caseId](copy);
  return copy;
}

export function runCases(catalog, matrixIds, evidence) {
  const wanted = new Set(matrixIds);
  const matrices = [];
  for (const matrix of catalog.matrices.filter(row => wanted.has(row.id))) {
    const control = evaluate(matrix.id, evidence);
    const rows = matrix.variants.map(variant => {
      const observation = variant.kind === 'positive' ? control : evaluate(matrix.id, changedEvidence(variant.id, evidence));
      const expectedVerdict = variant.kind === 'positive' ? 'PASS' : 'FAIL';
      return {
        id: variant.id, kind: variant.kind, expected: expectedVerdict, observed: observation.verdict,
        status: observation.verdict === expectedVerdict ? 'PASS' : observation.verdict === 'REVIEW' ? 'REVIEW' : 'FAIL',
        evidence_domains: variant.kind === 'positive' ? matrix.binding.evidence_domains : ['CONTROLLED_POLICY_FIXTURE'],
        oracle: observation
      };
    });
    matrices.push({
      id: matrix.id, control, status: control.verdict === 'PASS' && rows.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL',
      cases: rows
    });
  }
  return { schema_version: 1, matrices, status: matrices.every(matrix => matrix.status === 'PASS') ? 'PASS' : 'FAIL' };
}
