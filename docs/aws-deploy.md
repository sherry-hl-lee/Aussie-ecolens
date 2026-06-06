# AWS Deploy Guide

Maps the **local prototype** (`backend/app.py`) to **AWS serverless** for Aussie EcoLens.

Reference: `backend/app.py`, `lambda/process_upload/`, `lambda/api/`, `docs/api-contract.md`

---

## 1. Architecture

| Component | AWS service | Purpose |
|-----------|-------------|---------|
| Media storage | S3 | Originals under `media/`, thumbnails under `thumbnails/` |
| Model artifact | S3 `models/model.pt` | Swap via `MODEL_S3_URI` without code changes |
| Metadata | DynamoDB `ecolens-files` | Tags, URLs, checksum dedup |
| Process pipeline | Lambda `ecolens-process-upload` | S3 trigger: thumbnail + ML + DB write; infer-only for query-by-file |
| REST API | API Gateway + Lambda `ecolens-api` | Upload URL, queries, tags, delete, notifications |
| Auth | Cognito + JWT authorizer | Hosted UI login; protected routes |
| Notifications | SNS + DynamoDB `ecolens-subscriptions` | Tag-based email alerts |

Use one region consistently (e.g. `us-east-1`, matching Cognito).

---

## 2. Resources

### S3 bucket

- Name: globally unique, e.g. `ecolens-media-<team-id>`
- Prefixes: `media/`, `thumbnails/`, `models/model.pt`, `query-scratch/` (temporary query-by-file)
- CORS for browser PUT upload:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedOrigins": ["http://localhost:3000", "https://<your-frontend-origin>"],
    "ExposeHeaders": ["ETag"]
  }
]
```

### DynamoDB `ecolens-files`

| Attribute | Type | Notes |
|-----------|------|-------|
| `checksum` | String (PK) | SHA-256 hex |
| `filename` | String | Basename |
| `mediaType` | String | `image` / `video` |
| `fileUrl` | String | HTTPS object URL |
| `thumbnailUrl` | String | May be empty |
| `tags` | List | Species tags |
| `tagCounts` | Map | Tag → count |
| `detectionSource` | String | e.g. `model:video:1fps` |
| `createdAt` | String | ISO-8601 |

### DynamoDB `ecolens-subscriptions`

See `docs/aws-sns-console-deploy.md`.

### Lambda `ecolens-process-upload`

- **Trigger:** S3 `ObjectCreated` on `media/`
- **Package:** Container image (torch + opencv)
- **Also:** synchronous invoke from `ecolens-api` for `action: infer` (query-by-file)
- **Env:** `MEDIA_BUCKET`, `TABLE_NAME`, `MODEL_S3_URI`, `SNS_TOPIC_ARN`, `SUBSCRIPTIONS_TABLE`, `SNS_NOTIFICATIONS_ENABLED`

### Lambda `ecolens-api`

- **Package:** Zip deployment
- **Routes:** `docs/api-contract.md`
- **Env:** `MEDIA_BUCKET`, `TABLE_NAME`, `PROCESS_UPLOAD_FUNCTION_NAME`, SNS vars, Cognito-related vars
- **IAM:** S3 presigned, DynamoDB, `lambda:InvokeFunction` on process_upload, SNS, subscriptions table

---

## 3. Local → AWS mapping

| Local | AWS |
|-------|-----|
| `POST /upload` saves file | Presigned PUT to `media/`; async processing |
| `detect_tags` / thumbnails | `ecolens-process-upload` |
| SQLite `files` | DynamoDB `ecolens-files` |
| Dedup on checksum | `GetItem` before processing |
| Queries, tags, delete | `ecolens-api` |
| Static `/media` URLs | S3 HTTPS URLs |

---

## 4. Suggested implementation order

1. S3 bucket + model upload + DynamoDB `ecolens-files`
2. Deploy `ecolens-process-upload` + S3 trigger; verify tags in DynamoDB
3. Deploy `ecolens-api` + API Gateway + Cognito authorizer
4. Point frontend `VITE_API_BASE_URL` at API Gateway
5. SNS topic, subscriptions table, notification routes — `docs/aws-sns-console-deploy.md`
6. GCP Cloud Run webhook (optional second cloud)

---

## 5. Model swap

1. Upload new weights to S3 (e.g. `models/model_v2.pt`)
2. Update `MODEL_S3_URI` on `ecolens-process-upload`
3. No code redeploy if the handler reads the URI from env only

---

## 6. Container image (process_upload)

```dockerfile
FROM public.ecr.aws/lambda/python:3.12
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY handler.py inference.py sns_notifications.py ${LAMBDA_TASK_ROOT}/
CMD ["handler.handler"]
```

Build from repo root; see `lambda/README.md`.

---

## 7. Verification

1. Sign in via Cognito
2. Presigned upload → wait for processing → `GET /files` shows tags
3. Run species / tag-count / query-by-file queries
4. Subscribe to a tag → confirm SNS email → upload matching media → receive alert

---

## 8. Local development

Keep `backend/` for fast iteration. JSON shapes match `docs/api-contract.md`.  
Switch the frontend by changing `VITE_API_BASE_URL` only.
