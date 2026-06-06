from __future__ import annotations

import json
import logging
import os
import time
from typing import Any
from urllib.request import urlopen

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from auth import AUTH_REQUIRED, COGNITO_APP_CLIENT_ID, COGNITO_REGION, COGNITO_USER_POOL_ID, require_auth

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gcp-notify")

app = FastAPI(title="Aussie EcoLens GCP Notify", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "").strip()
NOTIFICATIONS: list[dict[str, Any]] = []


class NotifyPayload(BaseModel):
    event: str = "media.tagged"
    checksum: str | None = None
    filename: str | None = None
    fileUrl: str | None = None
    thumbnailUrl: str | None = None
    tags: list[str] = Field(default_factory=list)
    tagCounts: dict[str, int] = Field(default_factory=dict)
    userSub: str | None = None
    source: str = "aws-lambda"


def watched_tags() -> set[str]:
    raw = os.getenv("WATCHED_TAGS", "dingo,koala,wombat,magpie")
    return {t.strip().lower() for t in raw.split(",") if t.strip()}


def verify_webhook(request: Request) -> None:
    if not WEBHOOK_SECRET:
        return
    header = request.headers.get("X-Webhook-Secret", "")
    if header != WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Webhook-Secret.")


def matching_tags(tags: list[str]) -> list[str]:
    watch = watched_tags()
    found: list[str] = []
    for tag in tags:
        normalized = str(tag).strip().lower()
        if normalized in watch:
            found.append(normalized)
    return sorted(set(found))


def record_notification(payload: NotifyPayload, matched: list[str]) -> dict[str, Any]:
    entry = {
        "id": len(NOTIFICATIONS) + 1,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": payload.event,
        "matchedTags": matched,
        "tags": [str(t).lower() for t in payload.tags],
        "tagCounts": payload.tagCounts,
        "checksum": payload.checksum,
        "filename": payload.filename,
        "fileUrl": payload.fileUrl,
        "thumbnailUrl": payload.thumbnailUrl,
        "userSub": payload.userSub,
        "source": payload.source,
        "channel": "log",
    }
    NOTIFICATIONS.append(entry)
    logger.info("EcoLens notification: %s", json.dumps(entry, ensure_ascii=True))
    return entry


def process_notify(payload: NotifyPayload) -> dict[str, Any]:
    matched = matching_tags(payload.tags)
    notifications: list[dict[str, Any]] = []
    if matched:
        notifications.append(record_notification(payload, matched))
    return {
        "accepted": True,
        "watchedTags": sorted(watched_tags()),
        "matchedTags": matched,
        "notified": bool(matched),
        "notifications": notifications,
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "gcp-notify"}


@app.get("/auth/config")
def auth_config() -> dict[str, Any]:
    return {
        "authRequired": AUTH_REQUIRED,
        "cognitoRegion": COGNITO_REGION,
        "userPoolId": COGNITO_USER_POOL_ID,
        "appClientIdConfigured": bool(COGNITO_APP_CLIENT_ID),
        "watchedTags": sorted(watched_tags()),
        "webhookSecretConfigured": bool(WEBHOOK_SECRET),
    }


@app.get("/auth/me")
def auth_me(claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    return {"authenticated": True, "cloud": "gcp", "claims": claims}


@app.get("/notifications")
def list_notifications(
    limit: int = 20,
    claims: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    items = list(reversed(NOTIFICATIONS))[: max(1, min(limit, 100))]
    return {"count": len(items), "items": items}


@app.post("/notify")
async def notify(request: Request) -> dict[str, Any]:
    verify_webhook(request)
    body = await request.json()
    payload = NotifyPayload.model_validate(body)
    return process_notify(payload)


@app.post("/sns")
async def sns_webhook(request: Request) -> dict[str, Any]:
    """Accept AWS SNS HTTPS subscription or notification payloads."""
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty SNS body.")
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid SNS JSON.") from exc

    msg_type = envelope.get("Type", "")
    if msg_type == "SubscriptionConfirmation":
        subscribe_url = envelope.get("SubscribeURL", "")
        if subscribe_url:
            try:
                with urlopen(subscribe_url, timeout=10):
                    pass
                logger.info("SNS subscription confirmed.")
            except OSError as exc:
                logger.warning("SNS subscription confirm failed: %s", exc)
        return {"accepted": True, "snsType": msg_type, "confirmed": bool(subscribe_url)}

    if msg_type == "Notification":
        message = envelope.get("Message", "{}")
        try:
            inner = json.loads(message) if isinstance(message, str) else message
        except json.JSONDecodeError:
            inner = {"rawMessage": message}
        payload = NotifyPayload.model_validate(inner)
        result = process_notify(payload)
        result["snsType"] = msg_type
        return result

    raise HTTPException(status_code=400, detail=f"Unsupported SNS Type: {msg_type}")
