# Aussie EcoLens

A multi-cloud serverless wildlife media platform for FIT5225. Authenticated users upload images and videos; an ML model detects Australian species; metadata is stored in a database; users query and manage tags; notifications fire when watched tags appear on new uploads.

**Clouds:** AWS (Cognito, S3, Lambda, API Gateway, DynamoDB, SNS) + GCP (Cloud Run notify service).

## Architecture

Two AWS Lambda functions serve different roles — do not conflate them:

| Lambda | Deploy | Trigger | Role |
|--------|--------|---------|------|
| **`ecolens-api`** | Zip package | API Gateway (HTTP) | REST API: presigned upload, queries, bulk tags, delete, SNS subscribe |
| **`ecolens-process-upload`** | Container image (torch + opencv) | S3 `ObjectCreated` on `media/` **or** synchronous invoke from `ecolens-api` | ML inference, thumbnails, DynamoDB write, SNS + GCP notify |

### Upload path (persist media)

```text
User (browser)
  │
  ├─ AWS Cognito Hosted UI ──► JWT (id token)
  │
  └─ React dashboard ──► API Gateway ──► ecolens-api (zip)
                              │
                              ├─ POST /upload ──► presigned PUT ──► S3 media/
                              │                                      │
                              │                                      ▼
                              │                         ecolens-process-upload (container)
                              │                           • checksum dedup
                              │                           • thumbnail / 1 fps video
                              │                           • ML tags (model.pt)
                              │                           • DynamoDB write
                              │                                      │
                              │                    ┌─────────────────┴─────────────────┐
                              │                    ▼                                   ▼
                              │             AWS SNS (email)                  GCP Cloud Run POST /notify
                              │             tag subscriptions                (WATCHED_TAGS + webhook secret)
                              │
                              └─ DynamoDB: ecolens-files, ecolens-subscriptions
```

### Query-by-file path (infer only — no S3 / no DB write)

`POST /query/by-file` does **not** follow the upload pipeline. The query file is never stored.

```text
React dashboard
  │
  └─ POST /query/by-file (multipart file)
        │
        ▼
     ecolens-api
        │  if checksum already in DynamoDB → reuse stored tags (skip ML)
        │  else synchronous Lambda.invoke({ action: "infer", contentBase64, filename })
        ▼
     ecolens-process-upload  (infer-only branch — no S3 Put, no DynamoDB Put)
        │  returns { tags, tagCounts, detectionSource }
        ▼
     ecolens-api scans DynamoDB ecolens-files for items whose tags match query tags (AND)
        │
        └─► JSON response to frontend (queryTags, count, items[])
```

Set `PROCESS_UPLOAD_FUNCTION_NAME=ecolens-process-upload` on **ecolens-api** and grant `lambda:InvokeFunction` on the processing Lambda.

| Component | Cloud | Role |
|-----------|-------|------|
| Cognito User Pool | AWS | Sign-up, login, JWT (required by assignment) |
| API Gateway + **`ecolens-api`** (`lambda/api`) | AWS | Zip Lambda: REST routes, presigned URLs, invokes processing Lambda for `/query/by-file` |
| S3 | AWS | Original media, thumbnails, `models/model.pt` |
| **`ecolens-process-upload`** (`lambda/process_upload`) | AWS | Container Lambda: S3 upload pipeline **or** infer-only invoke (`action: infer`) |
| DynamoDB | AWS | `ecolens-files` (media metadata), `ecolens-subscriptions` (SNS tags) |
| SNS | AWS | Per-tag email alerts for subscribed users |
| `gcp-notify-service` | GCP | Second cloud: webhook notifications + Cognito JWT demo endpoints |
| React frontend | Local dev | Dashboard UI (`npm run dev` → port 3000) |

## Repository structure

```text
frontend/                 React + Vite dashboard (auth, upload, query, tags, SNS UI)
  src/
    auth/                 Cognito Hosted UI, JWT helpers, route guards
    api/client.js         API client (presigned S3 upload + queries)
    components/           Upload, gallery, queries, tag bulk edit, notifications
    pages/                Login, Dashboard
  prototype.html          Legacy vanilla UI (deprecated)

backend/                  Local FastAPI + SQLite (same API shape as AWS; offline dev)
  app.py                  Full API parity for integration testing
  inference.py            ML tagging (mirrored in lambda/process_upload)

lambda/
  api/                    ecolens-api — zip deploy, API Gateway handler + sns_notifications.py
  process_upload/         ecolens-process-upload — container (S3 trigger + infer-only invoke)
    Dockerfile            Build from repo root to bundle labels.txt

gcp-notify-service/       GCP Cloud Run FastAPI service (Member B second cloud)
  main.py                 POST /notify, GET /auth/me, GET /notifications
  auth.py                 Cognito JWT verification on GCP

docs/
  api-contract.md         REST request/response shapes
  aws-deploy.md           AWS resource checklist (Member A)
  aws-sns-console-deploy.md   SNS topic + DynamoDB setup (Member D)
  sns-notifications.md    SNS design and env vars

labels.txt                SpeciesNet taxonomy → common names for ML tags
model.pt                  ML weights (not in git; place at repo root or upload to S3)
config.yaml, batch.py     Offline ML batch utilities (optional)
```

