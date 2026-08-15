variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "leaguepicks"
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type. Must match the AMI architecture in ami.tf, which is
    arm64 — so a t4g/m7g family. The whole stack idles around 130 MB, so
    t4g.small (2 GB) is comfortable and t4g.micro (1 GB) works with swap.
  EOT
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size. Postgres, Redis and the images all live here."
  type        = number
  default     = 20
}

variable "vpc_cidr" {
  description = "CIDR for the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR for the public subnet."
  type        = string
  default     = "10.20.1.0/24"
}

variable "http_cidrs" {
  description = "Who may reach the app over HTTP/HTTPS. Open by default — this is a public web app."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_cidrs" {
  description = <<-EOT
    Optional CIDRs allowed to reach port 22. Empty by default and meant to
    stay that way: Session Manager gives you a shell without an open port,
    an inbound rule, or a key pair to lose. Set this only if you need SCP or
    an SSH tunnel.
  EOT
  type        = list(string)
  default     = []
}

variable "key_name" {
  description = "Optional EC2 key pair name. Not needed for Session Manager access."
  type        = string
  default     = null
}

variable "allocate_eip" {
  description = <<-EOT
    Attach an Elastic IP. Without one the public address changes on every
    stop/start, which breaks DNS and any issued certificate. AWS bills for a
    public IPv4 address either way.
  EOT
  type        = bool
  default     = true
}
