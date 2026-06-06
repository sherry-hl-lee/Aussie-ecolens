"""SNS tag notification helpers for EcoLens API / process_upload Lambdas."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "").strip()
SNS_NOTIFICATIONS_ENABLED = os.environ.get("SNS_NOTIFICATIONS_ENABLED", "true").strip().lower() not in {
    "0",
    "false",
    "no",
}
SUBSCRIPTIONS_TABLE_NAME = os.environ.get("SUBSCRIPTIONS_TABLE", "ecolens-subscriptions").strip()

_sns_client = None
_subscriptions_table = None


def sns_client():
    global _sns_client
    if _sns_client is None:
        _sns_client = boto3.client("sns")
    return _sns_client


def subscriptions_table():
    global _subscriptions_table
    if _subscriptions_table is None and SUBSCRIPTIONS_TABLE_NAME:
        _subscriptions_table = boto3.resource("dynamodb").Table(SUBSCRIPTIONS_TABLE_NAME)
    return _subscriptions_table


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


def register_sns_email_filter(email: str, tag: str) -> None:
    if not SNS_TOPIC_ARN or not SNS_NOTIFICATIONS_ENABLED:
        return
    try:
        sns_client().subscribe(
            TopicArn=SNS_TOPIC_ARN,
            Protocol="email",
            Endpoint=email,
            Attributes={"FilterPolicy": json.dumps({"tag": [tag]})},
        )
        logger.info("SNS email subscription requested for %s tag=%s", email, tag)
    except ClientError:
        logger.exception("SNS subscribe failed for %s tag=%s", email, tag)


def list_user_subscriptions(user_sub: str) -> list[dict[str, Any]]:
    table = subscriptions_table()
    if not table:
        return []
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {
        "KeyConditionExpression": "userSub = :userSub",
        "ExpressionAttributeValues": {":userSub": user_sub},
    }
    while True:
        resp = table.query(**kwargs)
        for row in resp.get("Items", []):
            items.append(
                {
                    "tag": str(row.get("tag", "")),
                    "email": str(row.get("email", "")),
                    "createdAt": str(row.get("createdAt", "")),
                }
            )
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    items.sort(key=lambda row: row["tag"])
    return items


def build_subscribe_message(email: str, tag: str) -> tuple[str, str]:
    subject = f"EcoLens: subscribed to tag '{tag}'"
    body = (
        f"Your EcoLens tag subscription is active.\n\n"
        f"Tag: {tag}\n"
        f"Notification email: {email}\n\n"
        f"You will receive alerts when new media matches this tag.\n"
        f"If this is your first time, also confirm the separate AWS SNS email when it arrives.\n"
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
    table = subscriptions_table()
    if not table:
        raise RuntimeError("SUBSCRIPTIONS_TABLE is not configured")

    from datetime import datetime, timezone

    subscribed: list[str] = []
    now = datetime.now(timezone.utc).isoformat()
    for tag in normalize_tags(tags):
        table.put_item(
            Item={
                "userSub": user_sub,
                "tag": tag,
                "email": email,
                "createdAt": now,
            }
        )
        subscribed.append(tag)
        register_sns_email_filter(email, tag)
    notifications_sent = notify_subscribe_confirmation(email, subscribed) if subscribed else 0
    return subscribed, notifications_sent


def unsubscribe_tags(user_sub: str, tags: list[str]) -> tuple[list[str], int]:
    table = subscriptions_table()
    if not table:
        raise RuntimeError("SUBSCRIPTIONS_TABLE is not configured")

    unsubscribed: list[str] = []
    notifications_sent = 0
    for tag in normalize_tags(tags):
        try:
            resp = table.get_item(Key={"userSub": user_sub, "tag": tag})
            item = resp.get("Item")
            if not item:
                continue
            email = str(item.get("email", "")).lower()
            table.delete_item(Key={"userSub": user_sub, "tag": tag})
            unsubscribed.append(tag)
            if email:
                notifications_sent += notify_unsubscribe_confirmation(email, [tag])
        except ClientError:
            logger.exception("Failed to unsubscribe userSub=%s tag=%s", user_sub, tag)
    return unsubscribed, notifications_sent


def matching_subscriptions(file_tags: list[str]) -> dict[str, set[str]]:
    table = subscriptions_table()
    if not table:
        return {}

    normalized = set(normalize_tags(file_tags))
    if not normalized:
        return {}

    recipients: dict[str, set[str]] = {}
    kwargs: dict[str, Any] = {}
    while True:
        resp = table.scan(**kwargs)
        for row in resp.get("Items", []):
            tag = str(row.get("tag", "")).lower()
            if not subscription_tag_matches_file_tags(tag, normalized):
                continue
            email = str(row.get("email", "")).lower()
            if email:
                recipients.setdefault(email, set()).add(tag)
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
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


def publish_sns_notification(email: str, subject: str, body: str, matched_tags: set[str]) -> str:
    if not SNS_NOTIFICATIONS_ENABLED:
        logger.info("[notifications disabled] Would notify %s: %s", email, subject)
        return "disabled"

    if SNS_TOPIC_ARN:
        try:
            for tag in sorted(matched_tags):
                response = sns_client().publish(
                    TopicArn=SNS_TOPIC_ARN,
                    Subject=subject[:100],
                    Message=body,
                    MessageAttributes={
                        "tag": {"DataType": "String", "StringValue": tag},
                        "email": {"DataType": "String", "StringValue": email},
                    },
                )
                logger.info(
                    "SNS publish tag=%s email=%s MessageId=%s",
                    tag,
                    email,
                    response.get("MessageId"),
                )
            return "sns"
        except ClientError:
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
