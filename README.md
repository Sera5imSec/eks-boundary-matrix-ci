# EKS Boundary Matrix CI

## Start here: [Current project workflow](docs/WORKFLOW.md)

> [!IMPORTANT]
> Read this guide to understand the workflow used in this project: source-to-matrix
> coverage, PR review with a local assistant following `AGENTS.md`, matrix selection,
> evidence and CI/CD. Source mutation checks run separately, on demand.

This project adapts the Fully Private Cluster pattern from Amazon EKS Blueprints
for Terraform. The source is pinned to upstream commit
`fc40e64615785b3dc4db88e57c45a6687ca026b5`.

The demonstration connects Terraform, a Docker image, Amazon ECR, EKS/Kubernetes
and GitHub Actions through one catalog with 14 matrices and 46 scenarios.
The catalog covers private cluster networking, registry and workload permissions,
deployment scope, image identity, build artifact contents and the cluster baseline.

The upstream Apache 2.0 license is retained. Local changes make the API endpoint
private explicitly, leave the account's default VPC unmanaged, pin module and
provider versions, and add the demo delivery identities and workload.

## Development workflow

Read the scoped source and dependency behavior, describe the rule and its
observable result, write the positive and negative scenarios, then walk backwards
from each source unit to its matrix and coverage decision. Add executable scenario
bindings after that review.

The source inventory parses Terraform fields inside named blocks, individual
Kubernetes objects, workflow jobs and Docker instructions. New source files,
new fields inside existing files and changed fingerprints require a coverage
decision. Each decision names the applicable matrices and scenario IDs, or
explains why the change has no security effect within this demonstration.

A decision can reuse an existing rule, add a scenario or add a matrix. The review
checks that a decision claiming a new matrix or scenario actually introduces one
relative to the base commit.

## Boundary Matrix Gate

Pull request or push → validate catalog and bindings → inventory source changes
→ review coverage decisions → select affected matrices → evaluate Terraform with
mocked providers and build the local image → run bound scenarios → publish the
report and enforce its result.

The selection is based on changed parsed source units. An endpoint access flag
selects its cluster-access matrix. Changes to gate implementation or an
unclassified source unit select the full catalog. A documentation-only change
selects zero matrices. The coverage decision file alone does not expand the
selection.

The required result includes the current-source fingerprints, one result for
every selected matrix, all bound scenario results and a passing normal control.
Missing evidence, unknown values and unresolved review decisions fail the gate.
The report retains the distinction between a failed rule and evidence that needs
review.

The Terraform run uses `terraform test` with mocked AWS, TLS, time, null and
cloud-init providers. Its evaluated resources are configuration evidence.
Policy fixtures test the implemented policy subset. Unsupported IAM constructs
request review. The image scanner reads an actual single-platform OCI archive,
verifies blob digests and checks its configuration, history and exported layers
for a synthetic build marker.

The VPC module leaves the optional public IPv4 assignment flag unset on new
custom subnets. The configuration oracle uses AWS's documented creation default
for that specific mocked case and records its source in the evidence. A missing
value in deployed state still requests review.

AWS API behavior, ECR publication and deployed Kubernetes observations remain
separate pending evidence until a test cloud environment is configured.

## Local checks

Use Linux with Node 22, Terraform 1.13.5 and a running Docker daemon with Buildx.

```sh
npm ci --ignore-scripts
npm run matrix:validate
npm test
terraform -chdir=patterns/fully-private-cluster init -backend=false -input=false
terraform -chdir=patterns/fully-private-cluster validate
npm run matrix:ci
```

For a change against a known Git base commit, run the gate with `--base`.

```sh
node security/matrix_ci.mjs review --base BASE_COMMIT_SHA
node security/matrix_ci.mjs run --base BASE_COMMIT_SHA
```

The coverage-only `review` command writes reports before returning a failure;
it does not execute Terraform, build an image or claim a matrix-runtime pass.
Normal CI runs this preflight before gate integrity tests and runtime preparation.
Inspect `artifacts/change-impact.json` and `artifacts/boundary-review.json` for
the exact unit fingerprint and candidate matrix IDs. Record the decision in
`security/matrices/code_decisions.json` and add scenario bindings when needed.
Coverage decisions are review inputs; they do not repair a failing rule.

The report and evidence are written under `artifacts/`. The normal CI job
uploads JSON and Markdown evidence through GitHub Actions.

For a stopped PR, use the [source coverage review guide](docs/SOURCE-REVIEW.md)
and [contributor instructions](AGENTS.md). The maintainer gives the PR link to
a local assistant, reviews the proposed coverage changes and authorizes a scoped
commit/push. A new PR commit triggers normal CI. No GitHub cloud-agent profile,
subscription or automatic assistant invocation is part of this process.

## Manual sensitivity

The separate sensitivity workflow runs only through `workflow_dispatch`. PR,
push and scheduled CI do not launch this source-mutation suite. The command also
rejects automatic GitHub Actions event contexts. Its source-mutating self-tests
also run in this separate manual workflow, outside the normal PR test command.

Each of the 14 matrices has one representative source edit. The runner builds a
passing control from the current source, copies source files to a disposable
directory, changes exactly one file, and prepares evidence again. Terraform edits
rerun formatting, initialization, validation and mocked evaluation. Kubernetes
and workflow edits are parsed and rendered again. The Dockerfile edit rebuilds
an actual OCI image without the build cache and scans its layers for a synthetic
secret. Unchanged Terraform/image evidence can be reused only with matching
source provenance. Provider binaries are shared as a cache; source and state are
isolated. The ordinary CI's controlled policy fixtures remain separate checks.

```sh
node security/matrix_sensitivity.mjs --matrix all
node security/matrix_sensitivity.mjs --matrix CLUSTER-ACCESS-01
```

A scenario ID resolves to its parent matrix, and comma-separated matrix IDs are
accepted. `DETECTED` requires a passing control, successful preparation and a
`FAIL` from the same matrix oracle. `SURVIVED`, `CONTROL_FAILED`, `ERROR`, stale
evidence and a changed original checkout fail the job. A build error or `REVIEW`
is never counted as a detection. An unknown input ID produces an input error and
exit code 2. Temporary directories are removed; source hashes, edits, per-matrix
observations and preparation evidence remain under `artifacts/source-sensitivity/`.
This checks one source edit per matrix, rather than all 46 scenario variants.
AWS and Kubernetes are not deployed by this workflow.

## Manual release setup

**[Local CD](docs/LOCAL-CD.md)** builds and HTTP-tests a main-branch image after
successful normal CI, then a local pull agent installs it on the loopback-only
Docker stand. The actual installation is recorded in GitHub Deployments under
`local-cd`. This local target is separate from the AWS release below.

The release workflow requires a successful matrix gate and a manual dispatch on
main. It publishes a single-platform image to the demo ECR repository and sends
its digest to the deployment job.

The policy and mocked configuration are bound to the private repository
`Sera5imSec/eks-boundary-matrix-ci`. Set the same `github_repository` Terraform
input before applying the infrastructure. When adopting another repository,
update the policy and test context together.

An administrator must bootstrap the demo namespace, RoleBinding, ServiceAccount
and initial Deployment, replacing the workload role and image placeholders.
The release job then needs the repository variables `AWS_PUBLISH_ROLE`,
`AWS_DEPLOY_ROLE` and `EKS_CLUSTER_NAME`, and a private runner with the
`matrix-private-deploy` label, AWS CLI and kubectl.

The runtime identity has read permission for one synthetic object. The demo
HTTP server returns a health response; it performs no AWS API requests.
