# Lambda functions (Member A)

| Directory | Trigger | Role |
|-----------|---------|------|
| `process_upload/` | S3 `ObjectCreated` on `media/` | Thumbnail, ML tags, DynamoDB write |
| `api/` | API Gateway | REST routes (query, upload URL, delete) |

## Setup

1. Copy `backend/inference.py` into `process_upload/inference.py` (keep in sync).
2. Use **container image** deployment for `process_upload` (torch size).
3. See `docs/aws-deploy.md` for AWS console steps.

## Environment variables

**process_upload**

- `MEDIA_BUCKET`
- `TABLE_NAME`
- `MODEL_S3_URI`
- `AWS_REGION` (auto in Lambda)
- `GCP_NOTIFY_URL` — e.g. `https://...a.run.app/notify` (Member B; optional)
- `GCP_WEBHOOK_SECRET` — from Member B DM only; never commit
- `SNS_TOPIC_ARN` — SNS topic for tag email alerts (Member D)
- `SUBSCRIPTIONS_TABLE` — DynamoDB table (default `ecolens-subscriptions`, PK `userSub`, SK `tag`)
- `SNS_NOTIFICATIONS_ENABLED` — `true` / `false` (default `true`)

**api**

- `MEDIA_BUCKET`
- `TABLE_NAME`
- `PRESIGNED_EXPIRY_SEC` (default 3600)
- `SNS_TOPIC_ARN`, `SUBSCRIPTIONS_TABLE`, `SNS_NOTIFICATIONS_ENABLED` — same as above

Package `sns_notifications.py` alongside `handler.py` in both Lambda deployments.
