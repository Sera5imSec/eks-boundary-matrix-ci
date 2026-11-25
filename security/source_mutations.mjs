import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const main = 'patterns/fully-private-cluster/main.tf';
const delivery = 'patterns/fully-private-cluster/delivery.tf';
const workload = 'app/kubernetes/workload.yaml';
const probe = (matrix, file, domain, description, before, after) => ({ matrix, file, domain, description, before, after });

// One source-level representative per matrix. These never edit oracle inputs.
export const sourceMutations = [
  probe('PLATFORM-BASELINE-01', main, 'terraform', 'Select a Kubernetes version outside the reviewed baseline',
    'cluster_version = "1.35"', 'cluster_version = "1.30"'),
  probe('CLUSTER-ACCESS-01', main, 'terraform', 'Enable the public Kubernetes API endpoint',
    'cluster_endpoint_public_access  = false', 'cluster_endpoint_public_access  = true'),
  probe('NODE-NETWORK-01', main, 'terraform', 'Add an internet gateway and default route to a node route table',
    '\nmodule "vpc_endpoints" {', `
resource "aws_internet_gateway" "matrix_mutation" {
  vpc_id = module.vpc.vpc_id
}

resource "aws_route" "matrix_mutation" {
  route_table_id         = module.vpc.private_route_table_ids[0]
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.matrix_mutation.id
}

module "vpc_endpoints" {`),
  probe('ECR-PRIVATE-PULL-01', main, 'terraform', 'Disable private DNS specifically for the ECR API endpoint',
    'private_dns_enabled = true', 'private_dns_enabled = service != "ecr.api"'),
  probe('ENDPOINT-ACCESS-01', main, 'terraform', 'Widen endpoint ingress to every IPv4 address',
    'cidr_blocks = [module.vpc.vpc_cidr_block]', 'cidr_blocks = ["0.0.0.0/0"]'),
  probe('VPC-SCOPE-01', main, 'terraform', 'Bring the account default VPC under demo management',
    'manage_default_vpc = false', 'manage_default_vpc = true'),
  probe('CI-DEPLOY-01', '.github/workflows/ci.yml', 'configuration', 'Grant an OIDC token to PR validation',
    'permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n'),
  probe('IMAGE-BUILD-01', 'app/Dockerfile', 'image', 'Persist the synthetic build secret in an exported image layer',
    'USER node', 'RUN --mount=type=secret,id=matrix_marker,required=true cp /run/secrets/matrix_marker /app/matrix-build-marker.txt\nUSER node'),
  probe('REGISTRY-IAM-01', delivery, 'terraform', 'Widen the publisher repository grant',
    'Resource = local.registry_arn', 'Resource = "*"'),
  probe('IMAGE-01', workload, 'configuration', 'Replace the approved digest with a mutable image tag',
    'image: REPLACE_WITH_RELEASE_IMAGE', ({ baseline }) => {
      const repository = baseline?.release?.repository;
      if (!/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-zA-Z0-9_./-]+$/.test(repository ?? '')) {
        throw new Error('Missing or invalid baseline ECR repository');
      }
      return 'image: ' + repository + ':latest';
    }),
  probe('DEPLOY-RBAC-01', 'app/kubernetes/bootstrap.yaml', 'configuration', 'Grant every deployment verb to the deploy role',
    'verbs: ["get", "list", "watch", "patch", "update"]', 'verbs: ["*"]'),
  probe('WORKLOAD-IAM-01', delivery, 'terraform', 'Add object deletion to the read-only workload grant',
    'Action   = ["s3:GetObject"]', 'Action   = ["s3:GetObject", "s3:DeleteObject"]'),
  probe('STORAGE-PRIVATE-01', delivery, 'terraform', 'Disable the additional log bucket public policy restriction',
    'bucket                  = aws_s3_bucket.practice_logs.id\n  block_public_acls       = true\n  block_public_policy     = true',
    'bucket                  = aws_s3_bucket.practice_logs.id\n  block_public_acls       = true\n  block_public_policy     = false'),
  probe('NETWORK-01', workload, 'configuration', 'Publish the internal Service through a LoadBalancer',
    'type: ClusterIP', 'type: LoadBalancer')
];

export function validateSourceMutations(catalog) {
  const expected = catalog.matrices.map(row => row.id).sort();
  const actual = sourceMutations.map(row => row.matrix).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Every catalog matrix needs exactly one source mutation');
  for (const row of sourceMutations) {
    if (!['terraform', 'configuration', 'image'].includes(row.domain) || !row.before ||
        row.file.startsWith('security/') || path.isAbsolute(row.file) || row.file.split('/').includes('..')) {
      throw new Error('Invalid source mutation for ' + row.matrix);
    }
  }
}

export const sourceHash = bytes => createHash('sha256').update(bytes).digest('hex');

export function applySourceMutation(root, mutation, context = {}) {
  const file = path.join(root, mutation.file);
  const original = fs.readFileSync(file);
  const text = original.toString('utf8').replace(/\r\n/g, '\n');
  if (text.split(mutation.before).length !== 2) throw new Error('Expected exactly one source anchor: ' + mutation.matrix);
  const after = typeof mutation.after === 'function' ? mutation.after(context) : mutation.after;
  if (after === mutation.before) throw new Error('Source mutation makes no change');
  if (after.includes(mutation.before) && text.includes(after)) throw new Error('Expected exactly one source anchor before mutation (already applied): ' + mutation.matrix);
  const changed = text.replace(mutation.before, after);
  fs.writeFileSync(file, changed);
  return { path: mutation.file, before_sha256: sourceHash(original), after_sha256: sourceHash(Buffer.from(changed)),
    before: mutation.before, after };
}
