# Terraform — single EC2 host

Provisions the box that `docs/deploy-ec2.md` describes: one instance on a
public subnet, HTTP and HTTPS open to the world, and a shell over Session
Manager rather than SSH.

```bash
aws sso login                 # or export credentials another way
terraform init
terraform plan
terraform apply
```

Nothing here deploys the application. The instance comes up with Docker and
the compose plugin installed and an empty `/opt/leaguepicks`; follow
`docs/deploy-ec2.md` from step 3 to clone, configure and start the stack.

## What it creates

| Resource | Note |
| --- | --- |
| VPC, public subnet, internet gateway, route table | Dedicated, not the default VPC — some accounts have deleted theirs. No NAT gateway: it would be the largest line on the bill (~$32/mo) and buys nothing for a box that already has a public address. |
| Security group | 80 and 443 from `http_cidrs`. Port 22 only if you set `ssh_cidrs`. |
| IAM role + instance profile | `AmazonSSMManagedInstanceCore`, which is what makes Session Manager work. |
| EC2 instance | Amazon Linux 2023 arm64 on `t4g.small`, 20 GB encrypted gp3, IMDSv2 required. |
| Elastic IP | Optional (`allocate_eip`, default true). |

Roughly **$17/month** — see the cost table in `docs/deploy-ec2.md`.

## Getting a shell

Session Manager, so there is no open port, no key pair, and no bastion:

```bash
aws ssm start-session --target $(terraform output -raw instance_id)
```

`terraform output ssm_session` prints the command with the right region baked
in. It works because the SSM agent ships with Amazon Linux 2023 and dials
*out* to the service — the instance profile above is the only thing it needs.

Requires the Session Manager plugin locally:

```bash
# macOS
brew install --cask session-manager-plugin
```

To reach a service bound to loopback on the box — RedisInsight, Postgres —
forward a port through the same channel instead of opening one:

```bash
terraform output -raw ssm_port_forward_redis_ui   # then open localhost:5540
```

## Why SSH is off by default

`ssh_cidrs` is empty, so no inbound rule on 22 exists. Session Manager covers
the interactive case, logs sessions, and is governed by IAM rather than by who
holds a private key. Set `ssh_cidrs = ["1.2.3.4/32"]` if you specifically need
`scp` or a raw SSH tunnel — and prefer a `/32`, never `0.0.0.0/0`.

## Variables worth knowing

| Variable | Default | |
| --- | --- | --- |
| `region` | `us-east-1` | |
| `instance_type` | `t4g.small` | arm64 family required — the AMI is arm64. `t4g.micro` works; user-data adds 2 GB of swap for it. |
| `http_cidrs` | `["0.0.0.0/0"]` | Narrow it while testing if you like. |
| `ssh_cidrs` | `[]` | Leave empty; use SSM. |
| `allocate_eip` | `true` | Off means the address changes on stop/start, breaking DNS and any issued certificate. |

## State

State is local. That is fine for one operator and one box, but it means the
state file is the only record of what exists — losing it means importing or
recreating. Move it to S3 with DynamoDB locking before anyone else touches
this. Nothing here is written to assume local state.

## Caveats

- **Not high-availability.** One instance, one volume, one AZ. An instance
  failure is an outage, and without backups it is data loss. The database
  lives on this box's EBS volume; `docs/deploy-ec2.md` covers `pg_dump` to S3.
- **`user_data` changes do not re-run.** `user_data_replace_on_change` is
  false, so editing `user-data.sh` shows as an in-place update and does not
  re-provision. That is deliberate — the alternative destroys the instance
  holding the database. Apply changes over SSM, or replace the instance
  knowingly with `terraform apply -replace=aws_instance.app`.
- **`terraform destroy` deletes the database** along with the volume.
