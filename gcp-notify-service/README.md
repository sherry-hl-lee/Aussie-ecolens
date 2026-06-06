# GCP Notify Service (Member B — second cloud)

Tag-based notifications on **GCP Cloud Run**. After Member A’s AWS Lambda tags a file, it calls this service. The same **Cognito JWT** used on AWS is verified on GCP for user-facing demo endpoints.

## Flow

```text
User (Cognito) → upload on AWS (Member A)
  → Lambda tags media
  → POST https://<cloud-run-url>/notify  (X-Webhook-Secret)
  → GCP records/logs notification when tags match WATCHED_TAGS
```

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | None | Liveness |
| GET | `/auth/config` | None | Cognito + watched tags config |
| GET | `/auth/me` | `Authorization: Bearer <id_token>` | Cross-cloud JWT demo |
| GET | `/notifications` | Bearer JWT | Recent notifications (demo) |
| POST | `/notify` | `X-Webhook-Secret` (if set) | Lambda webhook after tagging |
| POST | `/sns` | SNS envelope | Optional SNS → same notify logic |

## Local run

```bash
cd gcp-notify-service
cp .env.example .env
# Edit .env with your Cognito pool (see frontend/.env — region is us-east-1 for pool id prefix)

python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8080
```

### Test `/health`

```bash
curl http://localhost:8080/health
```

### Test `/notify` (webhook)

```bash
curl -X POST http://localhost:8080/notify \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: change-me-before-deploy" \
  -d "{\"event\":\"media.tagged\",\"checksum\":\"abc\",\"fileUrl\":\"https://example/s3/obj\",\"tags\":[\"dingo\",\"tree\"],\"tagCounts\":{\"dingo\":2},\"userSub\":\"cognito-sub\",\"source\":\"aws-lambda\"}"
```

Expect `matchedTags: ["dingo"]` and `notified: true` when `dingo` is in `WATCHED_TAGS`.

### Test `/auth/me` (Cognito JWT)

1. Sign in via the prototype (`http://localhost:3000/prototype.html`).
2. Copy the ID token from the browser (or your auth helper).
3. `curl http://localhost:8080/auth/me -H "Authorization: Bearer <id_token>"`

## Deploy to Cloud Run

Prerequisites: [Google Cloud SDK](https://cloud.google.com/sdk/docs/install), project with Cloud Run API enabled.

```bash
cd gcp-notify-service
gcloud config set project YOUR_GCP_PROJECT_ID

cp cloudrun.env.yaml.example cloudrun.env.yaml
# Edit cloudrun.env.yaml (commas in WATCHED_TAGS are OK in this file)

gcloud run deploy aussie-ecolens-notify \
  --source . \
  --region australia-southeast1 \
  --allow-unauthenticated \
  --env-vars-file cloudrun.env.yaml
```

**Windows / PowerShell:** use `--env-vars-file` (not `--set-env-vars` with commas). The `^:^` delimiter only works in **cmd.exe**, not PowerShell.

Save the service URL (e.g. `https://aussie-ecolens-notify-xxxxx.a.run.app`).

### Deploy error: `storage.objects.get` denied (403)

If deploy fails with `630205421024-compute@developer.gserviceaccount.com does not have storage.objects.get`, grant Cloud Build and the default compute service account access (replace project id/number if yours differ):

```powershell
$PROJECT = "aussie-ecolens-498409"
$NUM = "630205421024"

gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:${NUM}@cloudbuild.gserviceaccount.com" --role="roles/run.admin"
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:${NUM}@cloudbuild.gserviceaccount.com" --role="roles/iam.serviceAccountUser"
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:${NUM}@cloudbuild.gserviceaccount.com" --role="roles/storage.admin"

gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:${NUM}-compute@developer.gserviceaccount.com" --role="roles/storage.objectViewer"
```

Wait 1–2 minutes, then run `gcloud run deploy` again. You need **Owner** or **Project IAM Admin** on the GCP project (student projects usually have this).

### Deploy error: `Build failed` after `Building Container...` (push to registry)

If the Docker build step succeeds but deploy still fails, the image push to Artifact Registry often lacks permissions. Grant:

```powershell
$PROJECT = "aussie-ecolens-498409"
$NUM = "630205421024"

gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:${NUM}-compute@developer.gserviceaccount.com" --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:${NUM}-compute@developer.gserviceaccount.com" --role="roles/logging.logWriter"
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:${NUM}@cloudbuild.gserviceaccount.com" --role="roles/artifactregistry.writer"
```

Redeploy after 1–2 minutes. Build logs: Cloud Console → **Cloud Build** → click the failed build.

## Integration contract (for Member A)

After upload + tagging on AWS, Lambda should call:

```http
POST {GCP_NOTIFY_URL}/notify
Content-Type: application/json
X-Webhook-Secret: <same as WEBHOOK_SECRET on Cloud Run>
```

**JSON body:**

```json
{
  "event": "media.tagged",
  "checksum": "<sha256>",
  "filename": "<s3-key>",
  "fileUrl": "<https://...>",
  "thumbnailUrl": "<https://...>",
  "tags": ["dingo", "koala"],
  "tagCounts": { "dingo": 2 },
  "userSub": "<cognito sub from authorizer>",
  "source": "aws-lambda"
}
```

**Response (200):**

```json
{
  "accepted": true,
  "watchedTags": ["dingo", "koala", "wombat"],
  "matchedTags": ["dingo"],
  "notified": true,
  "notifications": [{ "...": "..." }]
}
```

Optional: subscribe SNS to `POST {GCP_NOTIFY_URL}/sns` with the same JSON in the SNS `Message` field.

## Report / rubric notes

- **Second cloud:** GCP Cloud Run hosts notification logic separate from AWS compute.
- **Cross-cloud auth:** `GET /auth/me` proves Cognito JWT validation on GCP; production webhook uses `X-Webhook-Secret` (server-to-server).
- **No duplicate ML:** tagging stays on AWS; GCP only reacts to tags.
