# FIT5225 Assignment 2 - Aussie EcoLens

Aussie EcoLens is a multi-cloud serverless wildlife media platform. It allows authenticated users to upload wildlife images/videos, automatically detect species using a machine learning model, store metadata in a database, and query media files by tags/species.

## Architecture

Main services:

- AWS Cognito: authentication and authorisation
- AWS API Gateway: REST API entry point
- AWS Lambda: upload, processing, query, tag editing, deletion
- AWS S3: original files and thumbnails
- AWS DynamoDB: media metadata, tags, checksums
- AWS SNS: tag-based email notifications
- GCP Cloud Run: ML inference service
- GCP Cloud Storage: ML model storage

## Repository Structure

```text
frontend/             Web UI
aws-backend/          AWS Lambda functions and API logic
gcp-ml-service/       GCP Cloud Run ML inference service
infrastructure/       AWS/GCP setup scripts
docs/                 Architecture, API design, user guide, demo script
test/                 Testing files and Postman collections
report/               Team report and individual report notes