# Build and push to ECR, then create Lambda from container image.
# Lambda requires a single-platform Docker v2 manifest (not OCI image index / attestations).
#   aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
#   docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
#     -t <account>.dkr.ecr.us-east-1.amazonaws.com/ecolens-process-upload:latest --push .
# In Lambda console, set Architecture to x86_64 to match linux/amd64.

FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py inference.py sns_notifications.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.handler"]
