# GitOps Ephemeral Environment Provisioner

Automated isolated test environments per Pull Request — zero manual setup, zero leftover resources.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  GitHub PR   │────▶│  Webhook Listener │────▶│   Task Queue  │────▶│ Infra Provider  │
│  (Webhook)   │     │  (HMAC verified) │     │  (BullMQ/Redis)│    │ (Docker/K8s)    │
└──────────────┘     └──────────────────┘     └──────────────┘     └─────────────────┘
                            │                        │                      │
                            ▼                        ▼                      ▼
                     ┌──────────────┐     ┌──────────────┐     ┌─────────────────┐
                     │ Comment Bot  │     │   Metrics    │     │  Secret Manager │
                     │ (Deployments │     │ (Prometheus) │     │ (Env/Vault)     │
                     │   API)       │     └──────────────┘     └─────────────────┘
                     └──────────────┘                                     │
                                                                          ▼
                                                                   ┌─────────────┐
                                                                   │  Traefik     │
                                                                   │ (Router)     │
                                                                   └─────────────┘
```

| Component | File | Responsibility |
|-----------|------|----------------|
| **Webhook Listener** | `src/webhook/` | Receive, validate (HMAC-SHA256), classify PR events |
| **Task Queue** | `src/queue/` | Async BullMQ processing with retry + backoff |
| **Infra Provider** | `src/infra/` | Pluggable: Docker Compose (MVP) / Kubernetes (prod) |
| **Comment Bot** | `src/github/` | PR comments + GitHub Deployments API |
| **Secret Manager** | `src/secrets/` | Pluggable: env vars (dev) / HashiCorp Vault (prod) |
| **Dynamic Router** | `src/router/` | Traefik dynamic config for per-PR URLs |
| **Lifecycle** | `src/lifecycle/` | Orchestrates provision → notify → teardown |
| **Metrics** | `src/metrics/` | Prometheus counters, histograms, gauges |
| **Logger** | `src/logger/` | Structured JSON logging (pino) with correlation ID |

## Quick Start

```bash
# 1. Setup environment
cp .env.example .env
# Edit .env with your GitHub App credentials

# 2. Start all services
docker compose up -d

# 3. Verify
./scripts/smoke-test.sh
```

## GitHub App Setup

1. Go to **GitHub → Settings → Developer Settings → GitHub Apps → New GitHub App**
2. Set:
   - **Webhook URL**: `https://your-server:3000/api/v1/webhook/github`
   - **Webhook secret**: Generate a 32+ char string
   - **Permissions**: Read access to repos, Read/Write to issues and deployments
   - **Subscribe to events**: Pull requests
3. Generate a private key (.pem) and save it
4. Update `.env` with App ID, webhook secret, and key path

