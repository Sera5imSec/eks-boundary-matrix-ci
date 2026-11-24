# Source coverage review and GitHub Agent handoff

The normal CI prepares source-review reports before it stops for unresolved coverage. A maintainer can then ask GitHub Copilot or the repository's **Boundary Coverage** custom agent to analyze the PR and prepare justified changes. This is a manually initiated handoff, not an automatic cloud-agent invocation from Actions.

## End-to-end flow

```text
Developer opens or updates a PR
  -> checkout and install pinned tools
  -> source review: catalog, current inventory and changed units
     -> parse path + symbol and compute SHA-256 fingerprints
     -> write validation, impact, coverage review and handoff reports
     -> unresolved or invalid coverage: FAIL before any build
        -> maintainer starts a task for the existing PR
        -> agent reads the diff, reports, rules and executable checks
        -> agent implements a justified coverage decision
        -> commit to the PR branch
        -> maintainer reviews the diff and permits Actions if required
        -> a NEW CI run starts from checkout
     -> coverage is current: continue
  -> gate integrity tests
  -> gate repeats source review; select affected matrices against base SHA
  -> fresh Terraform mock evaluation and actual local OCI image build
  -> evidence freshness checks
  -> positive controls and negative scenarios; deterministic oracles
  -> reports and artifact upload
  -> review and merge according to repository rules
  -> successful CI for the main commit permits Local CD
```

Delivery admission tests are a parallel CI job. Source parsing, tool installation or a build can fail independently of a matrix rule. A failed source review ends the job; it does not hold a running job open for human input.

## Fingerprints and decisions

A unit is addressed by `path` plus `symbol`. Its fingerprint is SHA-256 of the canonical JSON representation of the parsed value. The parser sorts object keys before hashing. Terraform comments and whitespace can therefore leave a value's fingerprint unchanged; Dockerfiles also have a whole-text unit. A Git commit SHA and an OCI image digest identify different objects.

The impact report labels units `added`, `modified` or `deleted` relative to the base commit. Review matches an exact current fingerprint to `code_decisions.json`; deletions need a decision for the previous fingerprint with `change: "deleted"`. Re-running the same source does not require new entries. Changing a recognized unit's value can require a new decision even if its candidate matrix remains unchanged.

All recognized current units are reviewed, including unchanged ones. The inventory is defined by the parser; it is not a claim that every behavior has been proven secure. Application code and tests can enter review too. A documentation-only change can select zero matrices, while catalog and integrity checks still run.

| Decision | Required implementation |
| --- | --- |
| `existing_rule` | Current fingerprint, applicable matrix/scenario IDs, rationale and any missing source binding |
| `add_variant` | Executable scenario or fixture, catalog entry, scenario binding and updated decision |
| `new_matrix` | Boundary, obligation, oracle, controls, scenarios, fixtures, bindings and decision |
| `not_security` | Specific rationale within the defined scope; no matrix/scenario IDs |

The agent proposes coverage by reading code and checks; SHA-256 only identifies changed content. Reference validation cannot establish semantic completeness. Review the agent's rationale and actual assertions. A correct journal entry does not make an unsafe configuration pass an oracle.

## Starting a task on GitHub

Enable Copilot cloud agent for the repository using a supported account and plan. Once the profile is available in GitHub, select **Boundary Coverage** from the Agents interface and explicitly supply the PR and base SHA. For an existing PR, a comment mentioning `@copilot` is another supported entry point. Do not assume a generic Agents task will automatically target the intended PR branch.

Suggested task:

```text
Review source coverage for this PR using AGENTS.md and docs/AGENT-HANDOFF.md.
Use the actual PR base SHA and inspect the source-review artifacts or regenerate them.
Implement justified existing_rule, add_variant, new_matrix or not_security decisions,
including executable checks and bindings where needed. Preserve established policy.
Run normal tests and the gate; report exact results and incomplete checks.
Commit the scoped changes to this PR branch. Do not merge or run source mutations.
```

By default, Copilot changes require a maintainer to choose **Approve and run workflows**. GitHub offers a separate setting for automatic workflow execution; this repository change does not enable it. Workflow-run approval and PR review/merge are different actions. Required reviews and required status checks depend on repository settings; the author cannot approve their own PR. No fixed number of approvals or execution time is promised.

Official references: [custom agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration), [agent branch access](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations), [workflow approval](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output).

## Local commands and artifacts

```sh
# Coverage only: no Terraform execution or image build.
node security/matrix_ci.mjs review --base BASE_COMMIT_SHA

# Full current inventory review, without a Git comparison.
npm run matrix:review

# Normal gate, including runtime evidence when matrices are selected.
node security/matrix_ci.mjs run --base BASE_COMMIT_SHA
```

The `review` command returns `0` for a passing source review or `1` for a failed review. CLI argument errors return `2`. A source-review pass is not a matrix-runtime pass. Before runtime, the matrix status and runtime files are marked `NOT_RUN`; a failed preflight records `FAIL` at phase `SOURCE_REVIEW`.

| Artifact | Meaning |
| --- | --- |
| `catalog-validation.json` | Catalog consistency and decisions for the whole current inventory |
| `change-impact.json` | Changed paths, symbols, classifications and before/after fingerprints |
| `boundary-review.json` | Candidate matrices, matched decisions and unresolved coverage |
| `source-review.json` / `source-review.md` | Combined preflight verdict and readable agent handoff |
| `matrix-selection.json` | Selected matrices, or `blocked` until review passes |
| `matrix-runtime.json` | `NOT_RUN` before runtime, then actual scenario results |
| `matrix-status.json` / `matrix-status.md` | Current gate status; `NOT_RUN` after a passing coverage-only command |

If parsing or base resolution fails, error reports are written without inventing changed units or a successful classification. A failure before Node and dependencies are available can prevent report generation. Artifact upload runs with `if: always()` but can upload only files that were actually generated.

## Oracle outcomes, delivery and manual sensitivity

Coverage `REVIEW_REQUIRED` means a source decision is missing or invalid. Oracle `REVIEW` means evidence or evaluator support is insufficient. Both prevent a green gate, at different stages. A negative fixture receiving its expected oracle rejection passes that scenario; a violation in the current source fails the normal control.

Source mutation sensitivity remains a separate manual workflow. This handoff does not run it on PRs, pushes or a schedule.

Local CD follows successful main CI, rebuilds and smoke-tests an image for that commit, publishes the artifact and hands it to the running local delivery agent for installation and health checks. AWS/EKS release remains a separate manual workflow requiring configured cloud resources and access. CI evidence can support an audit, but it does not by itself establish SOC 2 compliance or zero false positives.
