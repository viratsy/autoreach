#!/bin/bash
# Deploy AutoReach to both Hardik and Navin accounts
# Usage: bash scripts/deploy-all.sh [hardik|navin|both|frontend|backend]

set -e

HARDIK_API="https://xb4sthj0lb.execute-api.ap-south-1.amazonaws.com/Prod"
NAVIN_API="https://ovp3rbikb2.execute-api.ap-south-1.amazonaws.com/Prod"
HARDIK_BUCKET="autoreach-frontend-hardik-760019269058"
NAVIN_BUCKET="autoreach-frontend-navin-632320832903"
HARDIK_CF="E28UVIGW7THBHI"
NAVIN_CF="E2IT11P85YPHVG"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/frontend/.env.local"

TARGET=${1:-both}

deploy_backend() {
  local env=$1
  echo "🔧 Deploying backend to $env..."
  cd "$REPO_ROOT/backend"
  npx tsc --outDir dist
  rm -rf .aws-sam
  sam build
  # sam exits 1 on "No changes to deploy", which is a success for our purposes.
  # Letting set -e kill the run here is what previously deployed hardik and
  # silently skipped navin.
  local out status
  out=$(sam deploy --config-env $env --no-confirm-changeset --force-upload 2>&1) || status=$?
  echo "$out"
  if [ -n "${status:-}" ] && ! echo "$out" | grep -q "No changes to deploy"; then
    echo "❌ Backend deploy FAILED for $env (exit $status)"
    return $status
  fi
  cd "$REPO_ROOT"
  echo "✅ Backend deployed to $env"
}

deploy_frontend() {
  local env=$1
  local api_url bucket cf_id

  if [ "$env" = "hardik" ]; then
    api_url=$HARDIK_API
    bucket=$HARDIK_BUCKET
    cf_id=$HARDIK_CF
  else
    api_url=$NAVIN_API
    bucket=$NAVIN_BUCKET
    cf_id=$NAVIN_CF
  fi

  echo "🌐 Building frontend for $env (API: $api_url)..."
  echo "NEXT_PUBLIC_API_URL=$api_url" > "$ENV_FILE"
  cd "$REPO_ROOT/frontend"
  npx next build
  echo "📦 Syncing to S3: $bucket..."
  aws s3 sync out/ s3://$bucket --delete --profile $env
  echo "🔄 Invalidating CloudFront: $cf_id..."
  aws cloudfront create-invalidation --distribution-id $cf_id --paths "/*" --profile $env
  cd "$REPO_ROOT"
  echo "✅ Frontend deployed to $env"
}

# Restore Hardik env at the end
restore_env() {
  echo "NEXT_PUBLIC_API_URL=$HARDIK_API" > "$ENV_FILE"
}
trap restore_env EXIT

case $TARGET in
  hardik)
    deploy_backend hardik
    deploy_frontend hardik
    ;;
  navin)
    deploy_backend navin
    deploy_frontend navin
    ;;
  both)
    deploy_backend hardik
    deploy_frontend hardik
    deploy_backend navin
    deploy_frontend navin
    ;;
  frontend)
    deploy_frontend hardik
    deploy_frontend navin
    ;;
  backend)
    deploy_backend hardik
    deploy_backend navin
    ;;
  *)
    echo "Usage: bash scripts/deploy-all.sh [hardik|navin|both|frontend|backend]"
    exit 1
    ;;
esac

echo ""
echo "🎉 Done! Deployed to: $TARGET"
