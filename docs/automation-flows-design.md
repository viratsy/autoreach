# Automation Flows - Implementation Summary

## Status: DEPLOYED (Both hardik & navin profiles)

---

## Deployment Profiles

### Hardik
- **AWS Profile**: `hardik` (Account: 760019269058)
- **API URL**: `https://xb4sthj0lb.execute-api.ap-south-1.amazonaws.com/Prod`
- **Frontend S3**: `autoreach-frontend-hardik-760019269058`
- **CloudFront**: `E28UVIGW7THBHI`
- **Stack Name**: `autoreach-hardik`
- **SES From**: `otp@hardikraja.com`

### Navin
- **AWS Profile**: `navin` (Account: 632320832903)
- **API URL**: `https://ovp3rbikb2.execute-api.ap-south-1.amazonaws.com/Prod`
- **Frontend S3**: `autoreach-frontend-navin-632320832903`
- **CloudFront**: `E2IT11P85YPHVG`
- **Stack Name**: `autoreach-navin`
- **SES From**: `otp@navinparmar.in`

### Deploy Commands
```bash
# Backend (from backend/ dir)
npx tsc; sam build
sam deploy --config-env hardik --no-confirm-changeset
sam deploy --config-env navin --no-confirm-changeset

# Frontend (from frontend/ dir) — MUST delete .next cache and set env var explicitly
# Hardik:
Remove-Item -Recurse -Force .next, out -ErrorAction SilentlyContinue
$env:NEXT_PUBLIC_API_URL="https://xb4sthj0lb.execute-api.ap-south-1.amazonaws.com/Prod"; npx next build
aws s3 sync out s3://autoreach-frontend-hardik-760019269058 --delete --profile hardik --region ap-south-1
aws cloudfront create-invalidation --distribution-id E28UVIGW7THBHI --paths "/*" --profile hardik --region ap-south-1

# Navin:
Remove-Item -Recurse -Force .next, out -ErrorAction SilentlyContinue
$env:NEXT_PUBLIC_API_URL="https://ovp3rbikb2.execute-api.ap-south-1.amazonaws.com/Prod"; npx next build
aws s3 sync out s3://autoreach-frontend-navin-632320832903 --delete --profile navin --region ap-south-1
aws cloudfront create-invalidation --distribution-id E2IT11P85YPHVG --paths "/*" --profile navin --region ap-south-1
```

### IMPORTANT: Frontend Build Notes
- `.env.local` is NOT reliable for switching API URLs between builds
- MUST set `$env:NEXT_PUBLIC_API_URL` in the shell before building
- MUST delete `.next` and `out` folders before each build to avoid stale cache
- Next.js bakes the env var into JS chunks at build time — verify with `Select-String` if unsure

---

## What Was Built

### Backend (SAM/Lambda)
- **Flows CRUD** (`/flows`) — Create, list, update, delete, toggle flows
- **Flow Execution Engine** (`flows/execute.ts`) — Processes incoming messages, triggers flows, advances instances
- **Flow Scheduler** (`flows/scheduler.ts`) — Runs every 15 min, handles timeouts and retriggers
- **Conversations API** (`/conversations`) — View chat history per contact
- **Test API Proxy** (`/flows/test-api`) — Server-side proxy to test external APIs without CORS issues
- **Webhook Enhancement** — Meta webhook now captures text, button clicks, and interactive replies into flow engine

### Frontend
- **Flows List Page** (`/flows`) — List, create, edit, delete, toggle flows
- **Step-Based Flow Builder** — Modal with all step types and full configuration
- **Visual Flow Builder** (`/flows/builder`) — ReactFlow canvas with drag-drop nodes, connections, click-to-delete edges
- **Conversations Page** (`/conversations`) — WhatsApp-style chat viewer
- **Sidebar** — Added Flows and Conversations navigation links

