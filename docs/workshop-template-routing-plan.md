# Workshop Template Routing Plan

## Overview

Replace the single-number workshop sender Lambda with AutoReach's multi-number infrastructure. Each number can have different template names for the same message type. Support 5 cycles (1 current + 4 re-engagement) with different business/numbers per cycle.

## Current System

- One Lambda per number (hardcoded PHONE_NUMBER_ID)
- Template config is a Python dict: `TEMPLATES[workshop_code][run_key]`
- Each config has: `template_name`, `body_params[]`, `image_type`
- Parameters resolved from payload (name, zoom_link, whatsapp_group, dates, etc.)

## New System

### Architecture

```
User registers → AutoReach registers contact →
  Scheduler creates campaigns for each run_key →
    Each campaign uses template routing config →
      Per-number template name + params
```

### Template Routing Config

Stored in DynamoDB: `autoreach-workshop-config-{env}`

```json
{
  "PK": "WSCONFIG#aitools",
  "SK": "CYCLE#0",  // 0=current(SN), 1-4=re-engagement(HR)
  "workshopCode": "aitools",
  "workshopName": "Generative AI Tools",
  "cycle": 0,
  "businessId": "skill_nation",  // which business to use
  "runKeys": {
    "2days_to_go": {
      "numbers": {
        "767721219763053": {
          "templateName": "2_day_left_utility_ai_tools",
          "bodyParams": ["full_workshop_name", "w_type", "workshop_name_w", "workshop_date_time", "whatsapp_group", "workshop_date"],
          "imageType": null
        },
        "861946696997409": {
          "templateName": "2_day_left_utility_ai_1",
          "bodyParams": ["full_workshop_name", "w_type", "workshop_name_w", "workshop_date_time", "whatsapp_group", "workshop_date"],
          "imageType": null
        }
      }
    },
    "1day_to_go": {
      "numbers": {
        "767721219763053": {
          "templateName": "1_day_to_go_utility_ai_tools",
          "bodyParams": ["mentor_name", "workshop_date_time", "whatsapp_group"],
          "imageType": null
        },
        ...
      }
    },
    "60_mins_to_go": { ... },
    "20_mins_to_go": { ... },
    "we_are_live": { ... },
    "its_7_pm": { ... },
    "its_7_10_pm": { ... },
    "its_7_20_pm": { ... },
    "its_7_30_pm": { ... }
  }
}
```

### Cycle Configuration

| Cycle | Business | Numbers | Purpose |
|-------|----------|---------|---------|
| 0 | Skill Nation (SN) | SN numbers | Current batch |
| 1-4 | HR Academy | HR numbers | Re-engagement |

Each cycle has its own config entry (different SK), allowing different templates/numbers per cycle.

### Parameter Resolution

Same as existing system. Parameters are resolved from the workshop payload:

| Key | Source |
|-----|--------|
| name | payload.name |
| zoom_link | payload.zoom_link |
| whatsapp_group | payload.whatsapp_group |
| workshop_name | payload.workshop_name |
| full_workshop_name | "3 Hours Live {workshop_name} Workshop" |
| workshop_name_w | "{workshop_name} Workshop" |
| workshop_date | payload.workshop_date |
| workshop_time | payload.workshop_time |
| workshop_time_short | workshop_time without "IST" |
| workshop_date_time | "{date} at {time}" |
| mentor_name | "Hardik Raja (Your Mentor)" |
| w_type | "Workshop" |
| notes_ai / notes_ms / etc. | Static text per workshop type |

### Schedule Timing

Based on workshop time (7 PM or 11 AM):

**7 PM workshops:**
| run_key | Time (IST) |
|---------|------------|
| 2days_to_go | D-2, 10:00 AM |
| 1day_to_go | D-1, 10:00 AM |
| 9am_groupjoin | D, 9:00 AM |
| 1pm_group_join | D, 1:00 PM |
| 3pm_group_join | D, 3:00 PM |
| 60_mins_to_go | D, 6:00 PM |
| 20_mins_to_go | D, 6:30 PM |
| we_are_live | D, 6:50 PM |
| its_7_pm | D, 7:00 PM |
| its_7_10_pm | D, 7:10 PM |
| its_7_20_pm | D, 7:20 PM |
| its_7_30_pm | D, 7:30 PM |