## Prerequisites

| Task | Requirement |
|------|-------------|
| Frontend | Node.js 18+, npm |
| Local backend / GCP local | Python 3.12+, pip |
| AWS demo | AWS Academy lab **Started**; Cognito app client configured |
| GCP deploy | Google Cloud SDK, Cloud Run API enabled |
| ML inference | `model.pt` locally or `MODEL_S3_URI` on S3 |

## Quick start — frontend (team demo on AWS)

**Prerequisites:**  API Gateway URL is live; Cognito **Allowed callback URLs** include your dev URL exactly.

```bash
cd frontend
cp .env.example .env
# Edit .env — see table below
npm install
npm run dev
```

Open **http://localhost:3000** → Sign in with Cognito → **Dashboard**.

| Variable | Purpose |
|----------|---------|
| `VITE_COGNITO_USER_POOL_ID` | Cognito User Pool ID |
| `VITE_COGNITO_USER_POOL_CLIENT_ID` | App client ID |
| `VITE_COGNITO_DOMAIN` | Hosted UI domain (host only, no `https://`) |
| `VITE_API_BASE_URL` | AWS API Gateway base URL |
| `VITE_UPLOAD_MODE` | `presigned` for AWS (default); `local` for FastAPI multipart |
| `VITE_COGNITO_REDIRECT_URI` | Must match Cognito callback URL exactly (e.g. `http://localhost:3000/`) |

**Upload flow (AWS):** Dashboard → `ecolens-api` presigned URL → PUT to S3 → **ecolens-process-upload** (S3 trigger) → poll gallery until tags appear.

**Query-by-file (AWS):** Dashboard → `POST /query/by-file` → **ecolens-api** → (optional) invoke **ecolens-process-upload** with `action: infer` → scan DynamoDB → return matches. Query file is **not** written to S3 or the database.

**Browse modes:** **Explore** (all media) and **My Uploads** (`GET /files?user=me`, keyed by `uploadedBy` from S3 object metadata).

## Quick start — local backend (offline dev)

Use when AWS lab is off or for fast API iteration. SNS is simulated in logs unless `SNS_TOPIC_ARN` is set.

```bash
cd backend
pip install -r requirements.txt
export COGNITO_REGION=us-east-1
export COGNITO_USER_POOL_ID=your_pool_id
export COGNITO_APP_CLIENT_ID=your_client_id
uvicorn app:app --reload --port 8001
```

In `frontend/.env`:

```env
VITE_API_BASE_URL=http://127.0.0.1:8001
VITE_UPLOAD_MODE=local
```

Place `model.pt` at the repo root (or set paths per `backend/README.md`).

## GCP notify service (second cloud)

After AWS Lambda tags a file, it `POST`s to Cloud Run `/notify` with a shared webhook secret. Cognito JWT is verified on GCP for demo endpoints (`/auth/me`, `/notifications`).

**Local run:**

```bash
cd gcp-notify-service
cp .env.example .env          # local dev
cp cloudrun.env.yaml.example cloudrun.env.yaml   # deploy (gitignored)
pip install -r requirements.txt
uvicorn main:app --reload --port 8080
```

**Deploy:** see [`gcp-notify-service/README.md`](gcp-notify-service/README.md). On Windows/PowerShell use `--env-vars-file cloudrun.env.yaml` (not comma-separated `--set-env-vars`).

**Lambda env vars (share secret via private message only):**

| Variable | Example |
|----------|---------|
| `GCP_NOTIFY_URL` | `https://....a.run.app/notify` |
| `GCP_WEBHOOK_SECRET` | shared secret (never commit) |

## AWS deployment

Full checklist: [`docs/aws-deploy.md`](docs/aws-deploy.md).

**`ecolens-api` (zip):** deploy `lambda/api/` (handler + `sns_notifications.py`) to Lambda and attach to API Gateway with Cognito JWT authorizer. Env: `MEDIA_BUCKET`, `TABLE_NAME`, `PROCESS_UPLOAD_FUNCTION_NAME=ecolens-process-upload`, plus SNS vars (see [`lambda/README.md`](lambda/README.md)).

**`ecolens-process-upload` (container):** build from repo root (bundles `labels.txt` for common-name tags):

