from __future__ import annotations

import json
import os
import time
from typing import Any
from urllib.request import urlopen

from fastapi import HTTPException, Request
from jose import JWTError, jwt

COGNITO_REGION = os.getenv("COGNITO_REGION", "").strip()
COGNITO_USER_POOL_ID = os.getenv("COGNITO_USER_POOL_ID", "").strip()
COGNITO_APP_CLIENT_ID = os.getenv("COGNITO_APP_CLIENT_ID", "").strip()
AUTH_REQUIRED = bool(COGNITO_REGION and COGNITO_USER_POOL_ID)

JWKS_CACHE: dict[str, Any] = {"keys": [], "fetched_at": 0.0}


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

    options = {"verify_aud": bool(COGNITO_APP_CLIENT_ID)}
    claims = jwt.decode(
        token,
        key,
        algorithms=["RS256"],
        audience=COGNITO_APP_CLIENT_ID or None,
        issuer=cognito_issuer(),
        options=options,
    )
    return claims


def require_auth(request: Request) -> dict[str, Any]:
    token = parse_bearer_token(request)
    if AUTH_REQUIRED:
        try:
            return verify_cognito_token(token)
        except JWTError as exc:
            raise HTTPException(status_code=401, detail=f"Invalid Cognito token: {exc}") from exc
    return {"sub": "dev-user", "mode": "dev"}
