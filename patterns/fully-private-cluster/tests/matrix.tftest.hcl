mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-west-2a", "us-west-2b", "us-west-2c"]
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
      arn        = "arn:aws:iam::111122223333:role/matrix-fixture"
    }
  }
  mock_data "aws_partition" {
    defaults = {
      partition          = "aws"
      dns_suffix         = "amazonaws.com"
      reverse_dns_prefix = "com.amazonaws"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_eks_addon_version" {
    defaults = {
      version = "v1.0.0-eksbuild.1"
    }
  }
  mock_resource "aws_vpc" {
    defaults = {
      id         = "vpc-fixture"
      cidr_block = "10.0.0.0/16"
    }
  }
  mock_resource "aws_eks_cluster" {
    defaults = {
      arn                   = "arn:aws:eks:us-west-2:111122223333:cluster/fully-private-cluster"
      endpoint              = "https://fixture.eks.example.test"
      certificate_authority = [{ data = "Zml4dHVyZQ==" }]
      identity              = [{ oidc = [{ issuer = "https://oidc.eks.us-west-2.amazonaws.com/id/MATRIX" }] }]
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/matrix-fixture"
    }
  }
  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::111122223333:policy/matrix-fixture"
    }
  }
  mock_resource "aws_launch_template" {
    defaults = {
      id             = "lt-0123456789abcdef0"
      latest_version = 1
    }
  }
  mock_resource "aws_security_group_rule" {
    defaults = {
      source_security_group_id = ""
    }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
    }
  }
  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-west-2:111122223333:repository/matrix-demo"
      repository_url = "111122223333.dkr.ecr.us-west-2.amazonaws.com/matrix-demo"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::matrix-example-fixture"
      id  = "matrix-example-fixture"
    }
  }
}

mock_provider "tls" {}
mock_provider "time" {}
mock_provider "null" {}
mock_provider "cloudinit" {}

override_resource {
  target = aws_iam_role.publisher
  values = { arn = "arn:aws:iam::111122223333:role/matrix-publisher" }
}

override_resource {
  target = aws_iam_role.deployer
  values = { arn = "arn:aws:iam::111122223333:role/matrix-deployer" }
}

override_resource {
  target = aws_iam_role.workload
  values = { arn = "arn:aws:iam::111122223333:role/matrix-reader" }
}

override_resource {
  target = module.eks.aws_iam_role.this[0]
  values = { arn = "arn:aws:iam::111122223333:role/matrix-cluster" }
}

override_resource {
  target = module.eks.module.eks_managed_node_group["initial"].aws_iam_role.this[0]
  values = { arn = "arn:aws:iam::111122223333:role/matrix-node" }
}

override_resource {
  target = module.vpc.aws_subnet.private[0]
  values = {
    id                      = "subnet-00000000000000001"
    map_public_ip_on_launch = false
  }
}

override_resource {
  target = module.vpc.aws_subnet.private[1]
  values = {
    id                      = "subnet-00000000000000002"
    map_public_ip_on_launch = false
  }
}

override_resource {
  target = module.vpc.aws_subnet.private[2]
  values = {
    id                      = "subnet-00000000000000003"
    map_public_ip_on_launch = false
  }
}

override_resource {
  target = module.eks.aws_iam_openid_connect_provider.oidc_provider[0]
  values = { arn = "arn:aws:iam::111122223333:oidc-provider/oidc.eks.us-west-2.amazonaws.com/id/MATRIX" }
}

override_data {
  target = module.eks.data.tls_certificate.this[0]
  values = {
    certificates = [{ sha1_fingerprint = "0000000000000000000000000000000000000000" }]
  }
}

override_data {
  target = module.vpc_endpoints.data.aws_vpc_endpoint_service.this["ecr_api"]
  values = { service_name = "com.amazonaws.us-west-2.ecr.api" }
}

override_data {
  target = module.vpc_endpoints.data.aws_vpc_endpoint_service.this["ecr_dkr"]
  values = { service_name = "com.amazonaws.us-west-2.ecr.dkr" }
}

override_data {
  target = module.vpc_endpoints.data.aws_vpc_endpoint_service.this["s3"]
  values = { service_name = "com.amazonaws.us-west-2.s3" }
}

override_data {
  target = module.vpc_endpoints.data.aws_vpc_endpoint_service.this["sts"]
  values = { service_name = "com.amazonaws.us-west-2.sts" }
}

run "matrix_configuration" {
  command = apply
  variables {
    github_repository = "matrix-fixture/eks-boundary-matrix-ci"
  }
}
