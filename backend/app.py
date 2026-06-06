from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote
from urllib.error import URLError
from urllib.request import urlopen

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from inference import detect_image_tags, detect_video_tags
import cv2
from jose import JWTError, jwt
from PIL import Image

RESAMPLE = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS

BASE_DIR = Path(__file__).resolve().parent


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        value = value.strip()
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(BASE_DIR / ".env")

DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
THUMBNAILS_DIR = DATA_DIR / "thumbnails"
DB_PATH = DATA_DIR / "ecolens.db"
LABELS_PATH = BASE_DIR.parent / "labels.txt"
MODEL_PATH = BASE_DIR.parent / "model.pt"
COGNITO_REGION = os.getenv("COGNITO_REGION", "").strip()
COGNITO_USER_POOL_ID = os.getenv("COGNITO_USER_POOL_ID", "").strip()
COGNITO_APP_CLIENT_ID = os.getenv("COGNITO_APP_CLIENT_ID", "").strip()
AUTH_REQUIRED = bool(COGNITO_REGION and COGNITO_USER_POOL_ID)
LOCAL_AUTH_RELAXED = os.getenv("LOCAL_AUTH_RELAXED", "").strip().lower() in {"1", "true", "yes"}
SNS_TOPIC_ARN = os.getenv("SNS_TOPIC_ARN", "").strip()
SNS_NOTIFICATIONS_ENABLED = os.getenv("SNS_NOTIFICATIONS_ENABLED", "true").strip().lower() not in {
    "0",
    "false",
    "no",
}

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Aussie EcoLens API (Step 1 Prototype)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory=str(UPLOADS_DIR)), name="media")
app.mount("/thumbnails", StaticFiles(directory=str(THUMBNAILS_DIR)), name="thumbnails")

logger = logging.getLogger("ecolens")
logging.basicConfig(level=logging.INFO)

JWKS_CACHE: dict[str, Any] = {"keys": [], "fetched_at": 0.0}


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def cognito_issuer() -> str:
    return f"https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}"


def cognito_jwks_url() -> str:
    return f"{cognito_issuer()}/.well-known/jwks.json"


