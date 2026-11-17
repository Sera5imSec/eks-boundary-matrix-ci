# Reverse source-to-matrix review

The reviewed source consists of the selected upstream pattern and the local
delivery configuration, workload, Docker build and three workflows.

| Source area | Executable obligations |
| --- | --- |
| EKS endpoint settings | Private endpoint enabled, public endpoint disabled |
| EKS version and add-ons | Reviewed version, CoreDNS, kube-proxy and VPC CNI assigned to the cluster |
| Managed nodes and VPC routes | Private subnet placement, no public address request, no default internet route |
| VPC service endpoints | ECR API/registry private DNS, S3 gateway associations for node routes, endpoint ingress scope |
| Default VPC ownership | Default VPC remains outside this configuration |
| Delivery identities and workflows | Manual main release, exact OIDC repository/ref trust, required CI gate, no PR OIDC permissions |
| ECR roles and artifact identity | Publication role scope, node read attachment, deployed repository/digest match |
| Demo workload identity and storage | Exact service account trust, scoped object read, read-only grant, S3 public access restrictions |
| Kubernetes RBAC and service | Namespace-scoped deploy grants, internal Service and pod networking |
| Docker build | Actual image archive, verified digests, synthetic marker absence |
| Demo application | Reviewed fixed health response and build context |

The review records fingerprints for the initial parsed source units. A new file
or an edit inside an existing file requires a current decision. Candidate
bindings identify relevant scenarios, while scenario execution determines
whether the declared rule still holds.

This review follows the selected root configuration and its evaluated module
resources. The full upstream patterns collection and independent cloud runtime
behavior have separate scopes.
