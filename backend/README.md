# Aussie EcoLens Backend (Step 1)

This backend is a local prototype to quickly unblock frontend integration.

Implemented in this step:
- Upload endpoint with checksum deduplication
- Image tagging with the provided `model.pt` (fallback available)
- Video tagging with 1fps frame sampling and tag aggregation
- Thumbnail generation for uploaded images
- Thumbnail generation for uploaded videos (first frame)
- SQLite metadata storage
- Query endpoints used by the UI
- Bulk tag update and file deletion
- JWT-protected APIs with Cognito verification support

## Run

```bash
cd backend
python3 -m pip install -r requirements.txt
python3 -m uvicorn app:app --host 0.0.0.0 --port 8001 --reload
```

Health check: `http://localhost:8001/health`

## Frontend config

In `frontend/index.html` UI, set:

`API Base URL` = `http://localhost:8001`

## Authentication mode

Set environment variables before startup to enforce Cognito token verification:

```bash
export COGNITO_REGION="ap-southeast-2"
export COGNITO_USER_POOL_ID="ap-southeast-2_xxxxx"
export COGNITO_APP_CLIENT_ID="xxxxxxxxxxxx"
```

- When these are set, all core API endpoints require a valid Cognito Bearer token.
- Without them, APIs still require a Bearer token but run in development-token mode.

## Notes

- This is a prototype backend for the first integration step.
- Images use the provided model for tag prediction.
- Videos are sampled at 1 frame per second and aggregated into `tags/tagCounts`.
- Images generate compressed thumbnails under `/thumbnails/...`.
- Videos generate a thumbnail from the first frame under `/thumbnails/...`.
- If model inference fails, the system automatically falls back to checksum-based tags.
