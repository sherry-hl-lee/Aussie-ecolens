"""
API Gateway Lambda — DynamoDB + S3 presigned upload (Member A).

Routes mirror backend/app.py and docs/api-contract.md.
Auth: Cognito JWT authorizer on API Gateway (except /health, /auth/config).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
from decimal import Decimal
from typing import Any
from urllib.parse import unquote

import boto3
from botocore.exceptions import ClientError

from sns_notifications import (
    SNS_NOTIFICATIONS_ENABLED,
    SNS_TOPIC_ARN,
    list_user_subscriptions,
    notify_for_tags_on_item,
    subscribe_tags,
    unsubscribe_tags,
    user_email_from_claims,
    user_sub_from_claims,
)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

MEDIA_BUCKET = os.environ.get("MEDIA_BUCKET", "")
TABLE_NAME = os.environ.get("TABLE_NAME", "")
MEDIA_PREFIX = os.environ.get("MEDIA_PREFIX", "media/")
THUMB_PREFIX = os.environ.get("THUMB_PREFIX", "thumbnails/")
PRESIGNED_EXPIRY = int(os.environ.get("PRESIGNED_EXPIRY_SEC", "3600"))
COGNITO_REGION = os.environ.get("COGNITO_REGION", "")
COGNITO_USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "")
COGNITO_APP_CLIENT_ID = os.environ.get("COGNITO_APP_CLIENT_ID", "")

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME) if TABLE_NAME else None


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """HTTP API / REST API proxy entry."""
    method = (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod", "GET")
    )
    path = normalize_path(event.get("rawPath") or event.get("path", "/"))
    body = parse_body(event)

    try:
        if path == "/health" and method == "GET":
            return respond(200, {"status": "ok"})
        if path == "/auth/config" and method == "GET":
            return auth_config()
        if path == "/auth/me" and method == "GET":
            return auth_me(event)
        if path == "/files" and method == "GET":
            return list_files(event)
        if path == "/upload" and method == "POST":
            return create_presigned_upload(body, event)
        if path == "/query/species" and method == "POST":
            return query_species(body)
        if path == "/query/tags-count" and method == "POST":
            return query_tags_count(body)
        if path == "/query/thumbnail" and method == "POST":
            return query_thumbnail(body)
        if path == "/query/by-file" and method == "POST":
            return query_by_file(event)
        if path == "/tags/bulk" and method == "POST":
            return tags_bulk(body, event)
        if path == "/notifications/subscriptions" and method == "GET":
            return list_notification_subscriptions(event)
        if path == "/notifications/subscribe" and method == "POST":
            return subscribe_notification(event, body)
        if path == "/notifications/unsubscribe" and method == "POST":
            return unsubscribe_notification(event, body)
        if path == "/files/delete" and method == "POST":
            return delete_files(body, event)
        return respond(404, {"detail": f"Not found: {method} {path}"})
    except PermissionError as exc:
        return respond(403, {"detail": str(exc)})
    except ClientError as exc:
        logger.exception("AWS API error")
        return respond(500, {"detail": exc.response.get("Error", {}).get("Message", str(exc))})
    except Exception as exc:
        logger.exception("Unhandled error")
        return respond(500, {"detail": str(exc)})


def normalize_path(path: str) -> str:
    stage = os.environ.get("API_STAGE", "")
    if stage and path.startswith(f"/{stage}"):
        path = path[len(stage) + 1 :] or "/"
    return path.rstrip("/") or "/"


def parse_body(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("body")
    if not raw:
        return {}
    headers = normalize_headers(event)
    content_type = headers.get("content-type", "")
    if "multipart/form-data" in content_type:
        return {}
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    if isinstance(raw, dict):
        return raw
    return json.loads(raw)


def parse_query(event: dict[str, Any]) -> dict[str, str]:
    params = event.get("queryStringParameters") or {}
    return {k: v for k, v in params.items() if v is not None}


def respond(status: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(payload, default=_json_default),
    }


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Not JSON serializable: {type(value)}")


def require_table() -> None:
    if not table or not TABLE_NAME:
        raise RuntimeError("TABLE_NAME is not configured")
    if not MEDIA_BUCKET:
        raise RuntimeError("MEDIA_BUCKET is not configured")


def native_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, list):
        return [native_value(v) for v in value]
    if isinstance(value, dict):
        return {k: native_value(v) for k, v in value.items()}
    return value


def dynamo_to_item(row: dict[str, Any]) -> dict[str, Any]:
    tag_counts = native_value(row.get("tagCounts") or {})
    if isinstance(tag_counts, dict):
        tag_counts = {str(k): int(v) for k, v in tag_counts.items()}
    return {
        "checksum": row["checksum"],
        "filename": row.get("filename", ""),
        "mediaType": row.get("mediaType", "image"),
        "fileUrl": row.get("fileUrl", ""),
        "thumbnailUrl": row.get("thumbnailUrl", ""),
        "tags": [str(t) for t in native_value(row.get("tags") or [])],
        "tagCounts": tag_counts,
        "detectionSource": row.get("detectionSource", ""),
        "createdAt": row.get("createdAt", ""),
        "uploadedBy": row.get("uploadedBy", ""),
    }


def get_claims(event: dict[str, Any]) -> dict[str, Any]:
    authorizer = event.get("requestContext", {}).get("authorizer") or {}
    return authorizer.get("jwt", {}).get("claims") or authorizer.get("claims") or {}


def owner_email(claims: dict[str, Any]) -> str:
    raw = claims.get("email") or claims.get("cognito:username") or claims.get("sub") or ""
    return str(raw).strip().lower()


def assert_owner(event: dict[str, Any], item: dict[str, Any]) -> None:
    """Raise PermissionError when the caller is not the uploader."""
    if not item:
        raise PermissionError("File not found")
    current = owner_email(get_claims(event))
    item_owner = str(item.get("uploadedBy") or "").strip().lower()
    auth_enabled = bool(COGNITO_REGION and COGNITO_USER_POOL_ID)
    if not item_owner:
        if auth_enabled and current:
            raise PermissionError("This file has no owner recorded")
        return
    if auth_enabled and (not current or current != item_owner):
        raise PermissionError("You can only modify or delete your own uploads")


def scan_all_items() -> list[dict[str, Any]]:
    require_table()
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {}
    while True:
        resp = table.scan(**kwargs)
        for row in resp.get("Items", []):
            items.append(dynamo_to_item(row))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    items.sort(key=lambda it: it.get("createdAt", ""), reverse=True)
    return items


def find_item_by_file_url(file_url: str) -> dict[str, Any] | None:
    target_key = s3_key_from_url(file_url)
    if not target_key:
        return None
    for item in scan_all_items():
        if s3_key_from_url(item.get("fileUrl", "")) == target_key:
            return item
    return None


def find_item_by_thumbnail_url(thumbnail_url: str) -> dict[str, Any] | None:
    target_key = s3_key_from_url(thumbnail_url)
    if not target_key:
        return None
    for item in scan_all_items():
        if s3_key_from_url(item.get("thumbnailUrl", "")) == target_key:
            return item
    return None


def find_item_by_checksum(checksum: str) -> dict[str, Any] | None:
    require_table()
    try:
        resp = table.get_item(Key={"checksum": checksum})
        row = resp.get("Item")
        return dynamo_to_item(row) if row else None
    except ClientError:
        logger.exception("get_item failed for checksum %s", checksum)
        return None


def s3_key_from_url(url: str) -> str | None:
    if not url:
        return None
    base = url.split("?", 1)[0]
    marker = ".amazonaws.com/"
    if marker not in base:
        return None
    return unquote(base.split(marker, 1)[1])


def presign_get_url(url: str) -> str:
    """Return a time-limited GET URL for a private S3 object."""
    if not url or not MEDIA_BUCKET:
        return url
    key = s3_key_from_url(url)
    if not key:
        return url
    try:
        return s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": MEDIA_BUCKET, "Key": key},
            ExpiresIn=PRESIGNED_EXPIRY,
        )
    except ClientError:
        logger.exception("Failed to presign s3://%s/%s", MEDIA_BUCKET, key)
        return url


def presign_item(item: dict[str, Any]) -> dict[str, Any]:
    """Expose presigned URLs to the frontend; DynamoDB keeps the canonical S3 URLs."""
    if not item:
        return item
    signed = dict(item)
    if signed.get("fileUrl"):
        signed["fileUrl"] = presign_get_url(signed["fileUrl"])
    if signed.get("thumbnailUrl"):
        signed["thumbnailUrl"] = presign_get_url(signed["thumbnailUrl"])
    return signed


def presign_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [presign_item(it) for it in items]


def safe_filename(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/")).strip()
    base = re.sub(r"[^\w.\-]+", "_", base)
    return base or "upload.bin"


def normalize_headers(event: dict[str, Any]) -> dict[str, str]:
    return {str(k).lower(): str(v) for k, v in (event.get("headers") or {}).items()}


def parse_multipart_file(event: dict[str, Any]) -> tuple[bytes, str]:
    """Extract the uploaded file from API Gateway multipart/form-data body."""
    headers = normalize_headers(event)
    content_type = headers.get("content-type", "")
    if "multipart/form-data" not in content_type:
        raise ValueError("Content-Type must be multipart/form-data")
    if "boundary=" not in content_type:
        raise ValueError("Missing multipart boundary")
    boundary = content_type.split("boundary=", 1)[1].strip().strip('"')
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        data = base64.b64decode(raw)
    elif isinstance(raw, str):
        data = raw.encode("utf-8", errors="replace")
    else:
        data = raw

    for chunk in data.split(f"--{boundary}".encode()):
        if b"Content-Disposition" not in chunk:
            continue
        if b'name="file"' not in chunk and b"name='file'" not in chunk:
            continue
        header_body = chunk.split(b"\r\n\r\n", 1)
        if len(header_body) != 2:
            continue
        head, body = header_body
        filename = "query.bin"
        if b'filename="' in head:
            filename = head.split(b'filename="', 1)[1].split(b'"', 1)[0].decode("utf-8", errors="replace")
        file_bytes = body.rstrip(b"\r\n")
        if file_bytes.endswith(b"--"):
            file_bytes = file_bytes[:-2].rstrip(b"\r\n")
        return file_bytes, filename
    raise ValueError("No file field in multipart body")


def query_tags_for_upload(content: bytes, filename: str) -> list[str]:
    """Tags for query-by-file: reuse stored tags when checksum matches, else fallback."""
    digest = hashlib.sha256(content).hexdigest()
    existing = find_item_by_checksum(digest)
    if existing:
        return [str(t).lower() for t in existing.get("tags", [])]
    seed = int(digest[:8], 16)
    pool = ["dingo", "cattle", "magpie", "koala", "wombat"]
    suffix = os.path.splitext(filename)[1].lower()
    if suffix in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
        pool = ["dingo", "magpie", "cattle"]
    return [pool[seed % len(pool)]]


# --- Routes ---


def auth_config() -> dict[str, Any]:
    auth_required = bool(COGNITO_REGION and COGNITO_USER_POOL_ID)
    return respond(
        200,
        {
            "authRequired": auth_required,
            "cognitoRegion": COGNITO_REGION,
            "userPoolId": COGNITO_USER_POOL_ID,
            "appClientIdConfigured": bool(COGNITO_APP_CLIENT_ID),
            "snsConfigured": bool(SNS_TOPIC_ARN),
            "notificationsEnabled": SNS_NOTIFICATIONS_ENABLED,
        },
    )


def auth_me(event: dict[str, Any]) -> dict[str, Any]:
    authorizer = event.get("requestContext", {}).get("authorizer") or {}
    claims = authorizer.get("jwt", {}).get("claims") or authorizer.get("claims") or {}
    return respond(200, {"authenticated": True, "claims": claims})


def list_files(event: dict[str, Any]) -> dict[str, Any]:
    params = parse_query(event)
    checksum = params.get("checksum", "").strip()

    if checksum:
        item = find_item_by_checksum(checksum)
        items = [presign_item(item)] if item else []
        return respond(
            200,
            {"total": len(items), "limit": 1, "offset": 0, "items": items},
        )

    try:
        limit = max(1, min(200, int(params.get("limit", "20"))))
        offset = max(0, int(params.get("offset", "0")))
    except ValueError:
        return respond(400, {"detail": "limit and offset must be integers"})

    all_items = scan_all_items()
    user_param = params.get("user", "").strip()
    if user_param:
        claims = get_claims(event)
        current = owner_email(claims)
        if user_param.lower() in ("me", "current", "current_user_email"):
            target = current
        else:
            target = user_param.strip().lower()
        auth_enabled = bool(COGNITO_REGION and COGNITO_USER_POOL_ID)
        if auth_enabled and current and target != current:
            return respond(403, {"detail": "Cannot list another user's files"})
        if not target:
            return respond(401, {"detail": "Sign in required for My Uploads"})
        all_items = [
            it for it in all_items if str(it.get("uploadedBy") or "").lower() == target
        ]

    total = len(all_items)
    page = presign_items(all_items[offset : offset + limit])
    return respond(200, {"total": total, "limit": limit, "offset": offset, "items": page})


def create_presigned_upload(body: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    require_table()
    filename = safe_filename(str(body.get("filename", "upload.bin")))
    content_type = str(body.get("contentType", "application/octet-stream")).strip() or "application/octet-stream"
    key = f"{MEDIA_PREFIX}{filename}"
    uploaded_by = owner_email(get_claims(event))
    put_params: dict[str, Any] = {
        "Bucket": MEDIA_BUCKET,
        "Key": key,
        "ContentType": content_type,
    }
    headers: dict[str, str] = {"Content-Type": content_type}
    if uploaded_by:
        put_params["Metadata"] = {"uploaded-by": uploaded_by}
        headers["x-amz-meta-uploaded-by"] = uploaded_by
    upload_url = s3.generate_presigned_url(
        "put_object",
        Params=put_params,
        ExpiresIn=PRESIGNED_EXPIRY,
    )
    return respond(
        200,
        {
            "uploadUrl": upload_url,
            "objectKey": key,
            "headers": headers,
            "note": "After PUT, wait for process Lambda then GET /files",
        },
    )


def query_species(body: dict[str, Any]) -> dict[str, Any]:
    species = str(body.get("species", "")).strip().lower()
    if not species:
        return respond(400, {"detail": "species is required"})
    results = [
        it
        for it in scan_all_items()
        if species in [t.lower() for t in it.get("tags", [])]
    ]
    return respond(200, {"count": len(results), "items": presign_items(results)})


def query_tags_count(body: dict[str, Any]) -> dict[str, Any]:
    if not body:
        return respond(400, {"detail": "tag count map is required"})
    requested = {str(k).lower(): int(v) for k, v in body.items()}
    results: list[dict[str, Any]] = []
    for item in scan_all_items():
        counts = {k.lower(): int(v) for k, v in item.get("tagCounts", {}).items()}
        if all(counts.get(tag, 0) >= min_count for tag, min_count in requested.items()):
            results.append(item)
    return respond(200, {"count": len(results), "items": presign_items(results)})


def query_thumbnail(body: dict[str, Any]) -> dict[str, Any]:
    thumb = str(body.get("thumbnailUrl", "")).strip()
    if not thumb:
        return respond(400, {"detail": "thumbnailUrl is required"})
    item = find_item_by_thumbnail_url(thumb)
    if not item:
        return respond(404, {"detail": "Thumbnail not found"})
    signed = presign_item(item)
    return respond(200, {"fileUrl": signed["fileUrl"], "item": signed})


def query_by_file(event: dict[str, Any]) -> dict[str, Any]:
    """Run species tags on an uploaded file (not stored) and match library items."""
    try:
        content, _filename = parse_multipart_file(event)
    except ValueError as exc:
        return respond(400, {"detail": str(exc)})
    if not content:
        return respond(400, {"detail": "Empty file."})

    query_tags = query_tags_for_upload(content, _filename)
    required = {t.lower() for t in query_tags}
    results = [
        it
        for it in scan_all_items()
        if required.issubset({t.lower() for t in it.get("tags", [])})
    ]
    return respond(
        200,
        {
            "queryTags": query_tags,
            "count": len(results),
            "items": presign_items(results),
        },
    )


def tags_bulk(body: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    require_table()
    urls = body.get("urls") or []
    tags = [str(t).lower() for t in body.get("tags", [])]
    operation = int(body.get("operation", 1))
    updated = 0
    notifications_sent = 0

    for url in urls:
        item = find_item_by_file_url(str(url))
        if not item:
            continue
        assert_owner(event, item)
        item_tags = set(t.lower() for t in item.get("tags", []))
        counts = {k.lower(): int(v) for k, v in item.get("tagCounts", {}).items()}

        if operation == 1:
            for tag in tags:
                item_tags.add(tag)
                counts[tag] = max(1, counts.get(tag, 1))
        else:
            for tag in tags:
                item_tags.discard(tag)
                counts.pop(tag, None)

        updated_item = {
            **item,
            "tags": sorted(item_tags),
            "tagCounts": counts,
        }
        table.update_item(
            Key={"checksum": item["checksum"]},
            UpdateExpression="SET tags = :tags, tagCounts = :counts",
            ExpressionAttributeValues={
                ":tags": sorted(item_tags),
                ":counts": {k: Decimal(v) for k, v in counts.items()},
            },
        )
        updated += 1
        if operation == 1:
            notifications_sent += notify_for_tags_on_item(updated_item, tags)

    return respond(200, {"updated": updated, "notificationsSent": notifications_sent})


def claims_from_event(event: dict[str, Any]) -> dict[str, Any]:
    authorizer = event.get("requestContext", {}).get("authorizer") or {}
    return authorizer.get("jwt", {}).get("claims") or authorizer.get("claims") or {}


def list_notification_subscriptions(event: dict[str, Any]) -> dict[str, Any]:
    claims = claims_from_event(event)
    user_sub = user_sub_from_claims(claims)
    return respond(
        200,
        {
            "userSub": user_sub,
            "email": user_email_from_claims(claims),
            "subscriptions": list_user_subscriptions(user_sub),
            "snsConfigured": bool(SNS_TOPIC_ARN),
            "notificationsEnabled": SNS_NOTIFICATIONS_ENABLED,
        },
    )


def subscribe_notification(event: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    tags = body.get("tags") or []
    if not tags:
        return respond(400, {"detail": "tags is required"})
    claims = claims_from_event(event)
    user_sub = user_sub_from_claims(claims)
    email = user_email_from_claims(claims, str(body.get("email", "")))
    subscribed = subscribe_tags(user_sub, email, tags)
    return respond(
        200,
        {
            "subscribed": subscribed,
            "email": email,
            "snsConfigured": bool(SNS_TOPIC_ARN),
        },
    )


def unsubscribe_notification(event: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    tags = body.get("tags") or []
    if not tags:
        return respond(400, {"detail": "tags is required"})
    claims = claims_from_event(event)
    user_sub = user_sub_from_claims(claims)
    unsubscribed = unsubscribe_tags(user_sub, tags)
    return respond(200, {"unsubscribed": unsubscribed})


def delete_files(body: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    require_table()
    urls = body.get("urls") or []
    deleted = 0

    for url in urls:
        item = find_item_by_file_url(str(url))
        if not item:
            continue
        assert_owner(event, item)

        for link in (item.get("fileUrl"), item.get("thumbnailUrl")):
            if not link:
                continue
            key = s3_key_from_url(link)
            if key:
                try:
                    s3.delete_object(Bucket=MEDIA_BUCKET, Key=key)
                except ClientError:
                    logger.exception("Failed to delete s3://%s/%s", MEDIA_BUCKET, key)

        table.delete_item(Key={"checksum": item["checksum"]})
        deleted += 1

    return respond(200, {"deleted": deleted})