def get_jwks_cached(ttl_seconds: int = 3600) -> list[dict[str, Any]]:
    now = time.time()
    if JWKS_CACHE["keys"] and now - float(JWKS_CACHE["fetched_at"]) < ttl_seconds:
        return JWKS_CACHE["keys"]
    with urlopen(cognito_jwks_url(), timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    keys = payload.get("keys", [])
    JWKS_CACHE["keys"] = keys
    JWKS_CACHE["fetched_at"] = now
    return keys


def parse_bearer_token(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    prefix = "Bearer "
    if not auth.startswith(prefix):
        raise HTTPException(status_code=401, detail="Missing Bearer token.")
    token = auth[len(prefix) :].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty Bearer token.")
    return token


def verify_cognito_token(token: str) -> dict[str, Any]:
    header = jwt.get_unverified_header(token)
    kid = header.get("kid")
    if not kid:
        raise HTTPException(status_code=401, detail="Invalid token header.")

    keys = get_jwks_cached()
    key = next((k for k in keys if k.get("kid") == kid), None)
    if not key:
        JWKS_CACHE["keys"] = []
        keys = get_jwks_cached(ttl_seconds=0)
        key = next((k for k in keys if k.get("kid") == kid), None)
    if not key:
        raise HTTPException(status_code=401, detail="Token key not found.")

    # Frontend sends Cognito id_token only; skip at_hash (needs access_token).
    options = {
        "verify_aud": bool(COGNITO_APP_CLIENT_ID),
        "verify_at_hash": False,
    }
    claims = jwt.decode(
        token,
        key,
        algorithms=["RS256"],
        audience=COGNITO_APP_CLIENT_ID or None,
        issuer=cognito_issuer(),
        options=options,
    )
    return claims


def _dev_user_claims() -> dict[str, Any]:
    return {"sub": "dev-user", "email": "dev-user@dev.local", "mode": "dev"}


def require_auth(request: Request) -> dict[str, Any]:
    auth = request.headers.get("Authorization", "")
    if AUTH_REQUIRED:
        token = parse_bearer_token(request)
        try:
            return verify_cognito_token(token)
        except HTTPException as exc:
            if LOCAL_AUTH_RELAXED:
                logger.warning("Cognito auth failed (%s); LOCAL_AUTH_RELAXED → dev-user", exc.detail)
                return _dev_user_claims()
            raise
        except JWTError as exc:
            if LOCAL_AUTH_RELAXED:
                logger.warning("Invalid Cognito token (%s); LOCAL_AUTH_RELAXED → dev-user", exc)
                return _dev_user_claims()
            raise HTTPException(status_code=401, detail=f"Invalid Cognito token: {exc}") from exc
    cognito_configured = bool(COGNITO_REGION and COGNITO_USER_POOL_ID)
    if cognito_configured and auth.startswith("Bearer "):
        token = auth[7:].strip()
        if token and token != "dev":
            try:
                return verify_cognito_token(token)
            except (JWTError, HTTPException, URLError, OSError, ValueError):
                logger.warning("Cognito token ignored in dev mode; using dev-user fallback")
    return _dev_user_claims()


def owner_email(claims: dict[str, Any]) -> str:
    raw = claims.get("email") or claims.get("cognito:username") or claims.get("sub") or ""
    return str(raw).strip().lower()


def assert_owner(claims: dict[str, Any], item: dict[str, Any]) -> None:
    current = owner_email(claims)
    item_owner = str(item.get("uploadedBy") or "").strip().lower()
    if not item_owner:
        if AUTH_REQUIRED and current:
            raise HTTPException(status_code=403, detail="This file has no owner recorded")
        return
    if AUTH_REQUIRED and (not current or current != item_owner):
        raise HTTPException(status_code=403, detail="You can only modify or delete your own uploads")


def init_db() -> None:
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS files (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              checksum TEXT UNIQUE NOT NULL,
              filename TEXT NOT NULL,
              media_type TEXT NOT NULL,
              file_url TEXT NOT NULL,
              thumbnail_url TEXT NOT NULL,
              tags_json TEXT NOT NULL,
              tag_counts_json TEXT NOT NULL,
              detection_source TEXT NOT NULL DEFAULT 'fallback:checksum',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        existing_cols = {
            r["name"] for r in conn.execute("PRAGMA table_info(files)").fetchall()
        }
        if "detection_source" not in existing_cols:
            conn.execute(
                "ALTER TABLE files ADD COLUMN detection_source TEXT NOT NULL DEFAULT 'fallback:checksum'"
            )
        if "uploaded_by" not in existing_cols:
            conn.execute("ALTER TABLE files ADD COLUMN uploaded_by TEXT NOT NULL DEFAULT ''")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tag_subscriptions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_sub TEXT NOT NULL,
              email TEXT NOT NULL,
              tag TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(user_sub, tag)
            )
            """
        )


def load_species_names() -> list[str]:
    if not LABELS_PATH.exists():
        return ["koala", "dingo", "wombat", "magpie"]
    names: list[str] = []
    for line in LABELS_PATH.read_text(encoding="utf-8").splitlines():
        parts = [p.strip() for p in line.split(";")]
        common_name = parts[-1] if parts else ""
        if common_name:
            names.append(common_name.lower())
    return names or ["koala", "dingo", "wombat", "magpie"]


def load_taxonomy_map() -> dict[str, str]:
    taxonomy: dict[str, str] = {}
    if not LABELS_PATH.exists():
        return taxonomy
    for line in LABELS_PATH.read_text(encoding="utf-8").splitlines():
        parts = [p.strip() for p in line.split(";")]
        if len(parts) < 7:
            continue
        genus = parts[4].lower()
        species = parts[5].lower()
        common_name = parts[6].lower().strip()
        if genus and species and common_name:
            taxonomy[f"{genus} {species}"] = common_name
    return taxonomy


SPECIES = load_species_names()
TAXONOMY_MAP = load_taxonomy_map()


def to_url(filename: str) -> str:
    return f"http://localhost:8001/media/{quote(filename)}"


def to_thumbnail_url(filename: str) -> str:
    return f"http://localhost:8001/thumbnails/{quote(filename)}"


def checksum_of(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def guess_media_type(upload: UploadFile) -> str:
    ct = upload.content_type or ""
    return "video" if "video" in ct else "image"


def generated_tags(checksum: str) -> tuple[list[str], dict[str, int]]:
    seed = int(checksum[:8], 16)
    count = (seed % 3) + 1
    tags: list[str] = []
    tag_counts: dict[str, int] = {}
    for i in range(count):
        idx = (seed + i * 17) % len(SPECIES)
        tag = SPECIES[idx]
        tags.append(tag)
        tag_counts[tag] = ((seed >> (i + 1)) % 3) + 1
    return tags, tag_counts


def detect_tags(file_path: Path, media_type: str, checksum: str) -> tuple[list[str], dict[str, int], str]:
    # Use real model for image/video files; fallback keeps upload robust during development.
    if MODEL_PATH.exists():
        try:
            if media_type == "image":
                return detect_image_tags(file_path, MODEL_PATH, TAXONOMY_MAP)
            if media_type == "video":
                return detect_video_tags(file_path, MODEL_PATH, TAXONOMY_MAP, sample_fps=1)
        except Exception as exc:
            logger.exception("Model inference failed for %s", file_path.name)
            tags, counts = generated_tags(checksum)
            reason = exc.__class__.__name__.lower()
            return tags, counts, f"fallback:model_error:{reason}"
    tags, counts = generated_tags(checksum)
    source = "fallback:checksum" if media_type == "image" else "fallback:video"
    return tags, counts, source


def create_thumbnail(src_path: Path, target_name: str, max_size: int = 320, quality: int = 82) -> str:
    thumb_name = f"{Path(target_name).stem}_thumb.jpg"
    out_path = THUMBNAILS_DIR / thumb_name
    with Image.open(src_path).convert("RGB") as img:
        img.thumbnail((max_size, max_size), RESAMPLE)
        img.save(out_path, format="JPEG", quality=quality, optimize=True)
    return thumb_name


def create_video_thumbnail(video_path: Path, target_name: str, max_size: int = 320, quality: int = 82) -> str:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Unable to open video for thumbnail: {video_path.name}")
    try:
        ok, frame = cap.read()
    finally:
        cap.release()
    if not ok:
        raise RuntimeError(f"Unable to read first frame: {video_path.name}")

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(rgb).convert("RGB")
    img.thumbnail((max_size, max_size), RESAMPLE)
    thumb_name = f"{Path(target_name).stem}_thumb.jpg"
    out_path = THUMBNAILS_DIR / thumb_name
    img.save(out_path, format="JPEG", quality=quality, optimize=True)
    return thumb_name


def parse_json(value: str) -> Any:
    return json.loads(value) if value else {}


def row_to_item(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    return {
        "checksum": row["checksum"],
        "filename": row["filename"],
        "mediaType": row["media_type"],
        "fileUrl": row["file_url"],
        "thumbnailUrl": row["thumbnail_url"],
        "tags": parse_json(row["tags_json"]),
        "tagCounts": parse_json(row["tag_counts_json"]),
        "detectionSource": row["detection_source"],
        "createdAt": row["created_at"],
        "uploadedBy": row["uploaded_by"] if "uploaded_by" in keys else "",
    }


def all_items() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM files ORDER BY id DESC").fetchall()
    return [row_to_item(r) for r in rows]


def user_sub_from_claims(claims: dict[str, Any]) -> str:
    return str(claims.get("sub") or claims.get("username") or "dev-user")


def user_email_from_claims(claims: dict[str, Any], override: str = "") -> str:
    override = override.strip()
    if override:
        return override.lower()
    for key in ("email", "preferred_username"):
        value = str(claims.get(key, "")).strip()
        if value and "@" in value:
            return value.lower()
    return f"{user_sub_from_claims(claims)}@dev.local"


def normalize_tags(tags: list[Any]) -> list[str]:
    return sorted({str(t).strip().lower() for t in tags if str(t).strip()})


def tag_fuzzy_match(a: str, b: str) -> bool:
    """True when either tag contains the other (e.g. dingo ↔ canis dingo)."""
    left, right = a.lower().strip(), b.lower().strip()
    if not left or not right:
        return False
    return left in right or right in left


def subscription_tag_matches_file_tags(sub_tag: str, file_tags: set[str]) -> bool:
    return any(tag_fuzzy_match(sub_tag, file_tag) for file_tag in file_tags)


def list_user_subscriptions(user_sub: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT tag, email, created_at
            FROM tag_subscriptions
            WHERE user_sub = ?
            ORDER BY tag ASC
            """,
            (user_sub,),
        ).fetchall()
    return [
        {"tag": row["tag"], "email": row["email"], "createdAt": row["created_at"]}
        for row in rows
    ]


def build_subscribe_message(email: str, tag: str) -> tuple[str, str]:
    subject = f"EcoLens: subscribed to tag '{tag}'"
    body = (
        f"Your EcoLens tag subscription is active.\n\n"
        f"Tag: {tag}\n"
        f"Notification email: {email}\n\n"
        f"You will receive alerts when new media matches this tag.\n"
        f"First-time only: confirm the AWS SNS email once for this inbox; "
        f"adding more tags later does not require another confirm.\n"
    )
    return subject, body


def build_unsubscribe_message(email: str, tag: str) -> tuple[str, str]:
    subject = f"EcoLens: unsubscribed from tag '{tag}'"
    body = (
        f"Your EcoLens tag subscription has been removed.\n\n"
        f"Tag: {tag}\n"
        f"Notification email: {email}\n\n"
        f"You will no longer receive alerts for new media matching this tag.\n"
    )
    return subject, body


def notify_subscribe_confirmation(email: str, tags: list[str]) -> int:
    sent = 0
    for tag in normalize_tags(tags):
        subject, body = build_subscribe_message(email, tag)
        publish_sns_notification(email, subject, body, {tag})
        sent += 1
    return sent


def notify_unsubscribe_confirmation(email: str, tags: list[str]) -> int:
    sent = 0
    for tag in normalize_tags(tags):
        subject, body = build_unsubscribe_message(email, tag)
        publish_sns_notification(email, subject, body, {tag})
        sent += 1
    return sent


def subscribe_tags(user_sub: str, email: str, tags: list[str]) -> tuple[list[str], int]:
    subscribed: list[str] = []
    normalized_email = email.lower().strip()
    with db() as conn:
        for tag in normalize_tags(tags):
            conn.execute(
                """
                INSERT INTO tag_subscriptions (user_sub, email, tag)
                VALUES (?, ?, ?)
                ON CONFLICT(user_sub, tag) DO UPDATE SET email = excluded.email
                """,
                (user_sub, normalized_email, tag),
            )
            subscribed.append(tag)
    if subscribed:
        sync_sns_email_filter_for_email(normalized_email)
    notifications_sent = notify_subscribe_confirmation(normalized_email, subscribed) if subscribed else 0
    return subscribed, notifications_sent


def unsubscribe_tags(user_sub: str, tags: list[str]) -> tuple[list[str], int]:
    unsubscribed: list[str] = []
    notifications_sent = 0
    emails_to_sync: set[str] = set()
    with db() as conn:
        for tag in normalize_tags(tags):
            row = conn.execute(
                "SELECT email FROM tag_subscriptions WHERE user_sub = ? AND tag = ?",
                (user_sub, tag),
            ).fetchone()
            if not row:
                continue
            email = str(row["email"]).lower()
            cur = conn.execute(
                "DELETE FROM tag_subscriptions WHERE user_sub = ? AND tag = ?",
                (user_sub, tag),
            )
            if cur.rowcount:
                unsubscribed.append(tag)
                notifications_sent += notify_unsubscribe_confirmation(email, [tag])
                emails_to_sync.add(email)
    for email in emails_to_sync:
        sync_sns_email_filter_for_email(email)
    return unsubscribed, notifications_sent


def matching_subscriptions(file_tags: list[str]) -> dict[str, set[str]]:
    normalized = set(normalize_tags(file_tags))
    if not normalized:
        return {}
    with db() as conn:
        rows = conn.execute("SELECT email, tag FROM tag_subscriptions").fetchall()
    recipients: dict[str, set[str]] = {}
    for row in rows:
        sub_tag = str(row["tag"]).lower()
        if not subscription_tag_matches_file_tags(sub_tag, normalized):
            continue
        recipients.setdefault(row["email"], set()).add(sub_tag)
    return recipients


def build_notification_message(item: dict[str, Any], matched_tags: set[str]) -> tuple[str, str]:
    subject = "EcoLens: new media matches your tag subscription"
    body = (
        f"A new {item.get('mediaType', 'file')} was added to Aussie EcoLens.\n\n"
        f"Matched tags: {', '.join(sorted(matched_tags))}\n"
        f"All detected tags: {', '.join(item.get('tags', []))}\n"
        f"File URL: {item.get('fileUrl', '')}\n"
        f"Thumbnail: {item.get('thumbnailUrl', '') or 'n/a'}\n"
        f"Detection source: {item.get('detectionSource', 'unknown')}\n"
    )
    return subject, body


def tags_for_email(email: str) -> list[str]:
    normalized_email = email.lower().strip()
    with db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT tag FROM tag_subscriptions WHERE lower(email) = ?",
            (normalized_email,),
        ).fetchall()
    return sorted(str(row["tag"]).lower() for row in rows if row["tag"])


