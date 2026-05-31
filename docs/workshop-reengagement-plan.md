# Workshop Re-engagement Automation Plan (v2)

## Overview

Automate sending workshop reminder sequences to past batch contacts for up to 4 additional batches, using AutoReach infrastructure (Hardik Raja numbers, round-robin, template safety checks).

## Flow

```
User registers for workshop
  → Existing Lambda schedules current batch reminders (as-is)
  → Calls POST /workshops/register to add contact (counter=0, status=active)

Every night at 1 AM IST (nightly Lambda):
  → Query GSI1: GSI1PK = "STATUS#active"
  → Group contacts by wsCode
  → For each workshop group:
      1. Get current batch details from WhatsAppDatabase table
      2. For each contact:
         a. Check masterclass_lookup_key (PHONE# and EMAIL#)
         b. If EXISTS → mark "converted", set TTL → skip
         c. If NOT EXISTS → include in campaign
      3. Schedule AutoReach campaigns for remaining contacts
      4. Increment counter for all processed
      5. If counter=4 → mark "completed", set TTL
```

## DynamoDB Table: autoreach-reengagement

| Attribute | Type | Role |
|-----------|------|------|
| PK | String | PHONE#digits |
| SK | String | WS#wsCode |
| GSI1PK | String | STATUS#active |
| GSI1SK | String | WS#wsCode#PHONE#digits |
| name | String | Contact name |
| phone | String | Full phone |
| email | String | Contact email |
| workshopName | String | Full workshop name |
| wsCode | String | Short code (aitools, msai, etc.) |
| counter | Number | 0-4 |
| status | String | active / converted / completed |
| lastBatchDate | String | Last workshop date sent |
| registeredAt | String | ISO timestamp |
| ttl | Number | Epoch seconds (auto-delete after 7 days) |

GSI1: Fast query of active contacts only
TTL: Auto-deletes converted/completed records

## External Tables (Read-Only)

### WhatsAppDatabase
- PK: Name (workshop name)
- Fields: Date, Workshop, ZoomLink, WhatsappLink, img, ShortDate, WorkshopType

### masterclass_lookup_key
- PK: masterclass_lookup_key
- Format: PHONE#919447879707 or EMAIL#jchoudhury001@gmail.com

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /workshops/register | Add contact to re-engagement |
| GET | /workshops/contacts?wsCode=aitools&status=active | List contacts |
| GET | /workshops/stats | Summary per workshop |
| GET | /workshops/download?wsCode=aitools | Download CSV |

## Frontend: Workshop Schedule Tab

- Workshop selector dropdown
- Stats cards: total, active, converted, completed
- Table: name, phone, email, counter, status, last batch date
- Download CSV button
- Filter by status (active/converted/completed)

## Campaign Naming

Format: {wsCode}_{batchDate}_{runKey}
Example: aitools_2026-06-03_2days_to_go

## Safety

- Template category check before sending
- Marketing → reroute to healthy numbers
- Auto-retry failed messages
- Payment check at send time (1 AM, fresh data)
- Max 4 batches per contact
- TTL auto-cleanup

## Implementation Order

1. Create autoreach-reengagement DynamoDB table (with GSI + TTL)
2. Build POST /workshops/register endpoint
3. Build nightly scheduler Lambda (1 AM cron)
4. Build GET endpoints (contacts, stats, download)
5. Build frontend Workshop Schedule tab
6. Add call to existing workshop Lambda
7. Create templates on Hardik Raja numbers
8. Test end-to-end
