#!/bin/bash
# Deploy frontend to S3 + invalidate CloudFront cache
# Usage: ./scripts/deploy-frontend.sh hardik|navin|both

ENV=$1

if [ -z "$ENV" ]; then
  echo "Usage: ./scripts/deploy-frontend.sh hardik|navin|both"
  exit 1
fi

deploy_to() {
  local TARGET=$1
  local API_URL BUCKET DIST_ID PROFILE

  if [ "$TARGET" = "hardik" ]; then
    API_URL="https://xb4sthj0lb.execute-api.ap-south-1.amazonaws.com/Prod"
    BUCKET="autoreach-frontend-hardik-760019269058"
    DIST_ID="E28UVIGW7THBHI"
    PROFILE="hardik"
  elif [ "$TARGET" = "navin" ]; then
    API_URL="https://ovp3rbikb2.execute-api.ap-south-1.amazonaws.com/Prod"
    BUCKET="autoreach-frontend-navin-632320832903"
    DIST_ID="E2IT11P85YPHVG"
    PROFILE="navin"
  else
    echo "Unknown target: $TARGET"
    return 1
  fi

  echo ""
  echo "=== Deploying to $TARGET ==="
  echo "📝 Setting API URL: $API_URL"
  echo "NEXT_PUBLIC_API_URL=$API_URL" > frontend/.env.local

  echo "🔨 Building frontend..."
  cd frontend && npx next build && cd ..

  echo "🚀 Uploading to S3: $BUCKET"
  aws s3 sync frontend/out/ s3://$BUCKET/ --delete --profile $PROFILE --region ap-south-1

  echo "🔄 Invalidating CloudFront: $DIST_ID"
  aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*" --profile $PROFILE --region ap-south-1

  echo "✅ Done for $TARGET!"
}

if [ "$ENV" = "both" ]; then
  deploy_to hardik
  deploy_to navin
else
  deploy_to $ENV
fi
