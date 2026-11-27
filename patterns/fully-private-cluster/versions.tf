terraform {
  required_version = ">= 1.13, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.100.0"
    }
    cloudinit = {
      source  = "hashicorp/cloudinit"
      version = "= 2.3.9"
    }
  }

  # ##  Used for end-to-end testing on project; update to suit your needs
  # backend "s3" {
  #   bucket = "terraform-ssp-github-actions-state"
  #   region = "us-west-2"
  #   key    = "e2e/fully-private-cluster/terraform.tfstate"
  # }
}
