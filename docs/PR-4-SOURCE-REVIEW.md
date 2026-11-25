# PR #4: review of the added log bucket

Base: `e70d71887d340b23f67b4c1b73e15b92d9606f6c`. Original source commit:
`555040112a19a5db758b9943fa5e4ae983223eda`.

The initial Actions run classified `resource.aws_s3_bucket.practice_logs.0.bucket_prefix`
as `added`, with no previous fingerprint or candidate matrix. It stopped at
`SOURCE_REVIEW / REVIEW_REQUIRED`; the oracles were not run.

## Decision and implementation

The new log bucket has no workload grant or application caller. The existing
`WORKLOAD-IAM-01` oracle checks public access controls only at
`aws_s3_bucket_public_access_block.demo`. Merely binding the log bucket to that
matrix would not inspect its protection. This is an independent storage boundary,
so its decision is `new_matrix`: `STORAGE-PRIVATE-01`.

The new oracle enumerates managed S3 buckets, requires resolved distinct bucket
IDs and checks that each bucket has exactly one public access block attached to
that ID, with all four flags enabled. The configuration adds that protection for
`practice_logs`. The Terraform test gives this bucket its own ID and ARN, avoiding
a false association caused by the provider-wide demo identity.

Scenarios:

| ID | Required observation |
| --- | --- |
| `STORAGE-PRIVATE-01-BLOCKED-P` | Every managed bucket has its own complete protection |
| `STORAGE-PRIVATE-01-MISSING-N` | Missing log-bucket protection is rejected even while demo protection remains |
| `STORAGE-PRIVATE-01-FLAG-N` | Disabled log-bucket public policy restriction is rejected |
| `STORAGE-PRIVATE-01-TARGET-N` | Protection targeting a different bucket is rejected |

Normal integrity tests also exercise all four individual flags and require
`REVIEW` for missing settings or ambiguous mock identities. Coverage decisions
use parser-generated fingerprints for the six new storage fields and the changed
Terraform fixture. Other source fingerprints are preserved.

The catalog now contains 14 matrices and 46 scenarios. Its engine/catalog changes
select the full normal suite for this PR. The separate manual source-mutation
registry includes a representative log-bucket edit; it is not invoked by this
review or by normal PR CI.

## Evidence limits

This adopts an explicit private-storage configuration policy. It does not claim
that the original newly declared bucket was publicly reachable. AWS account and
organization controls, effective IAM and deployed anonymous access have not been
observed. The four controls and their interaction are described in the
[AWS S3 documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html).

Runtime results belong to the Actions run for the reviewed commit. Source review
and unit tests alone do not establish Terraform/OCI runtime success. No AWS apply,
deployment, PR merge or source-mutation execution is part of this task.

## Local verification

- `npm test`: exit 0; 43 tests passed.
- `node security/matrix_ci.mjs review --base e70d71887d340b23f67b4c1b73e15b92d9606f6c`:
  exit 0; seven changed units reviewed, 147 current source units, no errors.
- `terraform fmt -check -recursive`: exit 0 with Terraform 1.13.5.
- `python3 -m unittest discover -s delivery -p 'test_*.py'`: not completed locally;
  `python3` is unavailable in the Windows command environment.
- `node security/matrix_ci.mjs run --base e70d71887d340b23f67b4c1b73e15b92d9606f6c --terraform <Terraform-1.13.5>`:
  exit 1 during module initialization because local Git/Schannel credentials were
  unavailable. No matrix-runtime verdict was obtained locally. The local Docker
  daemon was also unavailable. Hosted PR CI is required for the full normal run.
- The manual registry contains 14 definitions and the new definition has a unique
  source anchor. No source-mutation run or source-mutating self-test was executed.

The previous decisions were compared structurally with the original PR base:
six new decisions were added, only the Terraform fixture decision changed, and
all other 141 recorded decisions were preserved exactly.
