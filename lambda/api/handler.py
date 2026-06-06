"""
API Gateway Lambda — DynamoDB + S3 presigned upload (Member A).

Routes mirror backend/app.py and docs/api-contract.md.
Auth: Cognito JWT authorizer on API Gateway (except /health, /auth/config).
"""

from __future__ import annotations

import json
import logging
import os
import re
from decimal import Decimal
from typing import Any
from urllib.parse import unquote

import boto3
from botocore.exceptions import ClientError

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
            return create_presigned_upload(body)
        if path == "/query/species" and method == "POST":
            return query_species(body)
        if path == "/query/tags-count" and method == "POST":
            return query_tags_count(body)
        if path == "/query/thumbnail" and method == "POST":
            return query_thumbnail(body)
        if path == "/tags/bulk" and method == "POST":
            return tags_bulk(body)
        if path == "/files/delete" and method == "POST":
            return delete_files(body)
        return respond(404, {"detail": f"Not found: {method} {path}"})
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
    if event.get("isBase64Encoded"):
        import base64

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
    }


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
    total = len(all_items)
    page = presign_items(all_items[offset : offset + limit])
    return respond(200, {"total": total, "limit": limit, "offset": offset, "items": page})


def create_presigned_upload(body: dict[str, Any]) -> dict[str, Any]:
    require_table()
    filename = safe_filename(str(body.get("filename", "upload.bin")))
    content_type = str(body.get("contentType", "application/octet-stream")).strip() or "application/octet-stream"
    key = f"{MEDIA_PREFIX}{filename}"
    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": MEDIA_BUCKET, "Key": key, "ContentType": content_type},
        ExpiresIn=PRESIGNED_EXPIRY,
    )
    return respond(
        200,
        {
            "uploadUrl": upload_url,
            "objectKey": key,
            "headers": {"Content-Type": content_type},
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


def tags_bulk(body: dict[str, Any]) -> dict[str, Any]:
    require_table()
    urls = body.get("urls") or []
    tags = [str(t).lower() for t in body.get("tags", [])]
    operation = int(body.get("operation", 1))
    updated = 0

    for url in urls:
        item = find_item_by_file_url(str(url))
        if not item:
            continue
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

        table.update_item(
            Key={"checksum": item["checksum"]},
            UpdateExpression="SET tags = :tags, tagCounts = :counts",
            ExpressionAttributeValues={
                ":tags": sorted(item_tags),
                ":counts": {k: Decimal(v) for k, v in counts.items()},
            },
        )
        updated += 1

    return respond(200, {"updated": updated})


def delete_files(body: dict[str, Any]) -> dict[str, Any]:
    require_table()
    urls = body.get("urls") or []
    deleted = 0

    for url in urls:
        item = find_item_by_file_url(str(url))
        if not item:
            continue

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
