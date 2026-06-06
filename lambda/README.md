# Lambda functions

Two deployed functions — different packaging and triggers:

| AWS name | Folder | Deploy | Trigger | Role |
|----------|--------|--------|---------|------|
| **`ecolens-api`** | `api/` | Zip | API Gateway (HTTP) | REST routes, presigned upload, DynamoDB queries, SNS subscribe, **`/query/by-file` orchestration** |
| **`ecolens-process-upload`** | `process_upload/` | Container image | S3 `ObjectCreated` on `media/` **or** sync invoke from `ecolens-api` | ML inference, thumbnails, DynamoDB write (upload path); infer-only when `action: infer` |

## `/query/by-file` (ecolens-api → ecolens-process-upload)

Does **not** upload to S3 or write DynamoDB for the query file.

1. `ecolens-api` receives multipart file on `POST /query/by-file`.
2. If checksum exists in `ecolens-files`, reuse stored tags (skip ML).
3. Else `lambda:InvokeFunction` on **`ecolens-process-upload`** with payload:

   ```json
   { "action": "infer", "filename": "photo.jpg", "contentBase64": "..." }
   ```

4. Processing Lambda runs `infer_tags_only()` — returns `{ tags, tagCounts, detectionSource }` only.
5. `ecolens-api` scans DynamoDB and returns items whose tags match (AND).

**ecolens-api** must have `PROCESS_UPLOAD_FUNCTION_NAME=ecolens-process-upload` and IAM `lambda:InvokeFunction` on that function.

## Setup

1. Copy `backend/inference.py` into `process_upload/inference.py` (keep in sync).
2. Use **container image** deployment for **`ecolens-process-upload`** (torch size).
3. Use **zip** deployment for **`ecolens-api`**.
4. See `docs/aws-deploy.md` for AWS console steps.

## Environment variables

**ecolens-process-upload** (`process_upload/`)

- `MEDIA_BUCKET`
- `TABLE_NAME`
- `MODEL_S3_URI`
- `LABELS_S3_URI` (optional if `labels.txt` bundled in image)
- `AWS_REGION` (auto in Lambda)
- `GCP_NOTIFY_URL` — e.g. `https://...a.run.app/notify` (optional)
- `GCP_WEBHOOK_SECRET` — shared webhook secret; never commit
- `SNS_TOPIC_ARN` — SNS topic for tag email alerts
- `SUBSCRIPTIONS_TABLE` — DynamoDB table (default `ecolens-subscriptions`, PK `userSub`, SK `tag`)
- `SNS_NOTIFICATIONS_ENABLED` — `true` / `false` (default `true`)

**ecolens-api** (`api/`)

- `MEDIA_BUCKET`
- `TABLE_NAME`
- `PRESIGNED_EXPIRY_SEC` (default 3600)
- `PROCESS_UPLOAD_FUNCTION_NAME` — default `ecolens-process-upload` (for `/query/by-file`)
- `MAX_QUERY_BY_FILE_BYTES` — default `4500000` (Lambda invoke payload limit)
- `SNS_TOPIC_ARN`, `SUBSCRIPTIONS_TABLE`, `SNS_NOTIFICATIONS_ENABLED` — same as above

Package `sns_notifications.py` alongside `handler.py` in both Lambda deployments.
