# DynamoDB Schema Design

## Tables

### 1. Businesses Table

| Attribute | Type | Role |
|-----------|------|------|
| PK | String | `BIZ#<businessId>` |
| SK | String | `METADATA` |
| businessName | String | |
| wabaId | String | WhatsApp Business Account ID |
| accessToken | String | Meta access token (env var ref) |
| phoneNumbers | List | `[{ phoneNumberId, displayNumber, displayName }]` |
| createdAt | String | ISO timestamp |
| updatedAt | String | ISO timestamp |

---

### 2. Campaigns Table

| Attribute | Type | Role |
|-----------|------|------|
| PK | String | `CAMP#<campaignId>` |
| SK | String | `METADATA` |
| campaignName | String | User prefix + unique suffix |
| businessId | String | |
| businessName | String | Denormalized |
| selectedNumbers | List | `[{ phoneNumberId, displayNumber }]` |
| templateName | String | |
| templateMappings | Map | `{ phoneNumberId: templateName }` |
| parameterMapping | Map | `{ "1": "name", "2": "workshop_date" }` |
| csvS3Key | String | S3 object key |
| totalContacts | Number | |
| scheduleDate | String | ISO date |
| scheduleTime | String | HH:mm |
| schedulerArn | String | EventBridge scheduler ARN |
| status | String | draft/scheduled/running/completed/failed/cancelled |
| createdBy | String | Cognito user ID |
| createdAt | String | ISO timestamp |
| updatedAt | String | ISO timestamp |

**GSI1** (Query campaigns by business):
- GSI1PK: `BIZ#<businessId>`
- GSI1SK: `<createdAt>`

**GSI2** (Query campaigns by status):
- GSI2PK: `STATUS#<status>`
- GSI2SK: `<scheduleDate>#<scheduleTime>`

---

### 3. Messages Table

| Attribute | Type | Role |
|-----------|------|------|
| PK | String | `CAMP#<campaignId>` |
| SK | String | `MSG#<phone>` |
| phoneNumber | String | |
| contactName | String | |
| sendingNumberId | String | Which number sent this |
| metaMessageId | String | From Meta API response |
| status | String | queued/sent/delivered/read/failed |
| repliedAt | String | ISO timestamp or null |
| errorCode | String | Meta error code if failed |
| sentAt | String | ISO timestamp |
| updatedAt | String | ISO timestamp |

**GSI1** (Query by Meta message ID for webhook processing):
- GSI1PK: `METAMSG#<metaMessageId>`
- GSI1SK: `CAMP#<campaignId>`

**GSI2** (Query failed messages for retry):
- GSI2PK: `CAMP#<campaignId>`
- GSI2SK: `FAIL#<phone>`
- Condition: Only projected when status = "failed"

---

### 4. Templates Table

| Attribute | Type | Role |
|-----------|------|------|
| PK | String | `BIZ#<businessId>` |
| SK | String | `TPL#<phoneNumberId>#<templateName>` |
| templateName | String | |
| language | String | |
| category | String | |
| components | List | Template body/header/buttons |
| parameterCount | Number | |
| status | String | approved/pending/rejected |
| lastSyncedAt | String | ISO timestamp |

---

## Access Patterns

| Pattern | Table | Key Condition |
|---------|-------|---------------|
| Get business details | Businesses | PK = `BIZ#<id>`, SK = `METADATA` |
| List all businesses | Businesses | Scan (small table) |
| Get campaign | Campaigns | PK = `CAMP#<id>`, SK = `METADATA` |
| List campaigns by business | Campaigns GSI1 | GSI1PK = `BIZ#<id>` |
| List campaigns by status | Campaigns GSI2 | GSI2PK = `STATUS#<status>` |
| Get all messages for campaign | Messages | PK = `CAMP#<id>` |
| Find message by Meta ID (webhook) | Messages GSI1 | GSI1PK = `METAMSG#<id>` |
| Get failed messages for retry | Messages GSI2 | GSI2PK = `CAMP#<id>`, SK begins_with `FAIL#` |
| Get templates for business+number | Templates | PK = `BIZ#<id>`, SK begins_with `TPL#<phoneNumberId>` |
| Get specific template | Templates | PK = `BIZ#<id>`, SK = `TPL#<phoneNumberId>#<name>` |

---

## Notes

- Campaign IDs: `<userPrefix>_<nanoid(6)>` e.g. `diwali_offer_a3x9k2`
- All timestamps in ISO 8601 format
- Messages table will be high-volume — partition key on campaignId keeps related messages together
- Webhook Lambda uses GSI1 on Messages to find the right message by Meta's message ID
- Template sync job runs daily, updates Templates table per business+number combo
