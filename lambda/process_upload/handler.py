"""
S3-triggered media processor (AWS Member A skeleton).

Trigger: ObjectCreated on s3://<MEDIA_BUCKET>/media/*
Flow:
  1. Download object to /tmp
  2. SHA-256 checksum + DynamoDB dedup
  3. Image: thumbnail + model tags
  4. Video: 1 fps frames + aggregate tags + first-frame thumbnail
  5. PutItem DynamoDB

Before deploy:
  - Copy backend/inference.py to lambda/process_upload/inference.py
  - Set env: MEDIA_BUCKET, TABLE_NAME, MODEL_S3_URI
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import boto3
from botocore.exceptions import ClientError

from sns_notifications import notify_for_media_item

# After copy: from inference import detect_image_tags, detect_video_tags
try:
    from inference import detect_image_tags, detect_video_tags
except ImportError:
    detect_image_tags = None  # type: ignore
    detect_video_tags = None  # type: ignore

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

MEDIA_BUCKET = os.environ["MEDIA_BUCKET"]
TABLE_NAME = os.environ["TABLE_NAME"]
MODEL_S3_URI = os.environ.get("MODEL_S3_URI", "")
MEDIA_PREFIX = os.environ.get("MEDIA_PREFIX", "media/")
THUMB_PREFIX = os.environ.get("THUMB_PREFIX", "thumbnails/")
GCP_NOTIFY_URL = os.environ.get("GCP_NOTIFY_URL", "")
GCP_WEBHOOK_SECRET = os.environ.get("GCP_WEBHOOK_SECRET", "")

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)

# Loaded once per cold start
_MODEL_LOCAL_PATH: Path | None = None
_TAXONOMY_MAP: dict[str, str] = {}


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry for S3 events or direct infer-only invocations from ecolens-api."""
    if event.get("action") == "infer":
        return infer_tags_only(event)
    results = []
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]
        if not key.startswith(MEDIA_PREFIX):
            logger.info("Skip non-media key: %s", key)
            continue
        results.append(process_object(bucket, key))
    return {"processed": results}


