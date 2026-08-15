# What makes `aws ssm start-session` work. The agent ships with Amazon Linux
# 2023 and polls the SSM service; it needs credentials to register, which is
# what this instance profile provides. No inbound port and no key pair are
# involved — the session is an outbound connection from the box.

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

# AWS-managed, and the whole reason Session Manager works. It grants the agent
# its own channel and nothing else — it is not general-purpose access to the
# account.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}
