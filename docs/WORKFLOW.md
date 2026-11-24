# How EKS Boundary Matrix CI works

The demonstration source code, matrix catalog, executable checks and GitHub Actions live in one repository. A matrix describes a security rule. An oracle checks that rule against collected evidence. CI connects a source change to the relevant matrices and records the result.

The infrastructure stack is **Terraform → AWS VPC and EKS → Kubernetes**. Cloud application delivery is defined through **GitHub Actions → Docker → Amazon ECR → EKS**. The catalog currently contains **13 matrices and 42 scenarios**. The working local delivery path is described in [Local CD](LOCAL-CD.md).

## 1. Project contents

The base is the selected `patterns/fully-private-cluster` example from [Amazon EKS Blueprints for Terraform](https://github.com/aws-ia/terraform-aws-eks-blueprints/tree/fc40e64615785b3dc4db88e57c45a6687ca026b5/patterns/fully-private-cluster), pinned to commit `fc40e64615785b3dc4db88e57c45a6687ca026b5`. Delivery configuration, roles, an image and a demonstration application are added to it. Other upstream examples are outside the project scope.

| Location | Purpose |
| --- | --- |
| [`patterns/fully-private-cluster/main.tf`](../patterns/fully-private-cluster/main.tf) | Defines the VPC, EKS, nodes and private network endpoints |
| [`patterns/fully-private-cluster/delivery.tf`](../patterns/fully-private-cluster/delivery.tf) | Defines ECR, publication and deployment roles, the application role and S3 |
| [`patterns/fully-private-cluster/tests/matrix.tftest.hcl`](../patterns/fully-private-cluster/tests/matrix.tftest.hcl) | Evaluates Terraform configuration with mocked providers |
| [`app/Dockerfile`](../app/Dockerfile) and [`app/server.mjs`](../app/server.mjs) | Build an image with a simple HTTP health endpoint |
| [`app/kubernetes/bootstrap.yaml`](../app/kubernetes/bootstrap.yaml) | Namespace, ServiceAccount and deployment permissions |
| [`app/kubernetes/workload.yaml`](../app/kubernetes/workload.yaml) | Deployment and internal Service |
| [`security/matrices/catalog.json`](../security/matrices/catalog.json) | Shared matrix catalog for the entire stack |
| [`security/matrices/bindings.json`](../security/matrices/bindings.json) | Links between source units, matrices and scenarios |
| [`security/matrices/code_decisions.json`](../security/matrices/code_decisions.json) | Coverage decisions for specific versions of source units |
| [`security/matrices/policy.json`](../security/matrices/policy.json) | Expected repository, namespace, image, permissions and other parameters |
| [`security/matrices/upstream.json`](../security/matrices/upstream.json) | Provenance of the selected upstream source |
| [`security/matrix_oracles.mjs`](../security/matrix_oracles.mjs) | Executable rules returning `PASS`, `FAIL` or `REVIEW` |
| [`security/matrix_cases.mjs`](../security/matrix_cases.mjs) | Positive controls and negative data fixtures |
| [`security/prepare_evidence.mjs`](../security/prepare_evidence.mjs) | Terraform evaluation, image building, manifest and workflow loading |
| [`security/matrix_ci.mjs`](../security/matrix_ci.mjs) | Orchestrates the normal CI run |
| [`security/matrix_sensitivity.mjs`](../security/matrix_sensitivity.mjs) | Separate manual run of source changes in disposable copies |
| [`security/source_mutations.mjs`](../security/source_mutations.mjs) | One controlled source mutation per matrix |
| [`.github/workflows/`](../.github/workflows) | Normal CI, manual sensitivity checks and manual release |
| `artifacts/` | Generated reports, logs, hashes and evaluation evidence; excluded from Git |

## 2. Matrix structure

**One matrix describes one coherent obligation at a system boundary.** For example, the Kubernetes API must be accessible through a private endpoint, with public access disabled. One obligation may span several files and layers.

`catalog.json` contains a `matrices` array. This is a shared catalog, with each entry describing its own boundary. JSON specifies the checking conditions; separate JavaScript modules execute the checks.

| Entry field | Meaning |
| --- | --- |
| `id` | Unique matrix ID, such as `CLUSTER-ACCESS-01` |
| `boundary` | The participants or components on either side of the boundary |
| `basis` | `SOURCE_CONTRACT`: a rule derived from inspected source or a dependency; `PROPOSED_POLICY`: an adopted demonstration policy |
| `source_refs` | IDs of entries in `source_inventory` in the same catalog |
| `documentation` | Link keys from the catalog's `sources` section |
| `obligation` | The property that must remain true |
| `evidence.ci` | Observations collected by CI for the check |
| `evidence.runtime` | Observations required from a deployed environment; the field's presence does not mean those observations have already been obtained |
| `variants` | Scenarios with an ID, `positive`/`negative` kind, condition and expected result |
| `binding` | Oracle ID, runner and evidence type |
| `implementation_sources` | Source paths and symbols associated with the implementation |

The following is an existing matrix. For readability, `implementation_sources` is shortened to one of its actual source units; the other fields are preserved:

```json
{
  "id": "CLUSTER-ACCESS-01",
  "boundary": "Deployment network and EKS nodes to the Kubernetes API",
  "basis": "SOURCE_CONTRACT",
  "source_refs": ["SRC-EKS-API"],
  "documentation": ["blueprint_doc", "eks_module_endpoint_defaults", "aws_eks_endpoint"],
  "obligation": "The Kubernetes API has private endpoint access enabled and public endpoint access disabled.",
  "evidence": {
    "ci": "Compare the resolved aws_eks_cluster VPC settings with the expected private and public flags.",
    "runtime": "Compare the deployed EKS endpoint settings with the plan and observe a successful authenticated read from the approved private network."
  },
  "variants": [
    {
      "id": "CLUSTER-ACCESS-01-PRIVATE-P",
      "kind": "positive",
      "case": "Both resolved endpoint flags match the intended private configuration.",
      "expected": "PASS"
    },
    {
      "id": "CLUSTER-ACCESS-01-PUBLIC-N",
      "kind": "negative",
      "case": "An offline plan fixture declares a public endpoint.",
      "expected": "REJECT"
    },
    {
      "id": "CLUSTER-ACCESS-01-NO-PRIVATE-N",
      "kind": "negative",
      "case": "An offline plan fixture has no private endpoint.",
      "expected": "REJECT"
    }
  ],
  "binding": {
    "oracle": "CLUSTER-ACCESS-01",
    "runner": "security/matrix_runtime.mjs",
    "execution": "configuration and controlled fixtures",
    "evidence_domains": ["TERRAFORM_MOCK_STATE"]
  },
  "implementation_sources": [
    {
      "path": "patterns/fully-private-cluster/main.tf",
      "symbols": ["module.eks.0.cluster_endpoint_public_access"]
    }
  ]
}
```

**Matrices and scenarios have different IDs.** `CLUSTER-ACCESS-01` is a matrix; `CLUSTER-ACCESS-01-PUBLIC-N` is one of its scenarios.

## 3. Connecting source code to checks

```text
File + symbol within the file
  → bindings.json: candidate matrices
  → code_decisions.json: decision for the current fingerprint
  → catalog.json: obligation and scenarios
  → matrix_oracles.mjs: check against observed evidence
  → report with status and reason
```

For example, an entry in `bindings.json` connects a specific Terraform field to a matrix:

```json
{
  "path": "patterns/fully-private-cluster/main.tf",
  "symbol_prefixes": ["module.eks.0.cluster_endpoint_public_access"],
  "matrix_ids": ["CLUSTER-ACCESS-01"]
}
```

A coverage decision records `path`, `symbol`, `fingerprint`, `decision`, `matrix_ids`, `variant_ids` and `reason`. A fingerprint is the SHA-256 hash of a source unit's representation. A new field value changes its fingerprint: the previous decision no longer applies to the current source. Deleting a unit requires a decision with `change: "deleted"`.

**A binding identifies what to run. A decision records the coverage review. An oracle checks whether the rule holds.** Approving a binding does not turn a rule violation into a passing result.

## 4. Matrix development workflow

```text
Choose the project scope and pin versions
  → inspect source code and dependency behavior
  → identify boundaries and obligations
  → define the observation that distinguishes correct behavior from a violation
  → describe positive and negative scenarios in the catalog
  → implement oracles and data fixtures
  → bind source code, matrices and scenarios
  → perform a reverse source-to-coverage review
  → record decisions for the current fingerprints
  → check integrity and run the full normal baseline
  → separately run manual sensitivity checks with controlled source mutations
  → submit the verified change for review
```

The reverse review asks: **which rules exist in this source unit, and how is each rule checked?** Its results for the current scope are described in [`REVERSE_COVERAGE_AUDIT.md`](../security/REVERSE_COVERAGE_AUDIT.md).

Automated inventory supports this review by requiring a current decision for each recognized unit. The change author and reviewer assess the meaning of a new rule and whether its scenarios are sufficient.

### When a new matrix is needed

| Change | Decision | Required update |
| --- | --- | --- |
| The existing rule and scenarios fully apply | `existing_rule` | Current fingerprint and binding rationale |
| The rule is unchanged, but a new way to violate it appears | `add_variant` | Catalog scenario, executable data fixture, bindings and decision |
| A new boundary or independent obligation appears | `new_matrix` | Matrix, oracle, positive and negative scenarios, bindings and decision |
| The change has no security effect within the selected scope | `not_security` | Rationale; matrix and scenario lists remain empty |

For example, an additional safe health-response format may be justified as `not_security`. New application access to another storage resource requires a review of permissions, networking and data: it may require extending `WORKLOAD-IAM-01` or adding a matrix.

When comparing against a base commit, CI checks that a `new_matrix` decision actually adds a matrix and an `add_variant` decision adds a scenario. Changing the decision label alone does not satisfy this requirement.

## 5. What coverage review detects

Both **new files** and **changes inside existing files** are checked. Parsing is implemented in [`change_impact.mjs`](../security/change_impact.mjs); decision validation and matrix selection are implemented in [`boundary_review.mjs`](../security/boundary_review.mjs).

| Format | Parsed unit |
| --- | --- |
| Terraform `.tf`/`.tfvars` | Field of a named block, such as `module.eks.0.cluster_endpoint_public_access` |
| Kubernetes YAML | Object and its top-level fields, such as `Deployment.matrix-demo.spec`; the entire nested `spec` structure contributes to the fingerprint |
| Workflow YAML | Workflow fields and individual jobs |
| Dockerfile | Instructions and the full file text, including directives |
| Other recognized source files | Entire file |

`.git`, `.terraform`, `node_modules` and `artifacts` are excluded from traversal. Engine files in `security/` and Node dependencies are treated as changes to the checking system and select the full suite. Ordinary Markdown documents in `docs/` are not source units.

Before selecting matrices, the validator checks **the entire current inventory**, including unchanged files. An older overlooked unit therefore also causes a coverage error. After local CD was added, decisions were recorded for 141 recognized units; this number describes the parsing structure, not the number of proven rules.

## 6. Normal Boundary Matrix Gate

Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Events: Pull Request, push to `main`, manual dispatch and invocation from the release workflow.

```text
PR / push to main / manual dispatch
  → check out source and install pinned tools
  → validate the catalog, oracles, scenarios and bindings
  → validate decisions for the entire current source inventory
  → write impact, coverage and source-review handoff reports before enforcing preflight
  → unresolved coverage: stop before build; maintainer may start an agent task
  → run gate integrity tests
  → compare against the base commit and inspect changed/deleted units
  → validate coverage decisions for the changes
  → select affected matrices
  → collect evidence from Terraform, Docker, Kubernetes YAML and workflows
  → verify evidence against current source fingerprints
  → run positive controls and negative scenarios for selected matrices
  → check result completeness
  → publish the PASS / FAIL report and upload artifacts
```

An inventory, catalog or coverage error stops execution **before the oracles run**. This is a preflight failure; the report may not yet contain results for individual matrices.

CI now starts with `node security/matrix_ci.mjs review --base BASE_COMMIT_SHA`
(or `review --full` for a manual/initial run). It writes `catalog-validation.json`,
`change-impact.json`, `boundary-review.json`, `source-review.json` and
`source-review.md` before enforcing source-review errors. Parser/base errors are
recorded explicitly, without inventing successful classifications. A passing
coverage-only command leaves runtime and matrix status as `NOT_RUN`.

For unresolved coverage, the maintainer can use the **Boundary Coverage** custom
agent or `@copilot` on the existing PR, following [the handoff guide](AGENT-HANDOFF.md).
The agent proposes and implements a reasoned coverage decision; it does not merely
renew hashes. A new commit starts a new CI run once workflow execution is permitted.
This is a manually initiated task, not an agent automatically launched by a failing
workflow. Workflow approval and merge remain subject to GitHub/repository settings.
The normal gate repeats source review before using fresh runtime evidence.

### Matrix selection

| Situation | Selected checks |
| --- | --- |
| Manual normal CI dispatch or `run --full` | All 13 matrices |
| No base commit on the first run | Full suite |
| PR/push has a base commit and current decisions | Union of matrices from matching bindings and decisions for changed units |
| Only the EKS endpoint public-access field changes | `CLUSTER-ACCESS-01`, provided other source files and decisions are unchanged |
| Engine, catalog, policy, dependencies, `ci.yml` or `matrix-sensitivity.yml` changes | Full suite |
| Only README/`docs/*.md` documentation changes | Zero matrices; catalog validation and integrity tests still run |
| Only the decisions file changes | Does not expand selection by itself; decisions are still validated |
| A unit is unclassified or lacks a required binding | Review is required; a fallback full selection does not cancel the coverage error |

Selection follows source units and their bindings. There is no fixed rule that any change in a directory selects N matrices. With zero selected matrices, the gate skips image building and Terraform evaluation.

### What is checked

Terraform runs `fmt`, initialization with the lock file, `validate` and `terraform test` with mocked AWS, TLS, time, null and cloud-init providers. Network, cluster and IAM settings are extracted from evaluated resources. Local oracles evaluate the supported subset of IAM statements; unsupported conditions require `REVIEW`.

Docker builds **an actual single-platform `linux/amd64` OCI image**. The check verifies content digests and searches the configuration, history and layers for a synthetic secret marker. Kubernetes manifests receive this image's repository/digest and a role from the evaluated configuration. Workflow permissions are read from the current YAML files.

This evaluates configuration and a local artifact. Creating AWS resources, publishing to ECR and observing a running cluster belong to a separate deployment stage.

### Reading PASS and FAIL

| Check | Observation | Scenario result |
| --- | --- | --- |
| Positive control on current source | Oracle returns `PASS` | `PASS` |
| Negative scenario using a prepared data fixture | Oracle returns the expected `FAIL` | `PASS`: the violation was detected |
| Current source violates a rule | Oracle returns `FAIL` on the positive control | Matrix and CI `FAIL` |
| Required evidence is unknown or unsupported | Oracle returns `REVIEW` | Gate does not pass |

A passing gate requires every expected scenario, without omissions or duplicates, a passing normal control and current source evidence. Normal gate exit codes are `0` for `PASS` and `1` for `FAIL`; command or argument errors return `2`.

A failed workflow produces a failing GitHub status. To make that status block merging, configure it as a required check in the branch rules. Branch protection is a separate repository setting.

## 7. All matrices and their separate source mutations

The last column applies to the **manual** sensitivity run. Normal CI does not perform these source edits.

| Matrix | Scenarios | Rule checked | Edit in a disposable copy |
| --- | ---: | --- | --- |
| `PLATFORM-BASELINE-01` | 3 | Reviewed Kubernetes version; CoreDNS, kube-proxy and VPC CNI belong to the same cluster | EKS version `1.35` → `1.30` |
| `CLUSTER-ACCESS-01` | 3 | Private API enabled, public API disabled | Public endpoint → `true` |
| `NODE-NETWORK-01` | 3 | Nodes in private subnets, without public IPs or an internet route | Add an internet gateway and a default route for nodes |
| `ECR-PRIVATE-PULL-01` | 3 | Private ECR API/DKR with DNS, plus an S3 endpoint for node routes | Disable private DNS on the ECR API endpoint |
| `ENDPOINT-ACCESS-01` | 3 | Interface endpoint ingress restricted to HTTPS from the VPC CIDR | CIDR → `0.0.0.0/0` |
| `VPC-SCOPE-01` | 2 | The account's default VPC remains outside the demonstration's management scope | `manage_default_vpc` → `true` |
| `CI-DEPLOY-01` | 5 | PRs have no OIDC grant; cloud release is manual from main; local delivery requires successful CI for the exact commit | Add `id-token: write` to normal CI |
| `IMAGE-BUILD-01` | 3 | Build secrets are absent from image configuration, history and layers | Dockerfile copies a synthetic build secret into a layer; rebuild the image |
| `REGISTRY-IAM-01` | 4 | Only a dedicated role publishes to its ECR repository; nodes can pull; deployer cannot publish | Expand the publication resource to `*` |
| `IMAGE-01` | 3 | Deployment uses the expected repository and build digest | Replace the digest with `:latest` |
| `DEPLOY-RBAC-01` | 3 | Deployment is restricted to the namespace and allowed actions | Replace allowed Role actions with `*` |
| `WORKLOAD-IAM-01` | 5 | Exact ServiceAccount/IRSA, access to its own object, read-only permissions, S3 public-access block and private regional STS | Add `s3:DeleteObject` to the application role |
| `NETWORK-01` | 2 | Application uses an internal Service without public ingress | `ClusterIP` → `LoadBalancer` |
| **Total** | **42** | **13 matrices** | **One source mutation per matrix** |

## 8. Manual sensitivity checks

Workflow: [`.github/workflows/matrix-sensitivity.yml`](../.github/workflows/matrix-sensitivity.yml), named **Manual Matrix Sensitivity**. It runs only through manual `workflow_dispatch`. PRs, pushes and schedules do not start it automatically.

```text
Manual dispatch with an ID or all
  → validate the catalog and run separate mutation-runner tests
  → fresh normal control: the original source rule must pass
  → create a disposable source copy
  → make one controlled edit to a source file
  → collect fresh evidence for the affected domain
  → run the same oracle against the new evidence
  → DETECTED / SURVIVED / CONTROL_FAILED / ERROR
  → verify that original files are unchanged
  → remove disposable copies and save the report
```

Terraform changes repeat configuration evaluation and validation; YAML changes repeat parsing and value substitution; Dockerfile changes rebuild without cache and inspect the actual image layers. Unchanged evidence can be reused only when its source provenance matches. Provider binaries share a cache, while source files and state remain separate for each disposable copy.

| Status | Meaning |
| --- | --- |
| `DETECTED` | Normal control passed, evidence preparation succeeded and the same oracle returned `FAIL` after the edit |
| `SURVIVED` | The edit reached the evaluated evidence, but the oracle returned `PASS` |
| `CONTROL_FAILED` | The original normal control already fails |
| `ERROR` | Evidence could not be prepared or evaluated; this also includes oracle `REVIEW` |

A successful manual workflow means all selected mutations returned **`DETECTED`**. A build error alone is not a detection. Changes to the original checkout or stale evidence also fail the run.

This check sends the changed copy directly to the same oracle through fresh evidence. Coverage decisions are deliberately not updated: it tests rule sensitivity separately from the normal gate's rejection of an unknown fingerprint.

**Negative data fixtures in normal scenarios and source mutations are separate mechanisms.** The former run in normal CI. The latter run in a separate manual workflow. Selecting a scenario ID in the manual workflow runs the representative source mutation for its parent matrix; there is no individual source mutation for each of the 42 scenarios.

## 9. Running the checks

Full-run environment: Linux, Node 22, Terraform 1.13.5, a Docker daemon and Buildx. Run commands from the repository root.

```sh
npm ci --ignore-scripts
npm run matrix:validate
npm test
```

Full normal gate:

```sh
node security/matrix_ci.mjs run --full
```

Change-based selection against an existing base commit:

```sh
node security/matrix_ci.mjs run --base BASE_COMMIT_SHA
```

Separate manual source-mutation runs:

```sh
node security/matrix_sensitivity.mjs --matrix all
node security/matrix_sensitivity.mjs --matrix CLUSTER-ACCESS-01
node security/matrix_sensitivity.mjs --matrix CLUSTER-ACCESS-01,IMAGE-01
```

In GitHub, use **Actions → Boundary Matrix Gate → Run workflow** for a full normal run. For source mutations, use **Actions → Manual Matrix Sensitivity → Run workflow → matrix_id**. The input accepts a matrix ID, scenario ID, comma-separated list or `all`. An unknown ID produces an input error with exit code `2`.

`npm test` runs gate integrity tests. Source mutations and their separate self-tests are excluded from this command.

## 10. Reading the results

| File under `artifacts/` | Contents |
| --- | --- |
| `catalog-validation.json` | Completeness of the catalog, bindings and decisions for the current inventory |
| `change-impact.json` | Changed files, symbols and fingerprints |
| `boundary-review.json` | Coverage decisions for changed units |
| `source-review.json` / `source-review.md` | Combined preflight verdict and agent handoff, including early coverage failures |
| `matrix-selection.json` | Selected matrices and selection rationale |
| `terraform-test.jsonl` | Terraform evaluation log |
| `evidence.json` | Configuration, image and source-provenance evidence |
| `matrix-runtime.json` | Control and observation for each executed scenario |
| `matrix-status.json` and `matrix-status.md` | Gate result and rejection reasons |
| `source-sensitivity/run-*/` | Control, source edits, hashes and manual mutation results |

If execution stops early, later files are not created. Old local artifacts are not results of a new run. In GitHub, use the artifact from **the specific run**: `boundary-matrix-evidence` or `manual-matrix-sensitivity`.

Verified runs for source baseline `39ef230`:

- [Full normal CI](https://github.com/Sera5imSec/eks-boundary-matrix-ci/actions/runs/44363323014): 13 matrices, all 41 scenarios passed.
- [Manual source mutations](https://github.com/Sera5imSec/eks-boundary-matrix-ci/actions/runs/44363397825): all 13 mutations detected, original source files preserved.

In an additional check on November 20, 2026, a public EKS endpoint, a new unreviewed S3 resource and a `:latest` image were initially stopped by coverage review. After temporary decisions were recorded for two changes, the corresponding oracles also returned `FAIL`: `CLUSTER-ACCESS-01-PRIVATE-P` and `IMAGE-01-DIGEST-P`. The edits were reverted; the final full run of that baseline again passed all 41 scenarios.

The catalog's `verification_status` field is a recorded historical snapshot, not a GitHub Actions query; its hosted CI entry still contains `PENDING`. The result of a particular run is determined by that run's report and status.

## 11. Manual cloud CD and current evidence scope

Workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml), named **Manual EKS Release**.

```text
Manual dispatch on main
  → successful Boundary Matrix Gate
  → OIDC and a dedicated publication role
  → build and publish the image to ECR
  → pass repository@sha256:digest
  → OIDC and a separate deployment role
  → runner inside the private network
  → update the Deployment image in namespace matrix-demo
  → wait for rollout
```

A real release requires provisioned infrastructure, bootstrapped Kubernetes objects, OIDC trust for the exact repository and `main`, GitHub variables `AWS_PUBLISH_ROLE`, `AWS_DEPLOY_ROLE` and `EKS_CLUSTER_NAME`, and a Linux runner labeled `matrix-private-deploy` with AWS CLI and kubectl. The workflow region is `us-west-2`.

The workflow is prepared, but this baseline has no successful AWS deployment yet. Normal CI and manual sensitivity do not run `terraform apply` in the cloud. The application returns a health response and does not call S3; actual application access to the object requires a separate observation in a deployed environment.
