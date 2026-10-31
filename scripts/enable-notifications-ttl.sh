#!/bin/bash
# One-time: enable DynamoDB TTL on the notifications table for a given env/profile.
# The table was created manually (see create-notifications-table.json) rather than
# through the SAM template, so TTL can't be turned on via template.yaml — this is
# the equivalent manual step. Safe to run anytime; notifications/index.ts already
# writes a `ttl` attribute (90 days out, refreshed per occurrence) on every record,
# so there's no backfill needed once this runs.
#
# Usage: ./enable-notifications-ttl.sh <env-name> <aws-profile>
# Example: ./enable-notifications-ttl.sh hardik hardik

set -euo pipefail

ENV_NAME="${1:?Usage: $0 <env-name> <aws-profile>}"
PROFILE="${2:?Usage: $0 <env-name> <aws-profile>}"
TABLE="autoreach-notifications-${ENV_NAME}"

aws dynamodb update-time-to-live \
  --table-name "$TABLE" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --profile "$PROFILE"

echo "TTL enabled on $TABLE (profile: $PROFILE)"