def safe_filename(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/")).strip()
    base = re.sub(r"[^\w.\-]+", "_", base)
    return base or "query.bin"


def infer_tags_only(event: dict[str, Any]) -> dict[str, Any]:
    """Run ML on uploaded bytes without writing to S3 or DynamoDB (query-by-file)."""
    content_b64 = str(event.get("contentBase64") or "").strip()
    if not content_b64:
        return {"error": "contentBase64 is required"}
    try:
        content = base64.b64decode(content_b64)
    except (ValueError, TypeError):
        return {"error": "Invalid contentBase64"}

    filename = safe_filename(str(event.get("filename") or "query.bin"))
    if not content:
        return {"error": "Empty file."}

    suffix = Path(filename).suffix.lower()
    media_type = "video" if suffix in {".mp4", ".mov", ".avi", ".mkv", ".webm"} else "image"
    checksum = hashlib.sha256(content).hexdigest()

    with tempfile.TemporaryDirectory() as tmp:
        local_path = Path(tmp) / filename
        local_path.write_bytes(content)
        model_path = ensure_model_downloaded(tmp)
        taxonomy_map = load_taxonomy_map(tmp)
        tags, tag_counts, detection_source = run_detection(
            local_path, media_type, checksum, model_path, taxonomy_map
        )

    return {
        "tags": [str(t).lower() for t in tags],
        "tagCounts": {str(k).lower(): int(v) for k, v in tag_counts.items()},
        "detectionSource": detection_source,
    }


def process_object(bucket: str, key: str) -> dict[str, Any]:
    filename = Path(key).name
    suffix = Path(filename).suffix.lower()
    media_type = "video" if suffix in {".mp4", ".mov", ".avi", ".mkv", ".webm"} else "image"

    with tempfile.TemporaryDirectory() as tmp:
        local_path = Path(tmp) / filename
        s3.download_file(bucket, key, str(local_path))
        content = local_path.read_bytes()
        checksum = hashlib.sha256(content).hexdigest()

        if existing := get_item_by_checksum(checksum):
            logger.info("Deduplicated %s -> existing checksum", key)
            return {"deduplicated": True, "checksum": checksum, "item": existing}

        model_path = ensure_model_downloaded(tmp)
        taxonomy_map = load_taxonomy_map(tmp)

        tags, tag_counts, detection_source = run_detection(
            local_path, media_type, checksum, model_path, taxonomy_map
        )

        file_url = object_public_url(bucket, key)
        thumbnail_url = ""
        if media_type == "image":
            thumb_key = write_image_thumbnail(local_path, filename, tmp)
            thumbnail_url = object_public_url(bucket, thumb_key)
        elif media_type == "video":
            thumb_key = write_video_thumbnail(local_path, filename, tmp)
            if thumb_key:
                thumbnail_url = object_public_url(bucket, thumb_key)

        uploaded_by = read_uploaded_by_metadata(bucket, key)

        item = {
            "checksum": checksum,
            "filename": filename,
            "mediaType": media_type,
            "fileUrl": file_url,
            "thumbnailUrl": thumbnail_url,
            "tags": tags,
            "tagCounts": tag_counts,
            "detectionSource": detection_source,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "uploadedBy": uploaded_by,
        }
        put_item(item)
        notifications_sent = notify_for_media_item(item)
        gcp_result = notify_gcp_tagged(item, key)
        result: dict[str, Any] = {
            "deduplicated": False,
            "checksum": checksum,
            "item": item,
            "notificationsSent": notifications_sent,
        }
        if gcp_result is not None:
            result["gcpNotify"] = gcp_result
        return result


def get_item_by_checksum(checksum: str) -> dict[str, Any] | None:
    try:
        resp = table.get_item(Key={"checksum": checksum})
        return resp.get("Item")
    except ClientError:
        logger.exception("DynamoDB get_item failed")
        return None


def notify_gcp_tagged(item: dict[str, Any], object_key: str) -> dict[str, Any] | None:
    """POST tags to Member B GCP Cloud Run after DynamoDB write (best-effort)."""
    if not GCP_NOTIFY_URL or not GCP_WEBHOOK_SECRET:
        logger.info("GCP notify skipped (GCP_NOTIFY_URL or GCP_WEBHOOK_SECRET not set)")
        return None

    payload = {
        "event": "media.tagged",
        "checksum": item["checksum"],
        "filename": object_key,
        "fileUrl": item["fileUrl"],
        "thumbnailUrl": item.get("thumbnailUrl") or "",
        "tags": item["tags"],
        "tagCounts": item["tagCounts"],
        "userSub": item.get("uploadedBy", ""),
        "source": "aws-lambda",
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        GCP_NOTIFY_URL,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Webhook-Secret": GCP_WEBHOOK_SECRET,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            logger.info("GCP notify OK status=%s body=%s", resp.status, body[:500])
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        logger.warning("GCP notify HTTP %s: %s", exc.code, err_body[:500])
    except Exception:
        logger.exception("GCP notify failed")
    return None


def read_uploaded_by_metadata(bucket: str, key: str) -> str:
    try:
        resp = s3.head_object(Bucket=bucket, Key=key)
        meta = resp.get("Metadata") or {}
        return str(meta.get("uploaded-by") or meta.get("uploaded_by") or "").strip().lower()
    except ClientError:
        logger.exception("head_object failed for s3://%s/%s", bucket, key)
        return ""


def put_item(item: dict[str, Any]) -> None:
    # DynamoDB requires Decimal for numbers in tagCounts — convert in production.
    row: dict[str, Any] = {
        "checksum": item["checksum"],
        "filename": item["filename"],
        "mediaType": item["mediaType"],
        "fileUrl": item["fileUrl"],
        "thumbnailUrl": item["thumbnailUrl"],
        "tags": item["tags"],
        "tagCounts": item["tagCounts"],
        "detectionSource": item["detectionSource"],
        "createdAt": item["createdAt"],
    }
    if item.get("uploadedBy"):
        row["uploadedBy"] = item["uploadedBy"]
    table.put_item(Item=row)


def run_detection(
    path: Path,
    media_type: str,
    checksum: str,
    model_path: Path,
    taxonomy_map: dict[str, str],
) -> tuple[list[str], dict[str, int], str]:
    if detect_image_tags and detect_video_tags and model_path.exists():
        try:
            if media_type == "image":
                return detect_image_tags(path, model_path, taxonomy_map)
            return detect_video_tags(path, model_path, taxonomy_map, sample_fps=1)
        except Exception:
            logger.exception("Model inference failed for %s", path.name)
    return fallback_tags(checksum, media_type)


def fallback_tags(checksum: str, media_type: str) -> tuple[list[str], dict[str, int], str]:
    seed = int(checksum[:8], 16)
    tags = ["dingo", "cattle", "magpie"]
    tag = tags[seed % len(tags)]
    return [tag], {tag: 1}, "fallback:checksum" if media_type == "image" else "fallback:video"


def ensure_model_downloaded(tmp_dir: str) -> Path:
    global _MODEL_LOCAL_PATH
    if _MODEL_LOCAL_PATH and _MODEL_LOCAL_PATH.exists():
        return _MODEL_LOCAL_PATH
    if not MODEL_S3_URI.startswith("s3://"):
        return Path("/nonexistent")
    _, _, rest = MODEL_S3_URI.partition("s3://")
    bucket, _, key = rest.partition("/")
    dest = Path(tmp_dir) / "model.pt"
    s3.download_file(bucket, key, str(dest))
    _MODEL_LOCAL_PATH = dest
    return dest


def load_taxonomy_map(tmp_dir: str) -> dict[str, str]:
    global _TAXONOMY_MAP
    if _TAXONOMY_MAP:
        return _TAXONOMY_MAP
    # TODO: download labels.txt from S3 or bundle in image
    return _TAXONOMY_MAP


def write_image_thumbnail(src: Path, filename: str, tmp_dir: str) -> str:
    from PIL import Image

    thumb_name = f"{Path(filename).stem}_thumb.jpg"
    out = Path(tmp_dir) / thumb_name
    with Image.open(src).convert("RGB") as img:
        img.thumbnail((320, 320))
        img.save(out, format="JPEG", quality=82)
    key = f"{THUMB_PREFIX}{thumb_name}"
    s3.upload_file(str(out), MEDIA_BUCKET, key, ExtraArgs={"ContentType": "image/jpeg"})
    return key


def write_video_thumbnail(video: Path, filename: str, tmp_dir: str) -> str | None:
    import cv2
    from PIL import Image

    cap = cv2.VideoCapture(str(video))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        return None
    thumb_name = f"{Path(filename).stem}_thumb.jpg"
    out = Path(tmp_dir) / thumb_name
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(rgb)
    img.thumbnail((320, 320))
    img.save(out, format="JPEG", quality=82)
    key = f"{THUMB_PREFIX}{thumb_name}"
    s3.upload_file(str(out), MEDIA_BUCKET, key, ExtraArgs={"ContentType": "image/jpeg"})
    return key


def object_public_url(bucket: str, key: str) -> str:
    region = os.environ.get("AWS_REGION", "us-east-1")
    encoded = quote(key, safe="/")
    return f"https://{bucket}.s3.{region}.amazonaws.com/{encoded}"
