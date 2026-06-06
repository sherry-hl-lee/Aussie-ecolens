# SNS tag notifications (Member D)

## Overview

Users subscribe to wildlife **tags** (e.g. `dingo`, `koala`). When new media is uploaded or tags are bulk-added, matching subscribers receive an **email** via **AWS SNS**.

| Layer | Storage | Publish |
|-------|---------|---------|
| Local backend | SQLite `tag_subscriptions` | `SNS_TOPIC_ARN` or log simulation |
| AWS API Lambda | DynamoDB `ecolens-subscriptions` | Same SNS topic |
| AWS process_upload Lambda | Reads DynamoDB subscriptions | Publishes after DynamoDB write |

GCP Cloud Run (`gcp-notify-service`) remains a separate multi-cloud webhook; SNS is the primary assignment notification path.

## DynamoDB table (`ecolens-subscriptions`)

| Key | Type | Description |
|-----|------|-------------|
| `userSub` | PK (String) | Cognito `sub` |
| `tag` | SK (String) | Normalized lowercase tag |
| `email` | String | Notification email |
| `createdAt` | String | ISO timestamp |

## API endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/notifications/subscriptions` | — | `{ userSub, email, subscriptions[], snsConfigured }` |
| POST | `/notifications/subscribe` | `{ tags: string[], email?: string }` | `{ subscribed[], email, snsConfigured }` |
| POST | `/notifications/unsubscribe` | `{ tags: string[] }` | `{ unsubscribed[] }` |

Upload and bulk tag responses may include `notificationsSent` (recipient count).

## SNS setup (AWS Console)

**Full step-by-step:** `docs/aws-sns-console-deploy.md`

Summary:

1. Create SNS **topic** (e.g. `ecolens-tag-alerts`).
2. Note **Topic ARN** → set `SNS_TOPIC_ARN` on API Lambda and `process_upload` Lambda.
3. Create DynamoDB table `ecolens-subscriptions` (PK `userSub`, SK `tag`).
4. IAM permissions for Lambdas:
   - `sns:Publish`, `sns:Subscribe` on the topic
   - `dynamodb:Query`, `dynamodb:Scan`, `dynamodb:PutItem`, `dynamodb:DeleteItem` on subscriptions table
5. Add API Gateway routes for `/notifications/*`.
6. On first subscribe, SNS sends a **confirmation email** — user must click **Confirm subscription**.

### Filter policy (per-tag delivery)

On subscribe, the API calls:

```text
sns.subscribe(Protocol=email, Endpoint=<email>, FilterPolicy={"tag":["dingo"]})
```

On notify, the processor publishes once per matched tag with message attribute `tag=<tag>`, so only subscribers filtered to that tag receive the email.

## Local development

```bash
# Optional — without SNS_TOPIC_ARN, notifications are logged to backend stdout
export SNS_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:ecolens-tag-alerts
export SNS_NOTIFICATIONS_ENABLED=true

cd backend
uvicorn app:app --port 8001
```

1. Open Dashboard → **Tag notifications (SNS)**.
2. Subscribe to `dingo`.
3. Upload an image detected as dingo → check logs or inbox.

## Environment variables

| Variable | Lambdas / backend | Default |
|----------|-------------------|---------|
| `SNS_TOPIC_ARN` | api, process_upload, backend | empty → simulated logs |
| `SNS_NOTIFICATIONS_ENABLED` | all | `true` |
| `SUBSCRIPTIONS_TABLE` | api, process_upload | `ecolens-subscriptions` |
