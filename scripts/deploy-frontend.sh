#!/bin/bash
# Deploy frontend to S3 + invalidate CloudFront cache
# Usage: ./scripts/deploy-frontend.sh hardik|navin

ENV=$1

if [ -z "$ENV" ]; then
  echo "Usage: ./scripts/deploy-frontend.sh hardik|navin"
  exit 1
fi

PROFILE="autoreach-$ENV"
REGION="ap-south-1"
STACK_NAME="autoreach-frontend-$ENV"

echo "🔨 Building frontend..."
cd frontend && npx next build && cd ..

echo "📦 Getting S3 bucket and CloudFront ID..."
BUCKET=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --profile $PROFILE --region $REGION --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" --output text)
DIST_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --profile $PROFILE --region $REGION --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)

echo "🚀 Uploading to S3: $BUCKET"
aws s3 sync frontend/out/ s3://$BUCKET/ --delete --profile $PROFILE --region $REGION

echo "🔄 Invalidating CloudFront cache: $DIST_ID"
aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*" --profile $PROFILE --region $REGION

echo "✅ Done! Frontend deployed for $ENV"