```bash
./scripts/setup-github-app.sh
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with dependency status |
| `POST` | `/api/v1/webhook/github` | GitHub webhook receiver (HMAC validated) |
| `GET` | `/api/v1/environments` | List all ephemeral environments |
| `GET` | `/api/v1/environments/:id` | Get single environment by ID |
| `GET` | `/metrics` | Prometheus metrics |

## How It Works

1. **PR Opened** → Webhook validated → Task enqueued → Clone repo → `docker compose up -d` → Traefik route → PR comment with URL + GitHub Deployment (pending → success)
2. **PR Updated** (synchronize) → Re-provision (teardown + provision)
3. **PR Closed/Merged** → Teardown (containers, volumes, network, route) → GitHub Deployment (inactive) → Cleanup comment

## Security

- **HMAC-SHA256** webhook signature verification (timing-safe comparison)
- **GitHub App** authentication with granular permissions (least privilege)
- **Secret injection** via Vault or env vars (never hardcoded)
- **Helmet + CORS** on all HTTP endpoints
- **Rate limiting** on webhook endpoint
- **Resource limits** per container (CPU + memory caps)

## Observability

- **Metrics**: Prometheus endpoint at `/metrics`
  - Provision duration histogram
  - Teardown duration histogram
  - Active environments gauge
  - GitHub API call counter
  - Queue depth gauge
- **Alerts**: See `deploy/prometheus/alerts.yml`
  - High provision failure rate (>10%)
  - Slow provisioning (p95 > 120s)
  - Near capacity (>8 active envs)
  - Queue backlog (>5 waiting)
  - Teardown failures
- **Logs**: Structured JSON via pino with correlation ID propagation

## Stack Justification

**TypeScript/Node.js** was chosen over Python (FastAPI) because:

1. **Ecosystem alignment**: Dockerode, BullMQ, and Octokit are first-class Node.js libraries with superior TypeScript types—no pydantic/octokit wrapper equivalent for Docker orchestration.
2. **Concurrency model**: Single-threaded event loop handles webhook I/O efficiently; CPU-heavy operations (child_process for docker-compose) are offloaded naturally.
3. **Type safety at scale**: TypeScript's strict mode with Zod validation provides compile-time + runtime guarantees critical for infrastructure code.
4. **Team velocity**: Fastify's typed routing + Zod schemas = zero-surprise API contracts.

## Resource Optimization (Bonus)

- **Hibernate after idle**: `ENV_HIBERNATE_AFTER_SECONDS=3600` — containers paused after 1h inactivity
- **TTL enforcement**: `ENV_TTL_SECONDS=86400` — auto-teardown after 24h
- **Concurrent cap**: `MAX_CONCURRENT_ENVS=10` — prevents resource exhaustion

## Multi-Cloud Architecture (Future)

```
                    ┌─────────────────────┐
                    │  Scheduler / Router │
                    └─────┬───────┬───────┘
                          │       │
               ┌──────────▼──┐ ┌──▼──────────┐
               │  Docker Host│ │ K8s Cluster  │
               │  (MVP/Dev)  │ │ (Prod/Scale) │
               └─────────────┘ └──────────────┘
```

The `InfraProvider` interface enables zero-code-switch deployment targets:

```typescript
// Switch provider in server.ts
const infraProvider: InfraProvider = new KubernetesProvider({
  namespace: 'ephemeral-envs',
  context: 'gke-project-cluster',
});
```

## Private Network Access (Bonus)

When the provisioner is in a private network:

1. **Tunnel**: Use Cloudflare Tunnel / ngrok for secure.Public URL → private service mapping
2. **VPN**: WireGuard mesh for developer access to `pr-*.internal.domain`
3. **Reverse proxy with auth**: Traefik + Authelia for SSO-gated access

## CI/CD Integration

Ephemeral environments can trigger automated tests:

```yaml
# .github/workflows/e2e-on-ephemeral.yml
on: deployment_status
jobs:
  test:
    if: deployment_status.state == 'success' && startsWith(deployment_status.environment_url, 'https://pr-')
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:e2e -- --base-url=${{ deployment_status.environment_url }}
```

## Testing

```bash
npm run test:unit        # Unit tests (no external deps)
npm run test:integration # Integration tests (no external deps)
npm run test:e2e         # End-to-end (full lifecycle with stubs)
npm run test:ci          # CI mode with coverage
```

## Rollback

```bash
./scripts/rollback.sh sha-abc1234
```

## Project Structure

```
src/
├── config/          # Zod-validated env config
├── errors/          # AppError hierarchy with error codes
├── github/          # Octokit + Deployment API + Comment bot
├── infra/
│   ├── docker/      # Docker Compose provider (MVP)
│   ├── kubernetes/  # Kubernetes provider (pluggable)
│   └── provider.ts  # InfraProvider interface
├── lifecycle/       # Provision/teardown orchestrator
├── logger/          # Structured pino logging
├── metrics/         # Prometheus metrics
├── middleware/      # Correlation ID + error handler
├── queue/           # BullMQ task queue
├── router/          # Traefik dynamic routing
├── secrets/         # Vault + env secret providers
├── types/           # Shared TypeScript types
├── webhook/         # HMAC validation + event parsing
└── server.ts        # Fastify app entry point
tests/
├── unit/            # Pure unit tests
├── integration/     # Module interaction tests
└── e2e/             # Full lifecycle tests
deploy/
├── prometheus/      # Config + alert rules
├── traefik/         # Dynamic config directory
└── grafana/         # Dashboard configs
scripts/             # Smoke test, rollback, setup
.github/workflows/   # CI + Deploy pipelines
```

## License

MIT
