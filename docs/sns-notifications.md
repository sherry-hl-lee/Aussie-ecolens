# SNS Tag Notifications

## Overview

Users subscribe to wildlife **tags** (e.g. `canis dingo`, `koala`). When new media is uploaded or tags are bulk-added, matching subscribers receive an **email** via **AWS SNS**.

| Layer | Storage | Publish |
|-------|---------|---------|
| Local backend | SQLite `tag_subscriptions` | `SNS_TOPIC_ARN` or log simulation |
| AWS API Lambda | DynamoDB `ecolens-subscriptions` | Same SNS topic |
| AWS `process_upload` Lambda | Reads subscriptions (scan) | Publishes after media is stored |

GCP Cloud Run (`gcp-notify-service`) is a separate multi-cloud webhook. SNS is the primary email notification path for this project.

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
| GET | `/notifications/subscriptions` | — | `{ userSub, email, subscriptions[], snsConfigured, notificationsEnabled }` |
| POST | `/notifications/subscribe` | `{ tags: string[], email?: string }` | `{ subscribed[], email, snsConfigured, notificationsSent }` |
| POST | `/notifications/unsubscribe` | `{ tags: string[] }` | `{ unsubscribed[], notificationsSent }` |

Upload and bulk tag responses may include `notificationsSent` (recipient count).

## AWS setup

**Step-by-step console guide:** `docs/aws-sns-console-deploy.md`

Summary:

1. Create SNS topic (e.g. `ecolens-tag-alerts`)
2. Set `SNS_TOPIC_ARN` on API Lambda and `process_upload` Lambda
3. Create DynamoDB table `ecolens-subscriptions` (PK `userSub`, SK `tag`)
4. IAM: `sns:Publish`, `sns:Subscribe`, `sns:ListSubscriptionsByTopic`, `sns:SetSubscriptionAttributes`, `sns:Unsubscribe`; DynamoDB access on the subscriptions table
5. Add API Gateway routes for `/notifications/*`
6. On first subscribe per inbox, the user must confirm the AWS SNS email once

### Filter policy (per inbox + tag)

One email subscription per inbox. All subscribed tags are merged into a single filter:

```json
{"tag": ["canis dingo", "megapodius reinwardt"], "email": ["you@example.com"]}
```

Adding tags updates the filter via `SetSubscriptionAttributes` (no extra confirm per tag).

On publish, each message includes **both** `MessageAttributes.tag` and `MessageAttributes.email`, so each inbox only receives its own notifications.

## Local development

```bash
export SNS_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:ecolens-tag-alerts
export SNS_NOTIFICATIONS_ENABLED=true

cd backend
uvicorn app:app --port 8001
```

1. Open Dashboard → **Tag notifications (SNS)**
2. Subscribe to a tag
3. Upload matching media → check logs or inbox

## Environment variables

| Variable | Lambdas / backend | Default |
|----------|-------------------|---------|
| `SNS_TOPIC_ARN` | api, process_upload, backend | empty → simulated logs |
| `SNS_NOTIFICATIONS_ENABLED` | all | `true` |
| `SUBSCRIPTIONS_TABLE` | api, process_upload | `ecolens-subscriptions` |