**11 AM workshops:**
| run_key | Time (IST) |
|---------|------------|
| 2days_to_go | D-2, 10:00 AM |
| 1day_to_go | D-1, 10:00 AM |
| 9am_groupjoin | D, 9:00 AM |
| 60_mins_to_go | D, 10:00 AM |
| 20_mins_to_go | D, 10:30 AM |
| we_are_live | D, 10:50 AM |
| its_11_am | D, 11:00 AM |
| its_11_10_am | D, 11:10 AM |
| its_11_20_am | D, 11:20 AM |
| its_11_30_am | D, 11:30 AM |

## Frontend UI

### Workshop Config Page (`/workshops/config/`)

1. **Workshop selector** — dropdown (aitools, msai, aidash, aibuild)
2. **Cycle selector** — tabs (Cycle 0: Current, Cycle 1-4: Re-engagement)
3. **Business selector** — which business/numbers to use for this cycle
4. **Run key list** — expandable sections for each run_key
5. **Per-number config** — for each number in the selected business:
   - Template name (text input, with autocomplete from synced templates)
   - Body params (ordered list, drag to reorder, select from param keys)
   - Image type (none / select image)
6. **Save button** — saves config to DynamoDB
7. **Test button** — send test message for a specific run_key

### Workshop Contacts Page (existing `/workshops/`)

Already built — shows contacts, counters, status, download.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /workshops/config?wsCode=aitools&cycle=0 | Get config for workshop+cycle |
| PUT | /workshops/config | Save/update config |
| GET | /workshops/config/list | List all workshop configs |

## Sending Flow

### Current Batch (Cycle 0)

```
User registers → existing Lambda fires →
  Calls POST /workshops/register (adds to re-engagement table) →
  AutoReach nightly scheduler picks up contacts with counter=0 →
  Gets config for WSCONFIG#aitools, CYCLE#0 →
  Creates campaigns per run_key using SN business numbers →
  Each campaign uses per-number template routing
```

Wait — for current batch, the timing is immediate (not nightly). The existing Lambda already schedules EventBridge schedules for each run_key at the right time. We need to replicate this:

### Revised Current Batch Flow

```
User registers →
  AutoReach receives registration →
  Immediately creates EventBridge schedules for each run_key →
  Each schedule triggers at the right time (2 days before, 1 day before, etc.) →
  When triggered: creates campaign with that one contact + any others for same batch →
  Uses Cycle 0 config (SN numbers)
```

### Re-engagement Flow (Cycles 1-4)

```
Nightly at 1 AM →
  Query active contacts →
  Check payment →
  Get next batch details from WhatsAppDatabase →
  Create campaigns per run_key using Cycle 1-4 config (HR numbers) →
  Schedule at appropriate times
```

## Implementation Order

1. Create `autoreach-workshop-config` DynamoDB table
2. Build config CRUD API endpoints
3. Build frontend config editor UI
4. Update nightly scheduler to use config (instead of hardcoded templates)
5. Build current-batch scheduler (replaces existing Lambda)
6. Test with one workshop
7. Migrate from old system

## Migration Strategy

1. Keep old Lambda running in parallel
2. Test new system with a subset of contacts
3. Once verified, switch registration to trigger AutoReach instead of old Lambda
4. Decommission old Lambda

## Key Differences from Regular Campaigns

| Feature | Regular Campaign | Workshop Campaign |
|---------|-----------------|-------------------|
| Contacts | CSV upload | Auto from registration |
| Template | One template for all | Per-number routing |
| Schedule | One time | Multiple run_keys at different times |
| Numbers | Round-robin | Specific per config |
| Repeat | One-shot | 5 cycles per contact |
| Parameters | CSV columns / static | Resolved from workshop payload |