def build_sns_filter_policy(email: str, tags: list[str]) -> str:
    return json.dumps({"tag": tags, "email": [email.lower().strip()]})


def _confirmed_email_subscription_arns(email: str) -> list[str]:
    if not SNS_TOPIC_ARN:
        return []
    import boto3

    normalized_email = email.lower().strip()
    sns = boto3.client("sns")
    arns: list[str] = []
    paginator = sns.get_paginator("list_subscriptions_by_topic")
    for page in paginator.paginate(TopicArn=SNS_TOPIC_ARN):
        for sub in page.get("Subscriptions", []):
            if sub.get("Protocol") != "email":
                continue
            if str(sub.get("Endpoint", "")).lower() != normalized_email:
                continue
            arn = str(sub.get("SubscriptionArn", ""))
            if arn and not arn.endswith("PendingConfirmation"):
                arns.append(arn)
    return arns


def clear_sns_email_subscriptions(email: str) -> None:
    if not SNS_TOPIC_ARN:
        return
    normalized_email = email.lower().strip()
    if not normalized_email:
        return
    try:
        import boto3

        sns = boto3.client("sns")
        for sub_arn in _confirmed_email_subscription_arns(normalized_email):
            sns.unsubscribe(SubscriptionArn=sub_arn)
            logger.info("Removed SNS subscription %s for %s", sub_arn, normalized_email)
    except Exception:
        logger.exception("SNS unsubscribe failed for %s", normalized_email)


