variable "github_repository" {
  description = "The owner/repository allowed to publish and deploy the demo."
  type        = string
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  repository_name = "matrix-demo"
  namespace       = "matrix-demo"
  service_account = "matrix-reader"
  release_subject = "repo:${var.github_repository}:ref:refs/heads/main"
  registry_arn    = "arn:${data.aws_partition.current.partition}:ecr:${local.region}:${data.aws_caller_identity.current.account_id}:repository/${local.repository_name}"
  demo_object_arn = "${aws_s3_bucket.demo.arn}/public-example.txt"
}

resource "aws_ecr_repository" "demo" {
  name                 = local.repository_name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.tags
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  release_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["sts:AssumeRoleWithWebIdentity"]
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = local.release_subject
      } }
    }]
  })
}

resource "aws_iam_role" "publisher" {
  name               = "${local.name}-publisher"
  assume_role_policy = local.release_trust
}

resource "aws_iam_role_policy" "publisher" {
  role = aws_iam_role.publisher.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = local.registry_arn
      }
    ]
  })
}

resource "aws_iam_role" "deployer" {
  name               = "${local.name}-deployer"
  assume_role_policy = local.release_trust
}

resource "aws_iam_role_policy" "deployer" {
  role = aws_iam_role.deployer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["eks:DescribeCluster"]
      Resource = module.eks.cluster_arn
    }]
  })
}

resource "aws_eks_access_entry" "deployer" {
  cluster_name      = module.eks.cluster_name
  principal_arn     = aws_iam_role.deployer.arn
  kubernetes_groups = ["matrix-deployer"]
  type              = "STANDARD"
}

resource "aws_s3_bucket" "demo" {
  bucket_prefix = "matrix-example-"
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "demo" {
  bucket                  = aws_s3_bucket.demo.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

locals {
  workload_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["sts:AssumeRoleWithWebIdentity"]
      Principal = { Federated = module.eks.oidc_provider_arn }
      Condition = { StringEquals = {
        "${module.eks.oidc_provider}:aud" = "sts.amazonaws.com"
        "${module.eks.oidc_provider}:sub" = "system:serviceaccount:${local.namespace}:${local.service_account}"
      } }
    }]
  })
}

resource "aws_iam_role" "workload" {
  name               = "${local.name}-reader"
  assume_role_policy = local.workload_trust
}

resource "aws_iam_role_policy" "workload" {
  role = aws_iam_role.workload.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = local.demo_object_arn
    }]
  })
}

output "delivery_contract" {
  value = {
    repository_arn  = aws_ecr_repository.demo.arn
    repository_url  = aws_ecr_repository.demo.repository_url
    publisher_role  = aws_iam_role.publisher.arn
    deployer_role   = aws_iam_role.deployer.arn
    workload_role   = aws_iam_role.workload.arn
    demo_object_arn = local.demo_object_arn
    namespace       = local.namespace
    service_account = local.service_account
  }
}

resource "aws_s3_bucket" "practice_logs" {
  bucket_prefix = "matrix-practice-logs-"
}

resource "aws_s3_bucket_public_access_block" "practice_logs" {
  bucket                  = aws_s3_bucket.practice_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