```bash
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  -f lambda/process_upload/Dockerfile \
  -t <account>.dkr.ecr.us-east-1.amazonaws.com/ecolens-process-upload:latest --push .
```

Alternatively set `LABELS_S3_URI=s3://.../labels.txt` on the processing Lambda without rebundling.

**SNS setup:** [`docs/aws-sns-console-deploy.md`](docs/aws-sns-console-deploy.md) — topic ARN, `ecolens-subscriptions` table, routes on API Gateway, env vars on **both** `ecolens-api` and `ecolens-process-upload` Lambdas.

## Notifications

Two independent paths (both valid for the multi-cloud story):

| Path | Trigger | User-facing |
|------|---------|-------------|
| **AWS SNS** | Upload or bulk tags match a subscribed tag | Dashboard → **Tag notifications** → email (confirm SNS subscription first) |
| **GCP Cloud Run** | Lambda webhook when tags fuzzy-match `WATCHED_TAGS` | Cloud Run logs; `GET /notifications` with JWT |

Tag matching uses **fuzzy substring** logic (e.g. `dingo` ↔ `canis dingo`, `wombat` ↔ `common wombat`). ML output quality depends on `labels.txt` being loaded in `ecolens-process-upload` (see Dockerfile / `LABELS_S3_URI`).

**Note:** `koala` is not in the current model class list; use images the model recognises or add tags manually via bulk tag API.

## API reference

All protected routes require `Authorization: Bearer <Cognito id token>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health`, `/auth/config`, `/auth/me` | Health and auth |
| GET | `/files`, `/files?user=me` | List media |
| POST | `/upload` | Multipart (local) or presigned JSON (AWS via **ecolens-api**) |
| POST | `/query/species`, `/query/tags-count`, `/query/thumbnail` | Queries (DynamoDB only) |
| POST | `/query/by-file` | Multipart query file → **ecolens-api** invokes **ecolens-process-upload** (infer-only) → DynamoDB match; file not stored |
| POST | `/tags/bulk`, `/files/delete` | Bulk tag edit, delete |
| GET/POST | `/notifications/*` | SNS tag subscriptions |

Full schemas: [`docs/api-contract.md`](docs/api-contract.md).

## Team ownership (typical split)

| Area | Location | Owner |
|------|----------|-------|
| AWS core (S3, Lambda, API Gateway, DynamoDB) | `lambda/`, `docs/aws-deploy.md` | Member A |
| Cognito + frontend auth | `frontend/src/auth/`, Cognito console | Member B |
| GCP second cloud | `gcp-notify-service/` | Member B |
| SNS email subscriptions | `lambda/*/sns_notifications.py`, `docs/sns-*` | Member D |
| Dashboard UI | `frontend/` | Team |

## Demo checklist

1. Start AWS Academy lab.
2. `cd frontend && npm run dev` → http://localhost:3000
3. Cognito login → upload image → tags + thumbnail in gallery (**upload path**)
4. Run a query (species or tag count AND); **Find by file** tab (**query-by-file path** — no new S3 object)
5. Bulk add/remove tag or delete own file
6. Subscribe to a tag → upload matching media → SNS email **or** GCP log `matchedTags`
7. Optional: `curl` GCP `/auth/me` with JWT (cross-cloud auth demo)

Frontend does **not** need to be deployed to the cloud for the assignment; local dev + cloud backend is the expected demo path.

## AWS Academy lab

| Activity | Lab must be Started? |
|----------|----------------------|
| Upload, API, Lambda, S3 processing | **Yes** |
| GCP Cloud Run `/notify` | No (GCP stays up; Lambda calls it when AWS is up) |
| Local backend / frontend dev only | No |

Ending the lab stops API Gateway, Lambda, and S3 until the lab is started again.

## Security

- Never commit `.env`, `cloudrun.env.yaml`, webhook secrets, or `model.pt`.
- Share `GCP_WEBHOOK_SECRET` with Member A via private message only.
- Cognito JWT authorizer on API Gateway protects `/files`, `/upload`, `/query/*`, `/notifications/*`.
- Use a **private** course Git repo; all members should commit their own work.

## Further reading

| Document | Contents |
|----------|----------|
| [docs/api-contract.md](docs/api-contract.md) | REST API contract |
| [docs/aws-deploy.md](docs/aws-deploy.md) | AWS deployment guide |
| [docs/sns-notifications.md](docs/sns-notifications.md) | SNS subscription design |
| [docs/aws-sns-console-deploy.md](docs/aws-sns-console-deploy.md) | SNS console steps |
| [lambda/README.md](lambda/README.md) | Lambda env vars |
| [gcp-notify-service/README.md](gcp-notify-service/README.md) | Cloud Run deploy + webhook |
| [backend/README.md](backend/README.md) | Local FastAPI prototype |