def sync_sns_email_filter_for_email(email: str) -> None:
    if not SNS_TOPIC_ARN or not SNS_NOTIFICATIONS_ENABLED:
        return
    normalized_email = email.lower().strip()
    if not normalized_email:
        return

    tags = tags_for_email(normalized_email)
    if not tags:
        logger.info("No tags left for %s; clearing SNS subscriptions", normalized_email)
        clear_sns_email_subscriptions(normalized_email)
        return

    filter_policy = build_sns_filter_policy(normalized_email, tags)
    try:
        import boto3

        sns = boto3.client("sns")
        sub_arns = _confirmed_email_subscription_arns(normalized_email)
        if sub_arns:
            for sub_arn in sub_arns:
                sns.set_subscription_attributes(
                    SubscriptionArn=sub_arn,
                    AttributeName="FilterPolicy",
                    AttributeValue=filter_policy,
                )
            logger.info("Updated SNS filter for %s tags=%s", normalized_email, tags)
            return

        sns.subscribe(
            TopicArn=SNS_TOPIC_ARN,
            Protocol="email",
            Endpoint=normalized_email,
            Attributes={"FilterPolicy": filter_policy},
        )
        logger.info("SNS email subscription requested for %s tags=%s", normalized_email, tags)
    except Exception:
        logger.exception("SNS filter sync failed for %s", normalized_email)


