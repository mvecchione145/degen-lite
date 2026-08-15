# Deploying to a single EC2 instance

This is the cheap path: one virtual machine running the same `docker compose`
stack you run locally, for roughly **$17/month**. It is a different design from
[Architecture](architecture.md), which describes an ECS/Aurora deployment costed
at ~$118/month in [Cost Estimates](cost-estimates.md). Nearly all of that gap is
fixed infrastructure a single box simply does not provision: NAT gateway (~$32),
load balancer (~$18), and Aurora's 0.5 ACU floor (~$43).

The trade is honest: no redundancy, no automated failover, and a reboot is
downtime. For a pool among friends that is the right call.

## Does it fit?

Measured on the running stack, idle:

| Container | Memory |
| --- | ---: |
| redis-ui (not deployed in production) | 131 MB |
| worker | 46 MB |
| api | 38 MB |
| db | 26 MB |
| redis | 10 MB |
| web | 7 MB |
| **Total without redis-ui** | **~127 MB** |

Images total ~1.07 GB. A 2 GB instance is comfortable, including headroom to
build images on the box.

## Cost

| Item | Approx. monthly (us-east-1, on-demand) |
| --- | ---: |
| t4g.small — 2 vCPU burst, 2 GB, ARM | ~$12 |
| gp3 EBS, 20 GB | ~$1.60 |
| Public IPv4 address | ~$3.60 |
| Egress | ~$0 at this traffic |
| **Total** | **~$17/mo** |

A `t4g.micro` (1 GB) runs ~$6 and works if you add swap before building images.
A one-year Savings Plan takes the small down to roughly $8. Check current
pricing — these are ballpark.

**Lightsail** is worth considering instead: $10/month for 2 GB, 60 GB SSD, a
static IP and 3 TB of transfer, with flat billing. Same Docker, fewer moving
parts.

## What the production overlay changes

`docker-compose.prod.yml` layers on top of the base file. Bring the stack up
with both:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

| Change | Why |
| --- | --- |
| Only Caddy publishes ports | The base file binds Postgres (5433), Redis (6380), RedisInsight (5540) and the API (3000) to `0.0.0.0`. That leaves a security group as the only thing between an unauthenticated Redis and the internet. |
| `DEV_TOOLS=false` | `/api/admin` mounts whenever this is true (`app.js:28`) and defaults to true. It can fabricate final scores and force settlement, gated by nothing but a valid login — **any registered user**. |
| Secrets have no defaults | `${JWT_SECRET:?}` refuses to start rather than silently using `dev-secret-change-me`, with which anyone can forge a session for any account. |
| RedisInsight behind a `debug` profile | A no-auth database browser, and the largest image in the stack. Off unless asked for. |
| `restart: unless-stopped` everywhere | No service declares a restart policy in the base file, so nothing survives a reboot. |
| Log rotation (10 MB × 3) | An uncapped `json-file` log will eventually fill a 20 GB root volume. |
| Caddy on 80/443 | nginx serves plain HTTP. Caddy terminates TLS with automatic Let's Encrypt certificates. |

Verify the merge before trusting it:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
```

Every service except `caddy` should show no published ports, and `redis-ui`
should be absent entirely.

## Setup

### 1. Launch the instance

**With Terraform** (`terraform/`), which does everything in this step and the
next, and gives you a shell over Session Manager instead of SSH:

```bash
cd terraform && terraform init && terraform apply
aws ssm start-session --target $(terraform output -raw instance_id)
```

See `terraform/README.md`, then skip to step 3.

**By hand**, if you would rather click:

- **AMI**: Amazon Linux 2023, **arm64**
- **Type**: `t4g.small`
- **Storage**: 20 GB gp3
- **Security group**: 80 and 443 from anywhere; 22 from *your address only*

Do not open 5433, 6380, 5540, or 3000. With the overlay they are not published
externally anyway — this is the second layer, not the first.

### 2. Install Docker

```bash
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user   # log out and back in

sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
```

On a `t4g.micro`, add swap first or the image build will be OOM-killed:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 3. Clone and configure

```bash
sudo mkdir -p /opt/leaguepicks && sudo chown ec2-user /opt/leaguepicks
git clone <your-repo> /opt/leaguepicks
cd /opt/leaguepicks
```

Create `.env` — compose reads it automatically from the project directory:

```bash
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
JWT_SECRET=$(openssl rand -base64 48)
SITE_ADDRESS=picks.example.com
SHARP_API_KEY=<your sharpapi.io key>
EOF
chmod 600 .env
```

`scripts/compose.sh` resolves `SHARP_API_KEY` from 1Password and will not work
here — the CLI is not installed and no account is signed in. On the server, put
the key in `.env` and call `docker compose` directly with both files. (The
alternative, if you would rather not keep a key on disk, is SSM Parameter Store
fetched into the environment at boot.)

Set `SITE_ADDRESS` to `:80` while testing against a raw IP — ACME cannot issue a
certificate for an IP address. Switch it to the domain once DNS resolves, and
Caddy will get a certificate on the next restart.

### 4. Start

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f worker
```

The worker pulls the season from ESPN on startup — 272 games across 18 weeks —
then prices them if a SharpAPI key is present. First boot takes a minute or two.

Sign in as `admin` / `password123` from `db/init/03-seed.sql` and **change the
password immediately**, or edit the seed before first boot. The seed only runs
against an empty data directory, so changing it later means wiping the volume.

## Operations

Define a shell alias so you never forget the second file — running plain
`docker compose up` re-exposes every port and turns dev tools back on:

```bash
alias lp='docker compose -f /opt/leaguepicks/docker-compose.yml -f /opt/leaguepicks/docker-compose.prod.yml'
```

**Deploy an update**

```bash
cd /opt/leaguepicks && git pull
lp up -d --build
```

Schema changes are the exception: `db/init/*.sql` runs only against an empty
data directory, so an altered schema needs a hand-written `ALTER TABLE` against
the live database. There is no migration runner in this project.

**Back up** — the entire history of every pool lives on one EBS volume:

```bash
# /etc/cron.d/leaguepicks-backup
0 4 * * * ec2-user cd /opt/leaguepicks && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  pg_dump -U leaguepicks leaguepicks | gzip > /var/backups/lp-$(date +\%F).sql.gz && \
  aws s3 cp /var/backups/lp-$(date +\%F).sql.gz s3://your-bucket/leaguepicks/
```

Add EBS snapshots through Data Lifecycle Manager as the second layer, and test a
restore at least once — an untested backup is a guess.

**Restore**

```bash
lp down
docker volume rm leaguepicks_pgdata
lp up -d db                      # init scripts recreate the schema
gunzip -c lp-2026-08-15.sql.gz | lp exec -T db psql -U leaguepicks leaguepicks
lp up -d
```

**Inspect Redis** without exposing it:

```bash
lp --profile debug up -d redis-ui
ssh -L 5540:127.0.0.1:5540 ec2-user@<host>   # then open localhost:5540
```

> **`scripts/reset-db.sh` destroys the database.** It exists for local
> development. On a server it will delete every pool, bet, and account, and the
> only thing standing between you and that is the confirmation prompt. Never run
> it with `-y` on this host.

## Security checklist

- [ ] `.env` is `chmod 600` and not committed
- [ ] `JWT_SECRET` and `POSTGRES_PASSWORD` are freshly generated, not defaults
- [ ] `DEV_TOOLS=false` — confirm `/api/admin/settle` returns 404 in production
- [ ] Security group exposes only 80, 443, and 22-from-your-IP
- [ ] `docker compose ... config` shows no published ports except Caddy's
- [ ] The seeded `admin` password has been changed
- [ ] TLS is live and HTTP redirects to HTTPS
- [ ] Backups run, and a restore has been tested once

## What this does not give you

Single instance, single volume, no failover. An instance failure is an outage
and, without backups, data loss. If it outgrows that, move Postgres to RDS
first — it is the only stateful piece, and it is what makes the box precious.
Compute can be rebuilt from the repo in minutes.
