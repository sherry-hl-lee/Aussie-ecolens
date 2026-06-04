# API Contract (aligned with local `backend/app.py`)

Base URL (local dev): `http://localhost:8001`  
Base URL (AWS): `https://<api-id>.execute-api.<region>.amazonaws.com/<stage>`

All endpoints below require:

```http
Authorization: Bearer <Cognito JWT>
```

Exception: `GET /health`, `GET /auth/config` (optional public).

---

## Auth

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/auth/config` | — | `{ authRequired, cognitoRegion, userPoolId, appClientIdConfigured }` |
| GET | `/auth/me` | — | `{ authenticated, claims }` |

---

## Files

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/files?limit=20&offset=0` | — | `{ total, limit, offset, items[] }` |
| POST | `/upload` | `multipart/form-data` file **or** (AWS) presigned flow | See below |

### Upload (local prototype)

`POST /upload` with `file` field.

Response:

```json
{
  "deduplicated": false,
  "item": {
    "checksum": "sha256...",
    "filename": "abc_photo.jpg",
    "mediaType": "image",
    "fileUrl": "http://.../media/...",
    "thumbnailUrl": "http://.../thumbnails/..._thumb.jpg",
    "tags": ["cattle", "dingo"],
    "tagCounts": { "cattle": 3, "dingo": 1 },
    "detectionSource": "model:image",
    "createdAt": "2026-06-02 08:23:15"
  }
}
```

### Upload (AWS target — Member A)

**Step 1:** `POST /upload` with JSON:

```json
{ "filename": "photo.jpg", "contentType": "image/jpeg" }
```

**Step 2:** Response:

```json
{
  "uploadUrl": "https://s3...",
  "objectKey": "media/<checksum>_photo.jpg",
  "headers": { "Content-Type": "image/jpeg" }
}
```

**Step 3:** Client `PUT` file to `uploadUrl`. S3 event triggers processing Lambda.  
**Step 4:** Poll `GET /files` or `GET /files?checksum=...` until `item` appears.

---

## Queries

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/query/species` | `{ "species": "dingo" }` | `{ count, items[] }` |
| POST | `/query/tags-count` | `{ "koala": 2, "magpie": 1 }` | `{ count, items[] }` (AND) |
| POST | `/query/thumbnail` | `{ "thumbnailUrl": "https://..." }` | `{ fileUrl, item }` |
| POST | `/query/by-file` | `multipart` file (not stored) | `{ queryTags, count, items[] }` |

---

## Tag & delete

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/tags/bulk` | `{ "urls": ["..."], "tags": ["koala"], "operation": 1 }` | `{ updated }` (`1` add, `0` remove) |
| POST | `/files/delete` | `{ "urls": ["..."] }` | `{ deleted }` |

---

## Item shape (`items[]`)

```json
{
  "checksum": "string",
  "filename": "string",
  "mediaType": "image | video",
  "fileUrl": "string",
  "thumbnailUrl": "string",
  "tags": ["string"],
  "tagCounts": { "tag": 0 },
  "detectionSource": "model:image | model:video:1fps | fallback:*",
  "createdAt": "string"
}
```

Frontend (`prototype.html` / React) should keep using these field names.
