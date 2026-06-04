# AWS Deploy Guide (Member A)

This document maps the **local prototype** (`backend/app.py`) to **AWS serverless** for FIT5225 A2.

Reference implementation: `backend/app.py`, `backend/inference.py`  
Lambda skeleton: `lambda/process_upload/`, `lambda/api/`

---

## 1. Target architecture

| Component | AWS service | Purpose |
|-----------|-------------|---------|
| Media storage | S3 `ecolens-media-*` | Original files under `media/`, thumbnails under `thumbnails/` |
| Model artifact | S3 `models/model.pt` | Swap model without code change (`MODEL_S3_URI` env) |
| Metadata | DynamoDB `ecolens-files` | Tags, URLs, checksum dedup |
| Process pipeline | Lambda `ecolens-process-upload` | S3 trigger: thumbnail + ML + write DB |
| REST API | API Gateway + Lambda `ecolens-api` | Queries, presigned upload, bulk tags, delete |
| Auth | Cognito + API JWT authorizer | Member B configures pool; A attaches authorizer |

Region example: `us-east-1` (match your Cognito pool).

---

## 2. Resource checklist

### S3 bucket

- Name: `ecolens-media-<team-id>` (globally unique)
- Prefixes:
  - `media/` — uploaded originals (trigger source)
  - `thumbnails/` — generated JPEG thumbs
  - `models/model.pt` — SpeciesNet weights (upload manually, ~200MB)
- Enable: block public access (use presigned URLs or CloudFront later)
- CORS (for browser PUT upload):

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedOrigins": ["http://localhost:3000", "https://<your-amplify-domain>"],
    "ExposeHeaders": ["ETag"]
  }
]
```

### DynamoDB table `ecolens-files`

| Attribute | Type | Notes |
|-----------|------|-------|
| `checksum` | String (PK) | SHA-256 hex |
| `filename` | String | S3 key basename |
| `mediaType` | String | `image` / `video` |
| `fileUrl` | String | HTTPS URL to object |
| `thumbnailUrl` | String | May be empty for failed video thumb |
| `tags` | List | Common names |
| `tagCounts` | Map | String → Number |
| `detectionSource` | String | e.g. `model:video:1fps` |
| `createdAt` | String | ISO-8601 |

Optional GSI: `tag-index` if you need fast tag queries at scale (MVP can scan table for prototype).

### Lambda `ecolens-process-upload`

- **Trigger:** S3 `ObjectCreated` on prefix `media/`
- **Runtime:** Python 3.12 **Container image** recommended (torch + opencv + onnx2torch)
- **Timeout:** 5–15 min for long videos
- **Memory:** 2048–3008 MB
- **Env vars:**

| Variable | Example |
|----------|---------|
| `MEDIA_BUCKET` | `ecolens-media-team1` |
| `TABLE_NAME` | `ecolens-files` |
| `MODEL_S3_URI` | `s3://ecolens-media-team1/models/model.pt` |
| `LABELS_S3_URI` | `s3://.../labels.txt` (optional) |

- **IAM:** `s3:GetObject` on bucket; `s3:PutObject` on `thumbnails/*`; `dynamodb:GetItem/PutItem` on table

### Lambda `ecolens-api` + API Gateway

- Routes: see `docs/api-contract.md`
- Attach **Cognito JWT authorizer** (Member B)
- CORS on API Gateway for `localhost:3000` and production origin

---

## 3. Migration map (local → AWS)

| Local (`app.py`) | AWS |
|------------------|-----|
| `POST /upload` saves file | Presigned PUT to `media/`; processing async |
| `generated_tags` / `detect_tags` | `lambda/process_upload` copies `inference.py` |
| `create_thumbnail` | Same logic, write to `thumbnails/` |
| `create_video_thumbnail` + `detect_video_tags` | Same; 1 fps per assignment |
| SQLite `files` | DynamoDB `PutItem` |
| Dedup on checksum | `GetItem` before process |
| `GET /files`, `/query/*` | `lambda/api/handler.py` |
| Static `/media`, `/thumbnails` | S3 URLs (presigned GET or public read if allowed) |

---

## 4. Implementation order (Member A)

### Phase A — Storage (Day 1)

1. Create S3 bucket + upload `model.pt` to `models/`
2. Create DynamoDB table
3. Test manual upload to `media/test.jpg`

### Phase B — Process Lambda (Day 2–4)

1. Copy `backend/inference.py` → `lambda/process_upload/inference.py`
2. Implement `handler.py` (see skeleton)
3. Deploy container image to Lambda
4. Add S3 trigger; verify CloudWatch logs + DynamoDB row

### Phase C — API (Day 5–6)

1. Implement `lambda/api/handler.py` routes
2. Wire API Gateway (HTTP API or REST)
3. Share base URL with Member C

### Phase D — Hardening (Day 7)

1. Delete flow: remove S3 objects + DynamoDB item
2. Bulk tags: `UpdateItem` on `tags` / `tagCounts`
3. Document env vars in team report architecture diagram

---

## 5. Model swap (assignment requirement)

Do **not** bake model path into code.

1. Upload new `model.pt` to S3 (e.g. `models/model_v2.pt`)
2. Update Lambda env `MODEL_S3_URI`
3. Redeploy not required if code loads path from env only

---

## 6. torch / dependency note

Zip deployment often exceeds Lambda size limits. Recommended:

```dockerfile
# lambda/process_upload/Dockerfile (outline)
FROM public.ecr.aws/lambda/python:3.12
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY handler.py inference.py ./
CMD ["handler.handler"]
```

Dependencies mirror `backend/requirements.txt` + `onnx2torch`, `opencv-python-headless`.

---

## 7. Demo script (AWS path)

1. Login via Cognito Hosted UI (`http://localhost:3000`)
2. Request presigned URL → upload image to S3
3. Wait ~10s → `GET /files` shows tags + `detectionSource: model:image`
4. `POST /query/species` with `{ "species": "cattle" }` → returns items
5. Show DynamoDB item + S3 thumbnail in console

---

## 8. Handoff to other members

| Member | Needs from A |
|--------|----------------|
| B | API Gateway ID, authorizer attachment, region |
| C | API base URL, upload flow (presigned vs multipart) |
| D | CloudWatch log group, SNS topic ARN (after process Lambda publishes) |

---

## 9. Local dev still valid

Keep `backend/` for fast iteration. Parity rule: **same JSON** as `docs/api-contract.md`.  
When AWS endpoint is ready, frontend changes only `API Base URL`.
