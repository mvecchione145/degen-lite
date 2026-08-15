# Amazon Linux 2023, arm64, resolved from the public SSM parameter rather than
# pinned: a hardcoded AMI id is region-specific and goes stale. Graviton is the
# cheaper family and every image the stack uses publishes arm64.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  key_name               = var.key_name

  user_data = file("${path.module}/user-data.sh")

  # Editing user-data.sh should not silently do nothing, but it also should not
  # quietly destroy a box holding the only copy of the database. Left false so
  # the change is visible in the plan as an in-place update; re-run the script
  # over SSM, or taint the instance deliberately.
  user_data_replace_on_change = false

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  # IMDSv2 only. The v1 endpoint hands instance credentials to anything that
  # can make a GET from the box, which is one SSRF away from the role above.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = { Name = var.name }
}

# Without this the public address changes on every stop/start, breaking DNS and
# invalidating an issued certificate. AWS charges for a public IPv4 either way.
resource "aws_eip" "app" {
  count = var.allocate_eip ? 1 : 0

  instance = aws_instance.app.id
  domain   = "vpc"

  tags = { Name = var.name }

  depends_on = [aws_internet_gateway.main]
}
