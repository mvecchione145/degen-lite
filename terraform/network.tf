# A dedicated VPC rather than the default one: some accounts have had theirs
# deleted, and this keeps the whole deployment describable from this directory.
#
# One public subnet, one internet gateway, no NAT. NAT is the single largest
# line item in a small AWS bill (~$32/mo) and buys nothing here — the instance
# has a public address and talks out through the gateway. Session Manager also
# reaches its endpoints that way, which is why no VPC endpoints are declared.

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = var.name }
}

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# The application's only front door. Postgres (5432), Redis (6379) and the API
# (3000) are deliberately absent: docker-compose.prod.yml binds them to
# loopback, and nothing outside the box should reach them even if that changes.
resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "Public web access for ${var.name}"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name}-app" }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each = toset(var.http_cidrs)

  security_group_id = aws_security_group.app.id
  description       = "HTTP"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

# Caddy needs 443 both to serve TLS and to complete the ACME challenge that
# issues the certificate. Opened alongside 80 so a TLS deploy works without a
# second terraform apply.
resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each = toset(var.http_cidrs)

  security_group_id = aws_security_group.app.id
  description       = "HTTPS"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Empty unless ssh_cidrs is set. Session Manager is the intended way in.
resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = toset(var.ssh_cidrs)

  security_group_id = aws_security_group.app.id
  description       = "SSH"
  cidr_ipv4         = each.value
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}

# Outbound is wide open because the box legitimately needs it: ESPN and
# SharpAPI for data, the registries for images, and the SSM endpoints for the
# session channel.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.app.id
  description       = "All outbound"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
