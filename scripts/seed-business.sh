#!/bin/bash
# Seed a business into DynamoDB
# Usage: bash scripts/seed-business.sh

PROFILE="autoreach-hardik"
REGION="ap-south-1"
TABLE="autoreach-businesses"

# ============================================
# EDIT THESE VALUES WITH YOUR REAL DATA
# ============================================

BUSINESS_ID="biz_001"
BUSINESS_NAME="Your Business Name"
WABA_ID="your_waba_id"
ACCESS_TOKEN="your_meta_access_token"

# Phone numbers - add as many as needed
# Format: phoneNumberId,displayNumber,displayName
PHONE_NUMBERS='[
  {"M": {"phoneNumberId": {"S": "PHONE_NUMBER_ID_1"}, "displayNumber": {"S": "+91 98765 43210"}, "displayName": {"S": "Number A"}}},
  {"M": {"phoneNumberId": {"S": "PHONE_NUMBER_ID_2"}, "displayNumber": {"S": "+91 98765 43211"}, "displayName": {"S": "Number B"}}}
]'

# ============================================

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

aws dynamodb put-item \
  --table-name $TABLE \
  --profile $PROFILE \
  --region $REGION \
  --item "{
    \"PK\": {\"S\": \"BIZ#${BUSINESS_ID}\"},
    \"SK\": {\"S\": \"METADATA\"},
    \"businessId\": {\"S\": \"${BUSINESS_ID}\"},
    \"businessName\": {\"S\": \"${BUSINESS_NAME}\"},
    \"wabaId\": {\"S\": \"${WABA_ID}\"},
    \"accessToken\": {\"S\": \"${ACCESS_TOKEN}\"},
    \"phoneNumbers\": {\"L\": ${PHONE_NUMBERS}},
    \"createdAt\": {\"S\": \"${TIMESTAMP}\"},
    \"updatedAt\": {\"S\": \"${TIMESTAMP}\"}
  }"

echo "✅ Business '${BUSINESS_NAME}' seeded successfully"
