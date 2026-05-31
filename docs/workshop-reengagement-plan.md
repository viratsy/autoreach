# Workshop Re-engagement Automation Plan

## Overview

Automate sending workshop reminder sequences to past batch contacts for up to 4 additional batches, using AutoReach infrastructure (Hardik Raja numbers, round-robin, template safety checks).

---

## Flow

```
User registers for workshop
  → Existing Lambda schedules current batch reminders (as-is)
  → ALSO: Adds user to re-engagement table with counter=0

Night before NEXT workshop (1 AM IST):
  → Re-engagement Lambda triggers
  → Reads all contacts from re-engagement table where counter < 4
  → For each contact:
      1. Check masterclass_lookup_key table (PHONE#xxx and EMAIL#xxx)
      2. If EXISTS → skip (already converted), mark as "converted"
      3. If NOT EXISTS → 
         a. Get current batch details from WhatsAppDatabase table
         b. Schedule campaign via AutoReach (same reminder sequence)
         c. Increment counter
  → After 4 batches → stop sending to that contact
```

---

## New DynamoDB Table: `autoreach-reengagement`

| Attribute | Type | Description |
|-----------|------|-------------|
| PK | String | `PHONE#<phone>` (normalized, digits only) |
| SK | String | `WS#<workshop_short_code>` (e.g., `WS#aitools`) |
| name | String | Contact name |
| phone | String | Full phone number |
| email | String | Contact email |
| workshopName | String | e.g., "Generative AI Tools" |
| wsCode | String | Short code (aitools, msai, etc.) |
| counter | Number | How many batches sent (0-4) |
| status | String | active / converted / completed |
| registeredAt | String | ISO timestamp of first registration |
| lastSentBatchDate | String | Date of last batch they were included in |
| createdAt | String | ISO timestamp |

---

## External Tables (Read-Only)

### WhatsAppDatabase (existing, Hardik's account)
- PK: `Name` (workshop name, e.g., "Generative AI Tools")
- Fields: Date, Workshop, ZoomLink, WhatsappLink, img, ShortDate, WorkshopType

### masterclass_lookup_key (existing, Hardik's account)
- PK: `masterclass_lookup_key`
- Format: `PHONE#919447879707` or `EMAIL#jchoudhury001@gmail.com`

---

## Components to Build

### 1. Entry Point: Add to Re-engagement (triggered from existing Lambda)

When existing workshop Lambda fires for a new registration:
- Call AutoReach API or directly write to `autoreach-reengagement` table
- Set counter=0, status=active

### 2. Nightly Scheduler Lambda (runs at 1 AM IST daily)

- Scans `autoreach-reengagement` where status=active AND counter < 4
- For each workshop type, gets current batch details from `WhatsAppDatabase`
- Groups contacts by workshop
- For each group:
  - Check masterclass table for each contact (batch lookup)
  - Filter out converted users
  - Create AutoReach campaign with remaining contacts
  - Campaign uses the reminder template sequence
  - Schedule for the appropriate times (same pattern as existing: 2days, 1day, 60min, etc.)
- Increment counter for all processed contacts

### 3. Campaign Naming

Format: `{ws_code}_{workshop_date}_{template_name}`
Example: `aitools_2026-06-03_2days_to_go`

### 4. Template Sequence (per batch)

Same as existing system, one campaign per run_key:
- `2days_to_go` → 2 days before, 10 AM
- `1day_to_go` → 1 day before, 10 AM
- `60_mins_to_go` → 1 hour before
- `20_mins_to_go` → 20 min before
- `we_are_live` → at start time
- `its_7_pm` / `its_11_am` → exact workshop time
- etc.

Each is a separate AutoReach campaign scheduled at the right time.

### 5. Frontend: Workshop Schedule Tab

New sidebar item: "Workshop Schedule"
- Shows upcoming workshop batches with:
  - Workshop name, date, time
  - Number of contacts in re-engagement pool
  - How many converted (skipped)
  - Campaigns scheduled for this batch
  - Status per reminder (scheduled/sent/delivered)

### 6. Safety Features

- Template category check before each campaign (same as regular campaigns)
- Marketing → reroute to healthy numbers
- Auto-retry failed messages
- Round-robin across all Hardik Raja numbers

---

## Trigger Options

**Option A: Modify existing Lambda**
Add a call at the end of the existing workshop Lambda to write to `autoreach-reengagement` table.

**Option B: DynamoDB Stream**
Put a DynamoDB stream on the existing `comm_messages` table. When a new "scheduled" item appears, trigger a Lambda that adds the contact to re-engagement.

**Option C: Direct API call**
Existing Lambda calls an AutoReach API endpoint to register the contact for re-engagement.

**Recommended: Option A** (simplest — just add 5 lines to existing Lambda)

---

## Implementation Order

1. Create `autoreach-reengagement` DynamoDB table
2. Build nightly scheduler Lambda (reads table, checks masterclass, creates campaigns)
3. Add entry point (modify existing Lambda or API endpoint)
4. Build frontend "Workshop Schedule" tab
5. Create and approve templates on Hardik Raja numbers
6. Test with one workshop cycle
7. Deploy to production

---

## Questions Resolved

- ✅ Contacts come from existing Lambda (at registration time)
- ✅ Counter tracks batches (max 4)
- ✅ Masterclass check: EXISTS = skip, NOT EXISTS = send
- ✅ Current batch details from WhatsAppDatabase table
- ✅ All Hardik Raja numbers used
- ✅ Templates TBD (will use same pattern as existing system)
- ✅ Campaign naming: ws_code + date + template
- ✅ Trigger: 1 AM IST after workshop day (5 hours after 7 PM session)