### DynamoDB Tables (3 new)
- `autoreach-flows-{env}` — Flow definitions (PK: BIZ#id, SK: FLOW#id)
- `autoreach-flow-instances-{env}` — Running flow instances per contact (PK: PHONE#phone, SK: FLOW#id#instance)
- `autoreach-conversations-{env}` — All message history (PK: PHONE#phone#NUM#numberId, SK: TS#timestamp)

---

## Flow Step Types

| Step | Description |
|------|-------------|
| **Send Message** | Send text/template with optional buttons (max 3), image, video. If buttons present, pauses for reply and saves as `{{last_reply}}` |
| **Wait for Reply** | Send message + buttons, pause execution, branch based on customer reply (keyword routing), timeout config (end/retry/goto) |
| **Delay** | Wait X hours before proceeding. Optional retrigger with reminder message |
| **Condition** | Check a variable (keyword match or variable_check with contains/equals/not_equals/not_contains) |
| **API Call** | Call webhook/Google Sheets/DB search. Save response to variable. Test button with server-side proxy |
| **Tag** | Tag the contact for segmentation |

---

## How It Works

1. Customer sends message to WhatsApp number
2. Meta webhook receives it → `triggerFlowEngine()` is called
3. Engine checks for active flow instance for this phone (waiting for reply)
   - If found: saves reply as `{{last_reply}}`, advances flow based on step type
   - If not found: checks trigger keywords against active flows → starts new instance
4. Flow executes steps sequentially, pausing at `wait_for_reply` or button messages
5. Scheduler (every 15 min) handles timeouts: retry, goto another step, or end flow

## Message Types Handled
- Text messages (`msg.type === "text"`)
- Interactive button replies (`msg.type === "interactive"`)
- Template button clicks (`msg.type === "button"`)

## Variables System
- `{{phone}}` — Customer phone number
- `{{name}}` — Customer contact name
- `{{last_reply}}` — Last customer reply text (auto-saved)
- `{{flowId}}` — Current flow ID
- Custom variables from API call responses (saved via `responseVariable` config)

---

## Other Changes Made

### Template Copy Fix
- Fixed image header template replication between WABAs
- Frontend shows ImagePicker when copying image templates
- Backend passes image URL in `header_handle` for target WABA

### SES Fix (Navin)
- Fixed typo: `otp@navinparmr.in` → `otp@navinparmar.in` in samconfig.toml

---

## API Endpoints (New)

| Method | Path | Description |
|--------|------|-------------|
| GET | /flows | List flows for a business |
| POST | /flows | Create flow |
| GET | /flows/{flowId} | Get flow details |
| PUT | /flows/{flowId} | Update flow |
| DELETE | /flows/{flowId} | Delete flow |
| POST | /flows/{flowId}/toggle | Activate/pause |
| GET | /flows/{flowId}/instances | List running instances |
| GET | /conversations | Get chat for a contact |
| GET | /conversations/list | List recent conversations |
| POST | /flows/test-api | Proxy API call (avoids CORS) |

---

## Next Steps / Improvements
- Visual builder: save node positions to flow data
- Visual builder: full inline editing (buttons, branches) in side panel
- Flow analytics: track conversion rates per step
- Flow templates: pre-built flows users can import
- Duplicate flow functionality

---

## Deployment Info

### Hardik Profile
- **AWS Account**: 760019269058
- **Stack**: autoreach-hardik
- **API URL**: https://xb4sthj0lb.execute-api.ap-south-1.amazonaws.com/Prod
- **Webhook URL**: https://xb4sthj0lb.execute-api.ap-south-1.amazonaws.com/Prod/webhooks/meta
- **Frontend S3**: autoreach-frontend-hardik-760019269058
- **CloudFront**: E28UVIGW7THBHI
- **Frontend URL**: https://autoreach.hardikraja.com
- **SES From**: otp@hardikraja.com
- **AWS CLI Profile**: hardik

### Navin Profile
- **AWS Account**: 632320832903
- **Stack**: autoreach-navin
- **API URL**: https://ovp3rbikb2.execute-api.ap-south-1.amazonaws.com/Prod
- **Webhook URL**: https://ovp3rbikb2.execute-api.ap-south-1.amazonaws.com/Prod/webhooks/meta
- **Frontend S3**: autoreach-frontend-navin-632320832903
- **CloudFront**: E2IT11P85YPHVG
- **Frontend URL**: https://autoreach.navinparmar.in
- **SES From**: otp@navinparmar.in
- **AWS CLI Profile**: navin

### Deploy Commands
```bash
# Backend (both)
cd backend
npx tsc && sam build
sam deploy --config-env hardik --no-confirm-changeset
sam deploy --config-env navin --no-confirm-changeset

# Frontend (hardik)
cd frontend
rm -rf .next out
NEXT_PUBLIC_API_URL="https://xb4sthj0lb.execute-api.ap-south-1.amazonaws.com/Prod" npx next build
aws s3 sync out s3://autoreach-frontend-hardik-760019269058 --delete --profile hardik --region ap-south-1
aws cloudfront create-invalidation --distribution-id E28UVIGW7THBHI --paths "/*" --profile hardik --region ap-south-1

# Frontend (navin)
rm -rf .next out
NEXT_PUBLIC_API_URL="https://ovp3rbikb2.execute-api.ap-south-1.amazonaws.com/Prod" npx next build
aws s3 sync out s3://autoreach-frontend-navin-632320832903 --delete --profile navin --region ap-south-1
aws cloudfront create-invalidation --distribution-id E2IT11P85YPHVG --paths "/*" --profile navin --region ap-south-1
```

### Important Notes
- Always delete `.next` and `out` before building frontend for a different profile (Next.js caches env vars)
- On Windows PowerShell, use `$env:NEXT_PUBLIC_API_URL="..."` instead of inline env var
- The `.env.local` file is unreliable for multi-profile builds — always set env var explicitly in shell