def publish_sns_notification(email: str, subject: str, body: str, matched_tags: set[str]) -> str:
    if not SNS_NOTIFICATIONS_ENABLED:
        logger.info("[notifications disabled] Would notify %s: %s", email, subject)
        return "disabled"

    if SNS_TOPIC_ARN:
        try:
            import boto3

            sns = boto3.client("sns")
            for tag in sorted(matched_tags):
                response = sns.publish(
                    TopicArn=SNS_TOPIC_ARN,
                    Subject=subject[:100],
                    Message=body,
                    MessageAttributes={
                        "tag": {"DataType": "String", "StringValue": tag},
                        "email": {"DataType": "String", "StringValue": email.lower().strip()},
                    },
                )
                logger.info(
                    "SNS publish tag=%s email=%s MessageId=%s",
                    tag,
                    email,
                    response.get("MessageId"),
                )
            return "sns"
        except Exception:
            logger.exception("SNS publish failed for %s; falling back to log simulation", email)

    logger.info(
        "[notification simulated] email=%s subject=%s body=%s",
        email,
        subject,
        body.replace("\n", " | "),
    )
    return "simulated"


def notify_for_tags_on_item(item: dict[str, Any], trigger_tags: list[str]) -> int:
    recipients = matching_subscriptions(trigger_tags)
    if not recipients:
        return 0

    sent = 0
    for email, matched_tags in recipients.items():
        subject, body = build_notification_message(item, matched_tags)
        publish_sns_notification(email, subject, body, matched_tags)
        sent += 1
    return sent


