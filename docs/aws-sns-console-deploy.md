# AWS Console — SNS Tag Notification Deployment

This guide adds **SNS email notifications** and the **subscriptions table** on top of an existing S3 / DynamoDB `ecolens-files` / API Lambda / `process_upload` Lambda stack.

See also: `docs/sns-notifications.md`, `docs/api-contract.md`.

---

## Prerequisites

- AWS region matches the Cognito User Pool (e.g. `us-east-1`)
- `ecolens-api` Lambda and API Gateway are deployed and reachable
- `ecolens-process-upload` Lambda is triggered on S3 `media/`
- The frontend can sign in with Cognito and call the API

---

## 1. Create SNS Topic

1. Open the [Amazon SNS console](https://console.aws.amazon.com/sns/)
2. **Topics** → **Create topic**
3. Settings:
   - **Type**: Standard
   - **Name**: `ecolens-tag-alerts`
   - **Display name** (optional): `EcoLens`
4. **Create topic**
5. Copy the **ARN**, for example:

```text
arn:aws:sns:us-east-1:123456789012:ecolens-tag-alerts
```

Store as `SNS_TOPIC_ARN` in Lambda environment variables.

The application calls `sns.subscribe(Protocol=email)` when a user subscribes. You do not add email subscribers manually in the console.

---

## 2. Create DynamoDB Subscriptions Table

1. Open the [DynamoDB console](https://console.aws.amazon.com/dynamodb/)
2. **Create table**
3. Settings:

| Field | Value |
|-------|-------|
| Table name | `ecolens-subscriptions` |
| Partition key | `userSub` (String) |
| Sort key | `tag` (String) |
| Capacity | On-demand (recommended) |

4. **Create table**

Attributes written by the application:

| Attribute | Description |
|-----------|-------------|
| `userSub` | Cognito JWT `sub` |
| `tag` | Lowercase tag, e.g. `canis dingo` |
| `email` | Notification email |
| `createdAt` | ISO-8601 timestamp |

---

## 3. Lambda Environment Variables

### `ecolens-api`

**Configuration** → **Environment variables**:

| Key | Value |
|-----|-------|
| `SNS_TOPIC_ARN` | `arn:aws:sns:us-east-1:...:ecolens-tag-alerts` |
| `SUBSCRIPTIONS_TABLE` | `ecolens-subscriptions` |
| `SNS_NOTIFICATIONS_ENABLED` | `true` |

Ensure the deployment package includes `sns_notifications.py` alongside `handler.py`.

### `ecolens-process-upload`

Add the same three variables.

---

## 4. IAM Permissions (Lambda Execution Roles)

Attach policies to **both** Lambda execution roles.

### SNS

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcoLensSnsPublishSubscribe",
      "Effect": "Allow",
      "Action": [
        "sns:Publish",
        "sns:Subscribe",
        "sns:GetTopicAttributes",
        "sns:ListSubscriptionsByTopic",
        "sns:SetSubscriptionAttributes",
        "sns:Unsubscribe"
      ],
      "Resource": "arn:aws:sns:us-east-1:YOUR_ACCOUNT_ID:ecolens-tag-alerts"
    }
  ]
}
```

Replace `YOUR_ACCOUNT_ID` and region as needed.

### DynamoDB subscriptions table

**`ecolens-api`** (read/write):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcoLensSubscriptionsCrud",
      "Effect": "Allow",
      "Action": [
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:YOUR_ACCOUNT_ID:table/ecolens-subscriptions"
    }
  ]
}
```

**`ecolens-process-upload`** (read-only):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcoLensSubscriptionsRead",
      "Effect": "Allow",
      "Action": [
        "dynamodb:Scan",
        "dynamodb:GetItem",
        "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:YOUR_ACCOUNT_ID:table/ecolens-subscriptions"
    }
  ]
}
```

---

## 5. API Gateway Routes

| Method | Path | Auth |
|--------|------|------|
| GET | `/notifications/subscriptions` | Cognito JWT |
| POST | `/notifications/subscribe` | Cognito JWT |
| POST | `/notifications/unsubscribe` | Cognito JWT |

1. Create routes and integrate with `ecolens-api`
2. Use the same Cognito JWT authorizer as `/files`
3. **Deploy** the stage after changes

**CORS:** allow `GET`, `POST`, `OPTIONS` and headers `Authorization`, `Content-Type`.

---

## 6. Frontend API URL

In `frontend/.env`:

```env
VITE_API_BASE_URL=https://xxxxxxxx.execute-api.us-east-1.amazonaws.com
VITE_UPLOAD_MODE=presigned
```

Rebuild if needed: `cd frontend && npm run build`

---

## 7. End-to-End Verification

### Check configuration

```http
GET /auth/config
```

Expect `"snsConfigured": true`.

### Subscribe

1. Dashboard → **Tag notifications (SNS)**
2. Enter a real notification email
3. Subscribe to a tag the model can detect (e.g. `canis dingo`)
4. Open the **AWS SNS Confirm subscription** email and confirm (required once per inbox)

### Trigger a notification

- Upload media that matches the subscribed tag, or
- Bulk-add the tag to an existing file

### Verify

| Check | Where |
|-------|-------|
| Subscription row | DynamoDB `ecolens-subscriptions` |
| Publish logs | CloudWatch — search `SNS publish` |
| Email | Inbox — subject `EcoLens: new media matches your tag subscription` |
| SNS metrics | Topic → **Monitoring** → NumberOfMessagesPublished |

---

## 8. Troubleshooting

### Subscribed but no email

1. Confirm the AWS SNS subscription email was clicked
2. `SNS_TOPIC_ARN` is set on **both** Lambdas
3. Filter policy uses **both** `tag` and `email`; publishes include matching `MessageAttributes`
4. Check CloudWatch for `SNS publish failed` or `AccessDenied`

### `GET /notifications/subscriptions` returns 404

- Route missing on API Gateway, or stage not deployed
- `VITE_API_BASE_URL` points to the wrong host

### Local backend testing

Set `SNS_TOPIC_ARN` in `backend/.env` and run `uvicorn app:app --port 8001`. Without an ARN, notifications are logged only.

### Duplicate AWS confirm emails

Subscribe followed by a list refresh used to call `sns.subscribe` twice; current code skips subscribe when a pending confirmation already exists.

---

## 9. Deployment Checklist

| Item | Value |
|------|-------|
| `SNS_TOPIC_ARN` | Lambda env on both functions |
| Subscriptions table | `ecolens-subscriptions` |
| API base URL | `frontend/.env` → `VITE_API_BASE_URL` |
| Test inbox | Cognito user email that can receive AWS mail |
