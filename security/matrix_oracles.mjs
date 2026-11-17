class IncompleteEvidence extends Error {}

function known(value, label) {
  if (value === undefined || value === null || typeof value === 'string' && value.includes('${')) {
    throw new IncompleteEvidence('Unresolved evidence: ' + label);
  }
  return value;
}

export function managed(evidence, type) {
  return known(evidence.terraform?.resources, 'Terraform resources').filter(resource =>
    resource.type === type && resource.mode !== 'data');
}

export function resource(evidence, address) {
  const matches = known(evidence.terraform?.resources, 'Terraform resources').filter(row => row.address === address);
  if (matches.length !== 1) throw new IncompleteEvidence('Expected one resource at ' + address);
  return matches[0].values;
}

function one(evidence, type) {
  const matches = managed(evidence, type);
  if (matches.length !== 1) throw new IncompleteEvidence('Expected one ' + type);
  return matches[0].values;
}

function list(value, label) {
  const result = known(value, label);
  if (!Array.isArray(result)) throw new IncompleteEvidence('Expected a list: ' + label);
  return result;
}

const asList = value => Array.isArray(value) ? value : [value];

function workflowTriggers(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  if (value && typeof value === 'object') return Object.keys(value);
  throw new IncompleteEvidence('Workflow triggers are unresolved');
}

function hasReadOnlyTokenPermissions(permissions) {
  if (permissions === 'read-all') return true;
  if (permissions === 'write-all') return false;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new IncompleteEvidence('Workflow token permissions are unresolved');
  }
  return permissions['id-token'] === undefined || permissions['id-token'] === 'none';
}

function document(value, label) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : known(value, label);
    if (!Array.isArray(parsed.Statement)) throw new Error('Missing Statement list');
    return parsed;
  } catch (error) { throw new IncompleteEvidence(label + ': ' + error.message); }
}

function identityPolicies(evidence, roleAddress) {
  const role = resource(evidence, roleAddress);
  const matches = row => [role.id, role.name].filter(Boolean).includes(row.values.role);
  const inline = managed(evidence, 'aws_iam_role_policy').filter(matches);
  const attached = managed(evidence, 'aws_iam_role_policy_attachment').filter(matches);
  return {
    inline, attached,
    policy: { Version: '2012-10-17', Statement: inline.flatMap(row => document(row.values.policy, row.address).Statement) }
  };
}

function glob(pattern, value, insensitive = false) {
  if (typeof pattern !== 'string') throw new IncompleteEvidence('Unresolved IAM pattern');
  if (pattern.includes('?')) throw new IncompleteEvidence('IAM single-character globs need review');
  const expression = '^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
  return new RegExp(expression, insensitive ? 'i' : '').test(value);
}

// This evaluator supports the unconditional identity policy statements used by
// the demo. An unsupported condition or policy construct requests review.
export function permission(policy, action, arn) {
  let allowed = false;
  for (const statement of document(policy, 'IAM policy').Statement) {
    if (statement.NotAction || statement.NotResource || statement.Condition || statement.Principal) {
      throw new IncompleteEvidence('IAM policy contains a construct outside the demo evaluator');
    }
    if (!['Allow', 'Deny'].includes(statement.Effect) || !statement.Action || !statement.Resource) {
      throw new IncompleteEvidence('IAM statement is incomplete');
    }
    const matches = asList(statement.Action).some(pattern => glob(pattern, action, true)) &&
      asList(statement.Resource).some(pattern => glob(pattern, arn));
    if (matches && statement.Effect === 'Deny') return false;
    if (matches) allowed = true;
  }
  return allowed;
}

function ipv4(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) throw new IncompleteEvidence('Invalid IPv4 address');
  return parts.reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0;
}

