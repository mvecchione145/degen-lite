#!/usr/bin/env bash
#
# Runs once, on first boot. Installs Docker and the compose plugin and stops
# there — it deliberately does not clone the repository or start the stack,
# because that needs secrets this script has no business holding. See
# docs/deploy-ec2.md for the steps that follow.
#
# The SSM agent is already installed and running on Amazon Linux 2023, so the
# box is reachable with `aws ssm start-session` as soon as it boots.

set -euxo pipefail

dnf update -y
dnf install -y docker git

systemctl enable --now docker

# ec2-user can drive docker without sudo. The group only takes effect on a new
# login, which a fresh SSM session is.
usermod -aG docker ec2-user

# Neither the compose nor the buildx plugin is in the AL2023 repositories.
# aarch64/arm64 to match the Graviton instance type.
install -d /usr/local/lib/docker/cli-plugins

curl -fsSL \
  "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# compose v2 delegates every build to buildx and refuses to run without a
# recent one ("compose build requires buildx 0.17.0 or later"). The release
# asset embeds its version, so unlike compose there is no latest/download
# shortcut — this pin has to be bumped by hand.
BUILDX_VERSION="v0.36.1"
curl -fsSL \
  "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-arm64" \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

# Swap, so a 1 GB t4g.micro can build images without the OOM killer. Harmless
# on larger instances.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -d -o ec2-user -g ec2-user /opt/leaguepicks
