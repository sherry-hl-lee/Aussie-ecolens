# AWS Console — SNS 标签通知部署指南 (Member D)

本指南在 **已有** S3 / DynamoDB `ecolens-files` / API Lambda / process_upload Lambda 的基础上，补齐 **SNS 邮件通知** 与 **订阅表** 的 AWS 控制台操作步骤。

本地开发见 `docs/sns-notifications.md`；API 契约见 `docs/api-contract.md`。

---

## 0. 前置条件

- AWS 区域与 Cognito User Pool **一致**（例如 `us-east-1`）
- `ecolens-api` Lambda 与 API Gateway 已部署并可访问
- `ecolens-process-upload` Lambda 已绑定 S3 `media/` 触发器
- 前端能通过 Cognito 登录并调用 API

---

## 1. 创建 SNS Topic

1. 打开 [Amazon SNS 控制台](https://console.aws.amazon.com/sns/)
2. 左侧 **Topics** → **Create topic**
3. 配置：
   - **Type**: Standard
   - **Name**: `ecolens-tag-alerts`（可自定义）
   - **Display name**（可选）: `EcoLens`
4. **Create topic**
5. 进入 Topic 详情页，复制 **ARN**，形如：

```text
arn:aws:sns:us-east-1:123456789012:ecolens-tag-alerts
```

保存为团队共享变量 `SNS_TOPIC_ARN`。

> **说明**：代码在用户订阅时自动调用 `sns.subscribe(Protocol=email)`，无需在控制台手动添加订阅者。

---

## 2. 创建 DynamoDB 订阅表

1. 打开 [DynamoDB 控制台](https://console.aws.amazon.com/dynamodb/)
2. **Create table**
3. 配置：

| 字段 | 值 |
|------|-----|
| Table name | `ecolens-subscriptions` |
| Partition key | `userSub` (String) |
| Sort key | `tag` (String) |
| Table class | Standard |
| Capacity | On-demand（推荐） |

4. **Create table**

表结构（由代码写入，无需手动建属性）：

| 属性 | 说明 |
|------|------|
| `userSub` | Cognito JWT 的 `sub` |
| `tag` | 小写标签名，如 `dingo` |
| `email` | 通知邮箱 |
| `createdAt` | ISO-8601 时间戳 |

---

## 3. 更新 Lambda 环境变量

### 3.1 `ecolens-api` Lambda

1. Lambda 控制台 → 选择 `ecolens-api`
2. **Configuration** → **Environment variables** → **Edit**
3. 新增或更新：

| Key | Value |
|-----|-------|
| `SNS_TOPIC_ARN` | `arn:aws:sns:us-east-1:...:ecolens-tag-alerts` |
| `SUBSCRIPTIONS_TABLE` | `ecolens-subscriptions` |
| `SNS_NOTIFICATIONS_ENABLED` | `true` |

4. **Save**

5. 确认部署包包含 `sns_notifications.py`（与 `handler.py` 同目录）。若只有 `handler.py`，需重新打包上传。

### 3.2 `ecolens-process-upload` Lambda

同样添加上述三个环境变量。

---

## 4. IAM 权限（Lambda 执行角色）

对 **两个** Lambda 的执行角色（Execution role）附加策略。可用内联策略或新建 Customer managed policy。

### 4.1 SNS 权限

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

将 `YOUR_ACCOUNT_ID` 和区域替换为实际值。

### 4.2 DynamoDB 订阅表权限

**仅 `ecolens-api` 需要写权限**；`process_upload` 只需读（scan）：

**ecolens-api**（Query + Put + Delete + Scan）：

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

**ecolens-process-upload**（Scan 只读）：

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

控制台路径：**IAM** → **Roles** → `<lambda-role-name>` → **Add permissions** → **Create inline policy** → JSON 粘贴 → **Review** → **Create policy**。

---

## 5. API Gateway 路由

在现有 API Gateway 上为通知端点添加路由（HTTP API 或 REST API 均可，路径须与代码一致）。

| Method | Path | Auth |
|--------|------|------|
| GET | `/notifications/subscriptions` | Cognito JWT |
| POST | `/notifications/subscribe` | Cognito JWT |
| POST | `/notifications/unsubscribe` | Cognito JWT |

### HTTP API（常见）

1. API Gateway → 你的 API → **Routes** → **Create**
2. 分别创建上述三条路由，集成到 `ecolens-api` Lambda
3. 确认 **Authorization** 使用 Cognito JWT authorizer（与 `/files` 相同）
4. **Deploy** 到 `prod` / `$default` stage

### CORS

确保 API 对浏览器返回 `Access-Control-Allow-Origin`（代码已在 Lambda 响应头设置 `*`）。若 Gateway 层有 CORS 配置，需包含：

- Methods: `GET, POST, OPTIONS`
- Headers: `Authorization, Content-Type`

---

## 6. 前端指向 AWS API

复制 `frontend/.env.example` 为 `.env`，将 API 改为 API Gateway 地址：

```env
VITE_API_BASE_URL=https://xxxxxxxx.execute-api.us-east-1.amazonaws.com
```

重新构建并部署前端：

```bash
cd frontend
npm run build
```

---

## 7. 端到端验证（Demo 脚本）

### Step 1 — 检查配置

```http
GET /auth/config
```

响应应包含 `"snsConfigured": true`。

### Step 2 — 订阅标签

1. Dashboard → **Tag notifications (SNS)**
2. 邮箱填真实可收信地址（或与 Cognito 账号邮箱一致）
3. 订阅 `dingo`（或你模型能识别的物种）
4. 查收 **AWS SNS 确认邮件** → 点击 **Confirm subscription**（必须，否则收不到通知）

### Step 3 — 触发通知

- **路径 A**：上传一张会被识别为 `dingo` 的图片（S3 presigned 流程 → process_upload）
- **路径 B**：在图库选中文件 → Bulk add tag `dingo`

### Step 4 — 验证

| 检查项 | 位置 |
|--------|------|
| 订阅记录 | DynamoDB `ecolens-subscriptions` 表 |
| 发布日志 | CloudWatch → `ecolens-process-upload` 或 `ecolens-api` 日志，搜索 `SNS publish` |
| 邮件 | 收件箱（主题：`EcoLens: new media matches your tag subscription`） |
| SNS 指标 | SNS Topic → **Monitoring** → NumberOfMessagesPublished |

---

## 8. 常见问题

### 订阅成功但收不到邮件

1. 是否点击了 SNS **Confirm subscription** 邮件？
2. `SNS_TOPIC_ARN` 是否在 **两个** Lambda 上都配置？
3. Filter policy：发布时带 `MessageAttributes.tag`，订阅时带 `FilterPolicy={"tag":["dingo"]}` — 标签名须**小写**且与检测标签一致
4. 查 CloudWatch 是否有 `SNS publish failed`

### 前端 `GET /notifications/subscriptions` 404

- API Gateway 未添加该路由，或 stage 未重新 Deploy
- `VITE_API_BASE_URL` 仍指向 `localhost:8001`

### 本地后端测试 SNS

在 `backend/.env` 配置 `SNS_TOPIC_ARN` 和 AWS 凭证（`aws configure`），运行 `uvicorn app:app --port 8001`。无 ARN 时通知仅打印到终端日志。

### 重复邮件

同一邮箱对同一 tag 多次 subscribe 可能产生多条 SNS 订阅；DynamoDB 侧用 `userSub + tag` 去重，SNS 侧属正常行为，demo 时避免重复点击。

---

## 9. 团队交接清单

| 交付物 | 内容 |
|--------|------|
| `SNS_TOPIC_ARN` | 写入 Lambda env + 团队密码库 |
| DynamoDB 表名 | `ecolens-subscriptions` |
| API 基址 | 给 Member C 更新前端 `.env` |
| Demo 账号 | Cognito 测试用户邮箱（用于收 SNS 确认信） |
| 架构图 | S3 → process_upload → SNS + DynamoDB subscriptions |