function inside(cidr, network) {
  const [address, prefixText] = String(cidr).split('/');
  const [networkAddress, networkPrefixText] = String(network).split('/');
  const prefix = Number(prefixText);
  const networkPrefix = Number(networkPrefixText);
  if (!prefixText || !networkPrefixText || !Number.isInteger(prefix) || prefix < 0 || prefix > 32 ||
      !Number.isInteger(networkPrefix) || networkPrefix < 0 || networkPrefix > 32) throw new IncompleteEvidence('Invalid CIDR evidence');
  const mask = networkPrefix === 0 ? 0 : (0xffffffff << (32 - networkPrefix)) >>> 0;
  return prefix >= networkPrefix && ((ipv4(address) & mask) >>> 0) === ((ipv4(networkAddress) & mask) >>> 0);
}

function nodeTopology(evidence) {
  const nodes = managed(evidence, 'aws_eks_node_group');
  if (!nodes.length) throw new IncompleteEvidence('Managed node groups are missing');
  const privateSubnets = managed(evidence, 'aws_subnet').filter(row => row.address.startsWith('module.vpc.aws_subnet.private['));
  if (!privateSubnets.length) throw new IncompleteEvidence('Private subnets are missing');
  const nodeSubnetIds = [...new Set(nodes.flatMap(row => list(row.values.subnet_ids, 'node subnets')))];
  const associations = managed(evidence, 'aws_route_table_association');
  const routeTables = nodeSubnetIds.map(id => {
    const matches = associations.filter(row => row.values.subnet_id === id);
    if (matches.length !== 1) throw new IncompleteEvidence('Ambiguous node route table association');
    return known(matches[0].values.route_table_id, 'route table ID');
  });
  return { nodes, privateSubnets, nodeSubnetIds, routeTables };
}

function trustEquals(policy, principal, audienceKey, subjectKey, subject) {
  const statements = document(policy, 'Role trust').Statement;
  return statements.length === 1 && statements.every(statement =>
    statement.Effect === 'Allow' &&
    JSON.stringify(asList(statement.Action)) === JSON.stringify(['sts:AssumeRoleWithWebIdentity']) &&
    statement.Principal?.Federated === principal &&
    Object.keys(statement.Principal).length === 1 &&
    JSON.stringify(Object.keys(statement.Condition ?? {}).sort()) === JSON.stringify(['StringEquals']) &&
    Object.keys(statement.Condition.StringEquals).length === 2 &&
    statement.Condition.StringEquals[audienceKey] === 'sts.amazonaws.com' &&
    statement.Condition.StringEquals[subjectKey] === subject);
}

function checkResult(checks, observations) {
  const failed = checks.filter(check => !check.ok);
  return { verdict: failed.length ? 'FAIL' : 'PASS', checks, observations };
}