def notify_for_media_item(item: dict[str, Any]) -> int:
    return notify_for_tags_on_item(item, item.get("tags", []))


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/auth/config")
def auth_config() -> dict[str, Any]:
    return {
        "authRequired": AUTH_REQUIRED,
        "cognitoRegion": COGNITO_REGION,
        "userPoolId": COGNITO_USER_POOL_ID,
        "appClientIdConfigured": bool(COGNITO_APP_CLIENT_ID),
        "snsConfigured": bool(SNS_TOPIC_ARN),
        "notificationsEnabled": SNS_NOTIFICATIONS_ENABLED,
    }


@app.get("/auth/me")
def auth_me(claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    return {"authenticated": True, "claims": claims}


@app.get("/files")
def list_files(
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: str | None = Query(None),
    claims: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    current = owner_email(claims)
    target = ""
    if user:
        if user.lower() in ("me", "current", "current_user_email"):
            target = current
        else:
            target = user.strip().lower()
        if AUTH_REQUIRED and current and target != current:
            raise HTTPException(status_code=403, detail="Cannot list another user's files")
        if not target:
            raise HTTPException(status_code=401, detail="Sign in required for My Uploads")

    with db() as conn:
        if target:
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM files WHERE lower(uploaded_by) = ?",
                (target,),
            ).fetchone()["c"]
            rows = conn.execute(
                "SELECT * FROM files WHERE lower(uploaded_by) = ? ORDER BY id DESC LIMIT ? OFFSET ?",
                (target, limit, offset),
            ).fetchall()
        else:
            total = conn.execute("SELECT COUNT(*) AS c FROM files").fetchone()["c"]
            rows = conn.execute(
                "SELECT * FROM files ORDER BY id DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
    return {
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "items": [row_to_item(r) for r in rows],
    }


@app.post("/upload")
async def upload(file: UploadFile = File(...), claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file.")

    digest = checksum_of(content)
    with db() as conn:
        existing = conn.execute(
            "SELECT * FROM files WHERE checksum = ?", (digest,)
        ).fetchone()
        if existing:
            existing_item = row_to_item(existing)
            needs_thumbnail_upgrade = (
                existing_item["mediaType"] in {"image", "video"}
                and (
                    not existing_item["thumbnailUrl"]
                    or "/media/" in existing_item["thumbnailUrl"]
                )
            )
            needs_detection_upgrade = (
                existing_item["mediaType"] == "image"
                and str(existing_item.get("detectionSource", "")).startswith("fallback")
                and MODEL_PATH.exists()
            )

            if needs_thumbnail_upgrade or needs_detection_upgrade:
                existing_path = UPLOADS_DIR / existing_item["filename"]
                if existing_path.exists():
                    tags = existing_item["tags"]
                    tag_counts = existing_item["tagCounts"]
                    detection_source = existing_item.get("detectionSource", "fallback:checksum")
                    thumbnail_url = existing_item["thumbnailUrl"]

                    if needs_detection_upgrade:
                        tags, tag_counts, detection_source = detect_tags(
                            existing_path, "image", digest
                        )
                    if needs_thumbnail_upgrade:
                        if existing_item["mediaType"] == "image":
                            thumb_name = create_thumbnail(existing_path, existing_item["filename"])
                            thumbnail_url = to_thumbnail_url(thumb_name)
                        elif existing_item["mediaType"] == "video":
                            thumb_name = create_video_thumbnail(existing_path, existing_item["filename"])
                            thumbnail_url = to_thumbnail_url(thumb_name)

                    conn.execute(
                        """
                        UPDATE files
                        SET tags_json = ?, tag_counts_json = ?, detection_source = ?, thumbnail_url = ?
                        WHERE id = ?
                        """,
                        (
                            json.dumps(tags),
                            json.dumps(tag_counts),
                            detection_source,
                            thumbnail_url,
                            existing["id"],
                        ),
                    )
                    existing = conn.execute(
                        "SELECT * FROM files WHERE id = ?", (existing["id"],)
                    ).fetchone()
            return {"deduplicated": True, "item": row_to_item(existing)}

        safe_name = f"{digest[:12]}_{(file.filename or 'upload.bin').replace(' ', '_')}"
        file_path = UPLOADS_DIR / safe_name
        file_path.write_bytes(content)

        media_type = guess_media_type(file)
        tags, tag_counts, detection_source = detect_tags(file_path, media_type, digest)
        file_url = to_url(safe_name)
        thumbnail_url = ""
        if media_type == "image":
            thumb_name = create_thumbnail(file_path, safe_name)
            thumbnail_url = to_thumbnail_url(thumb_name)
        elif media_type == "video":
            try:
                thumb_name = create_video_thumbnail(file_path, safe_name)
                thumbnail_url = to_thumbnail_url(thumb_name)
            except Exception:
                logger.exception("Video thumbnail generation failed for %s", safe_name)

        uploader = owner_email(claims)
        conn.execute(
            """
            INSERT INTO files
              (checksum, filename, media_type, file_url, thumbnail_url, tags_json, tag_counts_json, detection_source, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                digest,
                safe_name,
                media_type,
                file_url,
                thumbnail_url,
                json.dumps(tags),
                json.dumps(tag_counts),
                detection_source,
                uploader,
            ),
        )
        item_row = conn.execute(
            "SELECT * FROM files WHERE checksum = ?", (digest,)
        ).fetchone()
    item = row_to_item(item_row)
    notifications_sent = notify_for_media_item(item)
    return {"deduplicated": False, "item": item, "notificationsSent": notifications_sent}


@app.post("/query/species")
def query_species(payload: dict[str, Any], claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    species = str(payload.get("species", "")).strip().lower()
    if not species:
        raise HTTPException(status_code=400, detail="species is required")
    results = [
        it for it in all_items() if any(tag_fuzzy_match(species, str(t)) for t in it["tags"])
    ]
    return {"count": len(results), "items": results}


@app.post("/query/tags-count")
def query_tags_count(payload: dict[str, Any], claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    requested: dict[str, int] = {str(k).lower(): int(v) for k, v in payload.items()}
    results: list[dict[str, Any]] = []
    for item in all_items():
        counts = {k.lower(): int(v) for k, v in item["tagCounts"].items()}
        if all(
            any(tag_fuzzy_match(tag, tag_key) and count >= min_count for tag_key, count in counts.items())
            for tag, min_count in requested.items()
        ):
            results.append(item)
    return {"count": len(results), "items": results}


@app.post("/query/thumbnail")
def query_thumbnail(payload: dict[str, Any], claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    thumbnail = str(payload.get("thumbnailUrl", "")).strip()
    if not thumbnail:
        raise HTTPException(status_code=400, detail="thumbnailUrl is required")
    for item in all_items():
        if item["thumbnailUrl"] == thumbnail:
            return {"fileUrl": item["fileUrl"], "item": item}
    raise HTTPException(status_code=404, detail="Thumbnail not found")


@app.post("/query/by-file")
async def query_by_file(file: UploadFile = File(...), claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file.")
    digest = checksum_of(content)
    tmp_path = UPLOADS_DIR / f"_query_{digest[:12]}_{(file.filename or 'query.bin').replace(' ', '_')}"
    tmp_path.write_bytes(content)
    try:
        media_type = guess_media_type(file)
        tags, _, _ = detect_tags(tmp_path, media_type, digest)
    finally:
        tmp_path.unlink(missing_ok=True)
    required = {t.lower() for t in tags}
    results = []
    for item in all_items():
        item_tags = {str(t).lower() for t in item["tags"]}
        if any(tag_fuzzy_match(query_tag, item_tag) for query_tag in required for item_tag in item_tags):
            results.append(item)
    return {"queryTags": tags, "count": len(results), "items": results}


@app.get("/notifications/subscriptions")
def list_subscriptions(claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    user_sub = user_sub_from_claims(claims)
    email = user_email_from_claims(claims)
    sync_sns_email_filter_for_email(email)
    subs = list_user_subscriptions(user_sub)
    return {
        "userSub": user_sub,
        "email": email,
        "subscriptions": subs,
        "snsConfigured": bool(SNS_TOPIC_ARN),
        "notificationsEnabled": SNS_NOTIFICATIONS_ENABLED,
    }


@app.post("/notifications/subscribe")
def subscribe_notification(payload: dict[str, Any], claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    tags = payload.get("tags") or []
    if not tags:
        raise HTTPException(status_code=400, detail="tags is required")
    user_sub = user_sub_from_claims(claims)
    email = user_email_from_claims(claims, str(payload.get("email", "")))
    subscribed, notifications_sent = subscribe_tags(user_sub, email, tags)
    return {
        "subscribed": subscribed,
        "email": email,
        "snsConfigured": bool(SNS_TOPIC_ARN),
        "notificationsSent": notifications_sent,
    }


@app.post("/notifications/unsubscribe")
def unsubscribe_notification(payload: dict[str, Any], claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    tags = payload.get("tags") or []
    if not tags:
        raise HTTPException(status_code=400, detail="tags is required")
    user_sub = user_sub_from_claims(claims)
    unsubscribed, notifications_sent = unsubscribe_tags(user_sub, tags)
    return {"unsubscribed": unsubscribed, "notificationsSent": notifications_sent}


@app.post("/tags/bulk")
def tags_bulk(payload: dict[str, Any], claims: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    urls = payload.get("urls", [])
    tags = [str(t).lower() for t in payload.get("tags", [])]
    operation = int(payload.get("operation", 1))
    updated = 0
    notifications_sent = 0

    with db() as conn:
        for url in urls:
            row = conn.execute("SELECT * FROM files WHERE file_url = ?", (url,)).fetchone()
            if not row:
                continue
            assert_owner(claims, row_to_item(row))
            item_tags = set(parse_json(row["tags_json"]))
            counts = parse_json(row["tag_counts_json"])
            if operation == 1:
                for tag in tags:
                    item_tags.add(tag)
                    counts[tag] = max(1, int(counts.get(tag, 1)))
            else:
                for tag in tags:
                    item_tags.discard(tag)
                    counts.pop(tag, None)
            conn.execute(
                "UPDATE files SET tags_json = ?, tag_counts_json = ? WHERE id = ?",
                (json.dumps(sorted(item_tags)), json.dumps(counts), row["id"]),
            )
            updated += 1
            if operation == 1:
                updated_row = conn.execute("SELECT * FROM files WHERE id = ?", (row["id"],)).fetchone()
                notifications_sent += notify_for_tags_on_item(row_to_item(updated_row), tags)
    return {"updated": updated, "notificationsSent": notifications_sent}


@app.post("/files/delete")
def delete_files(payload: dict[str, Any], claims: dict[str, Any] = Depends(require_auth)) -> dict[str, int]:
    urls = payload.get("urls", [])
    deleted = 0
    with db() as conn:
        for url in urls:
            row = conn.execute("SELECT * FROM files WHERE file_url = ?", (url,)).fetchone()
            if not row:
                continue
            assert_owner(claims, row_to_item(row))
            try:
                (UPLOADS_DIR / row["filename"]).unlink(missing_ok=True)
            except OSError:
                pass
            try:
                thumb_url = row["thumbnail_url"] or ""
                if "/thumbnails/" in thumb_url:
                    thumb_name = thumb_url.rsplit("/", 1)[-1]
                    (THUMBNAILS_DIR / thumb_name).unlink(missing_ok=True)
            except OSError:
                pass
            conn.execute("DELETE FROM files WHERE id = ?", (row["id"],))
            deleted += 1
    return {"deleted": deleted}