const checks = {
  'PLATFORM-BASELINE-01'(evidence, expect) {
    const cluster = one(evidence, 'aws_eks_cluster');
    expect(evidence.policy.kubernetes_versions.includes(known(cluster.version, 'Kubernetes version')), 'Kubernetes version matches the reviewed platform baseline');
    const addons = managed(evidence, 'aws_eks_addon');
    for (const name of ['coredns', 'kube-proxy', 'vpc-cni']) {
      expect(addons.some(row => row.values.addon_name === name && row.values.cluster_name === known(cluster.id, 'cluster identity')), name + ' is assigned to the demo cluster');
    }
    return { version: cluster.version, addons: addons.map(row => row.values.addon_name) };
  },
  'CLUSTER-ACCESS-01'(evidence, expect) {
    const cluster = one(evidence, 'aws_eks_cluster');
    const settings = list(cluster.vpc_config, 'cluster VPC settings')[0];
    expect(known(settings?.endpoint_private_access, 'private API access') === true, 'private API enabled');
    expect(known(settings?.endpoint_public_access, 'public API access') === false, 'public API disabled');
    return { vpc_config: settings };
  },
  'NODE-NETWORK-01'(evidence, expect) {
    const topology = nodeTopology(evidence);
    const subnetById = new Map(topology.privateSubnets.map(row => [row.values.id, row.values]));
    for (const id of topology.nodeSubnetIds) {
      const subnet = subnetById.get(id);
      expect(Boolean(subnet), 'node subnet belongs to the private subnet set');
      if (subnet) {
        let publicAddressing = subnet.map_public_ip_on_launch;
        if (publicAddressing === null && evidence.terraform.evidence_level === 'TERRAFORM_MOCK_STATE' &&
            evidence.policy?.provider_contracts?.new_custom_subnet_public_ipv4_default === false) {
          publicAddressing = false;
        }
        expect(known(publicAddressing, 'subnet public address setting') === false, 'new private subnet configuration retains the documented AWS public IPv4 default');
      }
    }
    const tables = managed(evidence, 'aws_route_table');
    for (const id of topology.routeTables) {
      const table = tables.find(row => row.values.id === id);
      if (!table) throw new IncompleteEvidence('A node route table is missing from the evidence');
      list(table.values.route, 'node route table routes');
    }
    const routes = [
      ...managed(evidence, 'aws_route').map(row => row.values),
      ...tables.flatMap(row => (row.values.route ?? []).map(route => ({ ...route, route_table_id: row.values.id })))
    ].filter(route => topology.routeTables.includes(route.route_table_id));
    expect(routes.every(route => !['0.0.0.0/0', '::/0'].includes(route.destination_cidr_block ?? route.cidr_block ?? route.destination_ipv6_cidr_block ?? route.ipv6_cidr_block)), 'node route tables have no default internet route');
    for (const template of managed(evidence, 'aws_launch_template')) {
      for (const network of template.values.network_interfaces ?? []) expect(network.associate_public_ip_address !== true, 'node launch interface does not request a public address');
    }
    return { node_subnets: topology.nodeSubnetIds, route_tables: topology.routeTables, observed_routes: routes,
      public_ipv4_contract: evidence.policy?.provider_contracts ?? null };
  },
  'ECR-PRIVATE-PULL-01'(evidence, expect) {
    const topology = nodeTopology(evidence);
    const vpc = one(evidence, 'aws_vpc');
    const endpoints = managed(evidence, 'aws_vpc_endpoint').map(row => row.values);
    for (const suffix of ['ecr.api', 'ecr.dkr']) {
      const endpoint = endpoints.find(row => row.service_name?.endsWith('.' + suffix));
      expect(Boolean(endpoint), suffix + ' endpoint exists');
      if (endpoint) {
        expect(endpoint.vpc_id === vpc.id && endpoint.vpc_endpoint_type === 'Interface', suffix + ' uses an interface endpoint in the node VPC');
        expect(known(endpoint.private_dns_enabled, 'endpoint DNS') === true, suffix + ' private DNS enabled');
        expect(list(endpoint.subnet_ids, 'endpoint subnets').every(id => topology.privateSubnets.some(row => row.values.id === id)), suffix + ' endpoint is in private subnets');
      }
    }
    const s3 = endpoints.find(row => row.service_name?.endsWith('.s3'));
    expect(Boolean(s3), 'S3 endpoint exists');
    if (s3) {
      expect(s3.vpc_id === vpc.id && s3.vpc_endpoint_type === 'Gateway', 'S3 gateway belongs to the node VPC');
      const attached = list(s3.route_table_ids, 'S3 route tables');
      expect(topology.routeTables.every(id => attached.includes(id)), 'S3 gateway covers every node route table');
    }
    return { services: endpoints.map(row => row.service_name), node_route_tables: topology.routeTables };
  },
  'ENDPOINT-ACCESS-01'(evidence, expect) {
    const vpc = one(evidence, 'aws_vpc');
    const endpoints = managed(evidence, 'aws_vpc_endpoint').filter(row => row.values.vpc_endpoint_type === 'Interface');
    if (!endpoints.length) throw new IncompleteEvidence('Interface endpoints are missing');
    const groupIds = [...new Set(endpoints.flatMap(row => list(row.values.security_group_ids, 'endpoint group attachments')))];
    if (!groupIds.length) throw new IncompleteEvidence('No endpoint security groups were attached');
    const rules = [];
    for (const id of groupIds) {
      const group = managed(evidence, 'aws_security_group').find(row => row.values.id === id);
      if (!group) throw new IncompleteEvidence('An attached group has no observed permissions');
      rules.push(...(group.values.ingress ?? []));
      rules.push(...managed(evidence, 'aws_security_group_rule').filter(row => row.values.security_group_id === id && row.values.type === 'ingress').map(row => row.values));
      rules.push(...managed(evidence, 'aws_vpc_security_group_ingress_rule').filter(row => row.values.security_group_id === id).map(row => ({
        protocol: row.values.ip_protocol, from_port: row.values.from_port, to_port: row.values.to_port,
        cidr_blocks: row.values.cidr_ipv4 ? [row.values.cidr_ipv4] : [],
        ipv6_cidr_blocks: row.values.cidr_ipv6 ? [row.values.cidr_ipv6] : []
      })));
    }
    expect(rules.length > 0, 'HTTPS ingress is present');
    for (const rule of rules) {
      expect(['tcp', '6'].includes(known(rule.protocol, 'endpoint protocol')) && rule.from_port === 443 && rule.to_port === 443, 'endpoint ingress is HTTPS only');
      expect(!rule.self && !(rule.ipv6_cidr_blocks?.length) && !rule.source_security_group_id && !(rule.security_groups?.length), 'ingress sources use the declared IPv4 range');
      const cidrs = list(rule.cidr_blocks, 'endpoint ingress source');
      expect(cidrs.length > 0 && cidrs.every(cidr => inside(cidr, vpc.cidr_block)), 'ingress source is inside the VPC');
    }
    return { attached_groups: groupIds, ingress_permissions: rules };
  },
  'VPC-SCOPE-01'(evidence, expect) {
    const defaults = managed(evidence, 'aws_default_vpc');
    expect(defaults.length === 0, 'the default VPC stays outside demo ownership');
    return { managed_default_vpcs: defaults.map(row => row.address) };
  },
  'CI-DEPLOY-01'(evidence, expect) {
    const policy = known(evidence.policy, 'demo policy');
    const ci = known(evidence.workflows?.['.github/workflows/ci.yml'], 'CI workflow');
    const release = known(evidence.workflows?.['.github/workflows/release.yml'], 'release workflow');
    expect(workflowTriggers(ci.on).includes('pull_request'), 'PR validation has a trigger');
    const jobs = Object.values(known(ci.jobs, 'CI jobs'));
    expect(jobs.length > 0, 'PR validation jobs are declared');
    for (const job of jobs) expect(hasReadOnlyTokenPermissions(job.permissions ?? ci.permissions), 'PR jobs have no OIDC token permission');
    const releaseTriggers = workflowTriggers(release.on);
    expect(releaseTriggers.length === 1 && releaseTriggers[0] === 'workflow_dispatch', 'release uses a manual trigger');
    const predicate = "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'";
    expect(release.jobs?.gate?.uses === './.github/workflows/ci.yml' &&
      asList(release.jobs?.publish?.needs).includes('gate'), 'publication requires the matrix CI gate');
    for (const name of ['publish', 'deploy']) {
      const job = known(release.jobs?.[name], 'release job ' + name);
      expect(job.if === predicate, name + ' is restricted to the approved main release');
      expect(!job.environment, name + ' uses the branch OIDC subject selected by the policy');
    }
    const provider = resource(evidence, 'aws_iam_openid_connect_provider.github');
    for (const role of ['publisher', 'deployer']) {
      const value = resource(evidence, 'aws_iam_role.' + role);
      expect(trustEquals(value.assume_role_policy, provider.arn, 'token.actions.githubusercontent.com:aud',
        'token.actions.githubusercontent.com:sub', 'repo:' + policy.github_repository + ':ref:refs/heads/main'), role + ' trust is restricted to the repository and ref');
    }
    return { approved_repository: policy.github_repository, approved_ref: 'refs/heads/main' };
  },
  'IMAGE-BUILD-01'(evidence, expect) {
    const image = known(evidence.image, 'image artifact observation');
    expect(known(image.digest_verified, 'image digest verification') === true, 'all OCI descriptors match the archived blobs');
    expect(known(image.layers_checked, 'layer count') > 0, 'image layers were inspected');
    expect(image.platform?.os === 'linux' && image.platform?.architecture === 'amd64', 'image platform matches the demo node platform');
    expect(list(image.marker_hits, 'marker scan').length === 0, 'synthetic build value is absent from configuration and exported layers');
    return { archive_sha256: image.archive_sha256, layers_checked: image.layers_checked, marker_hits: image.marker_hits };
  },
  'REGISTRY-IAM-01'(evidence, expect) {
    const registry = resource(evidence, 'aws_ecr_repository.demo');
    const publisher = identityPolicies(evidence, 'aws_iam_role.publisher');
    const deployer = identityPolicies(evidence, 'aws_iam_role.deployer');
    expect(publisher.attached.length === 0 && deployer.attached.length === 0, 'delivery roles have only their reviewed inline policies');
    expect(permission(publisher.policy, 'ecr:PutImage', registry.arn), 'publisher can publish to the demo repository');
    expect(!permission(publisher.policy, 'ecr:PutImage', registry.arn + '-other'), 'publisher cannot publish to another repository');
    expect(!permission(deployer.policy, 'ecr:PutImage', registry.arn), 'deployer cannot publish images');
    const nodes = managed(evidence, 'aws_eks_node_group');
    if (!nodes.length) throw new IncompleteEvidence('Node roles are missing');
    for (const node of nodes) {
      const role = managed(evidence, 'aws_iam_role').find(row => row.values.arn === node.values.node_role_arn);
      if (!role) throw new IncompleteEvidence('The node role cannot be resolved');
      const attached = managed(evidence, 'aws_iam_role_policy_attachment').filter(row => [role.values.id, role.values.name].includes(row.values.role));
      const pull = attached.some(row => row.values.policy_arn === 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly');
      expect(pull, 'node role has the declared ECR read policy');
      const approved = new Set(['AmazonEKSWorkerNodePolicy', 'AmazonEC2ContainerRegistryReadOnly', 'AmazonEKS_CNI_Policy', 'AmazonSSMManagedInstanceCore']
        .map(name => 'arn:aws:iam::aws:policy/' + name));
      expect(attached.every(row => approved.has(row.values.policy_arn)), 'node managed policy attachments stay within the reviewed AWS policy set');
      const inline = managed(evidence, 'aws_iam_role_policy').filter(row => [role.values.id, role.values.name].includes(row.values.role));
      const nodePolicy = { Statement: [
        ...(pull ? [{ Effect: 'Allow', Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'], Resource: '*' }] : []),
        ...inline.flatMap(row => document(row.values.policy, row.address).Statement)
      ] };
      expect(permission(nodePolicy, 'ecr:BatchGetImage', registry.arn) && permission(nodePolicy, 'ecr:GetDownloadUrlForLayer', registry.arn), 'node policies permit the required image reads');
      expect(!permission(nodePolicy, 'ecr:PutImage', registry.arn), 'node policies cannot publish');
    }
    return { registry: registry.arn, evidence_scope: 'declared identity policies and reviewed AWS managed policy attachments' };
  },
  'IMAGE-01'(evidence, expect) {
    const registry = resource(evidence, 'aws_ecr_repository.demo');
    const release = known(evidence.release, 'approved build record');
    expect(release.repository === registry.repository_url, 'release repository matches the Terraform repository');
    expect(/^sha256:[0-9a-f]{64}$/.test(release.digest) && release.digest === evidence.image?.digest, 'release digest matches the inspected artifact');
    const deployments = list(evidence.manifests, 'rendered manifests').filter(row => row.kind === 'Deployment');
    expect(deployments.length === 1, 'one demo Deployment is present');
    for (const deployment of deployments) {
      const pod = known(deployment.spec?.template?.spec, 'pod template');
      for (const container of [...(pod.initContainers ?? []), ...list(pod.containers, 'containers')]) {
        expect(container.image === release.repository + '@' + release.digest, 'container image matches the approved repository and digest');
      }
    }
    return { approved_image: release.repository + '@' + release.digest, source: release.source };
  },
  'DEPLOY-RBAC-01'(evidence, expect) {
    const documents = list(evidence.manifests, 'Kubernetes manifests');
    const entry = resource(evidence, 'aws_eks_access_entry.deployer');
    expect(JSON.stringify(entry.kubernetes_groups) === JSON.stringify(['matrix-deployer']), 'EKS deploy identity maps to the declared group');
    expect(entry.principal_arn === resource(evidence, 'aws_iam_role.deployer').arn, 'EKS access entry belongs to the deploy role');
    const deployer = identityPolicies(evidence, 'aws_iam_role.deployer');
    expect(permission(deployer.policy, 'eks:DescribeCluster', one(evidence, 'aws_eks_cluster').arn), 'deploy identity can read its cluster connection details');
    const bindings = documents.filter(row => ['RoleBinding', 'ClusterRoleBinding'].includes(row.kind) &&
      row.subjects?.some(subject =>
        subject.kind === 'Group' && ['matrix-deployer', 'system:authenticated'].includes(subject.name) ||
        subject.kind === 'User' && [entry.user_name, entry.username, entry.principal_arn].filter(Boolean).includes(subject.name)));
    expect(bindings.length === 1, 'one binding grants deploy permissions');
    for (const binding of bindings) {
      expect(binding.kind === 'RoleBinding' && binding.metadata?.namespace === evidence.policy.namespace, 'deploy grants are namespace-scoped');
      expect(binding.roleRef?.kind === 'Role', 'binding targets a namespace Role');
      const role = documents.find(row => row.kind === 'Role' && row.metadata?.name === binding.roleRef?.name && row.metadata?.namespace === binding.metadata?.namespace);
      if (!role) throw new IncompleteEvidence('Bound Kubernetes Role is missing');
      const rules = list(role.rules, 'RBAC rules');
      expect(rules.some(rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('deployments') && rule.verbs?.includes('patch')), 'release can update a Deployment');
      for (const rule of rules) {
        const apps = JSON.stringify(rule.apiGroups) === JSON.stringify(['apps']) && JSON.stringify(rule.resources) === JSON.stringify(['deployments']);
        const pods = JSON.stringify(rule.apiGroups) === JSON.stringify(['']) && JSON.stringify(rule.resources) === JSON.stringify(['pods']);
        const verbs = apps ? ['get', 'list', 'watch', 'patch', 'update'] : ['get', 'list', 'watch'];
        expect((apps || pods) && list(rule.verbs, 'RBAC verbs').every(verb => verbs.includes(verb)), 'RBAC permissions stay within the reviewed release actions');
      }
    }
    return { group: 'matrix-deployer', namespace: evidence.policy.namespace };
  },
  'WORKLOAD-IAM-01'(evidence, expect) {
    const role = resource(evidence, 'aws_iam_role.workload');
    const provider = managed(evidence, 'aws_iam_openid_connect_provider').find(row => row.address.startsWith('module.eks.'));
    if (!provider?.values.url || !provider.values.arn) throw new IncompleteEvidence('EKS workload OIDC issuer is missing');
    const issuer = provider.values.url.replace(/^https:\/\//, '');
    const subject = 'system:serviceaccount:' + evidence.policy.namespace + ':' + evidence.policy.service_account;
    expect(trustEquals(role.assume_role_policy, provider.values.arn, issuer + ':aud', issuer + ':sub', subject), 'workload role trust matches the exact service account');
    const serviceAccount = list(evidence.manifests, 'manifests').find(row => row.kind === 'ServiceAccount' &&
      row.metadata?.name === evidence.policy.service_account && row.metadata?.namespace === evidence.policy.namespace);
    expect(serviceAccount?.metadata?.annotations?.['eks.amazonaws.com/role-arn'] === role.arn, 'ServiceAccount references its workload role');
    expect(serviceAccount?.metadata?.annotations?.['eks.amazonaws.com/sts-regional-endpoints'] === 'true', 'ServiceAccount selects regional STS');
    const sts = managed(evidence, 'aws_vpc_endpoint').find(row => row.values.service_name?.endsWith('.sts'))?.values;
    expect(Boolean(sts) && sts.vpc_endpoint_type === 'Interface' && sts.private_dns_enabled === true &&
      sts.vpc_id === one(evidence, 'aws_vpc').id, 'private regional STS endpoint serves the workload VPC');
    const policy = identityPolicies(evidence, 'aws_iam_role.workload');
    expect(policy.attached.length === 0 && policy.inline.length === 1, 'workload role has one reviewed inline grant');
    const object = known(evidence.terraform.outputs.delivery_contract?.demo_object_arn, 'demo object ARN');
    expect(permission(policy.policy, 's3:GetObject', object), 'workload can read its demo object');
    expect(!permission(policy.policy, 's3:GetObject', object + '-other'), 'workload cannot read an unrelated object');
    expect(!permission(policy.policy, 's3:PutObject', object), 'workload role stays read-only');
    expect(policy.policy.Statement.every(statement => statement.Effect !== 'Allow' ||
      asList(statement.Action).every(action => action.toLowerCase() === 's3:getobject') &&
      asList(statement.Resource).every(arn => arn === object)), 'all workload allow statements stay within the single-object read grant');
    const accessBlock = resource(evidence, 'aws_s3_bucket_public_access_block.demo');
    for (const flag of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) {
      expect(known(accessBlock[flag], 'S3 public access setting') === true, 'demo object storage retains ' + flag);
    }
    const deployments = evidence.manifests.filter(row => row.kind === 'Deployment');
    for (const row of deployments) expect(row.spec?.template?.spec?.serviceAccountName === evidence.policy.service_account, 'demo pods use the intended service account');
    return { role: role.arn, subject, object };
  },
  'NETWORK-01'(evidence, expect) {
    const manifests = list(evidence.manifests, 'manifests');
    const services = manifests.filter(row => row.kind === 'Service');
    expect(services.length === 1, 'demo has one declared Service');
    for (const service of services) {
      expect((service.spec?.type ?? 'ClusterIP') === 'ClusterIP', 'Service uses a cluster-only address');
      expect(!(service.spec?.externalIPs?.length) && !service.spec?.externalName, 'Service has no external address');
      expect(service.metadata?.namespace === evidence.policy.namespace, 'Service belongs to the demo namespace');
    }
    const external = manifests.filter(row => ['Ingress', 'Gateway', 'HTTPRoute', 'TCPRoute', 'UDPRoute'].includes(row.kind));
    expect(external.length === 0, 'demo has no external routing objects');
    for (const deployment of manifests.filter(row => row.kind === 'Deployment')) {
      const pod = known(deployment.spec?.template?.spec, 'pod networking');
      expect(pod.hostNetwork !== true && !(pod.containers ?? []).some(container => container.ports?.some(port => port.hostPort)), 'pod has no host network entry point');
    }
    return { service_types: services.map(row => row.spec?.type ?? 'ClusterIP'), routing_objects: external.length };
  }
};

export const oracleIds = Object.keys(checks);

export function evaluate(matrixId, evidence) {
  if (!Object.hasOwn(checks, matrixId)) throw new Error('No oracle for matrix ' + matrixId);
  const observations = [];
  try {
    const results = [];
    const facts = checks[matrixId](evidence, (ok, rule) => results.push({ rule, ok: Boolean(ok) }));
    observations.push(facts);
    return { matrix_id: matrixId, ...checkResult(results, observations) };
  } catch (error) {
    if (!(error instanceof IncompleteEvidence)) throw error;
    return { matrix_id: matrixId, verdict: 'REVIEW', checks: [], observations, detail: error.message };
  }
}
