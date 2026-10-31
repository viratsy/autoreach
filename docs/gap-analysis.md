# AutoReach AI — Gap Analysis

**Date:** 2026-07-16 (updated after Phase 1 + Phase 2 fixes, same day)
**Scope:** Full repo review (backend Lambda/SAM, frontend Next.js, infra) against `AutoReach.md` (original spec) and general production-readiness expectations for a WhatsApp campaign/business-outreach platform.

## Status: what's fixed vs. still open

**Fixed (Phase 1 — security/state-machine):** webhook signature verification (fail-open until `MetaAppSecret` is provisioned), auth added to 27 previously-open handlers, `resume`/`cancel`/`auto-stop` race conditions and illegal-resurrection bug, cancel now actually stops in-flight sends.

**Fixed (Phase 2 — correctness/reliability):** quote-aware CSV parsing (`lib/csv.ts`), tier-aware + quality-aware round-robin distribution (`lib/round-robin.ts`), quality-check results now persisted for reuse, `send-worker.ts` businessId derivation, `webhook-worker.ts`'s two full-table Scans replaced with a GSI4 index + a dedicated phone-lookup table, notification TTL + retry-failed.ts unknown-error visibility, pagination on `campaigns/list.ts`/`businesses/list.ts`, SES IAM policy scoped, DynamoDB PITR enabled on the three core tables, `estimateCost` finally wired into campaign creation (and a real bug found by the new test suite: `PRICING_INR.service = 0` was being treated as falsy and silently replaced with the utility rate). A 27-test jest suite now covers the CSV parser, pricing, and round-robin logic.

**Correction to the original analysis:** the opt-out/STOP-keyword finding below (§3, item 1) was a false positive — `webhook-worker.ts`'s `checkUnsubscribe` already parses inbound STOP-style keywords and writes to the suppression table. Struck through below.

**Still open, deliberately deferred (need a product decision or a coordinated rollout, not a quick code fix):**
- JWT secret decoupling from `WebhookVerifyToken` — code-ready conceptually, but rotating it logs out every current session on both `hardik` and `navin`; needs the team to pick a rollout window.
- Cross-campaign contact dedup — needs a decision on dedup window/policy.
- Per-number 24h tier *hard* enforcement (today it's soft — round-robin weights by tier but doesn't block overflow) — needs a decision on what happens when a number's daily cap would be exceeded (queue to next day? reroute? reject the campaign?).
- Full audit logging system, OpenAPI documentation, CloudWatch alarms + alerting destination, multi-language/locale template support — all real gaps, all bigger builds than a single pass; flag if you want one prioritized next.
- `workshops/download.ts` still has no auth (opened via `window.open()`, which sends no Authorization header — needs a frontend change, e.g. a short-lived signed link, to fix properly).
- Housekeeping: `scripts/` still has leftover one-off debug artifacts (`tmp-key.json`, `fix-*.json`, etc.) — left alone since deleting a teammate's files needs a confirm first.

The platform has grown well past its original spec. `AutoReach.md` explicitly says "this is NOT a chat platform" and lists live chat inbox, agent assignment, CRM, conversation management, and chatbot functionality as things to **not** build — yet `flows/`, `conversations.ts`, and the whole `workshops/` subsystem now exist and are wired up. That pivot may be intentional (product direction changed), but it means the original spec is no longer a reliable checklist; this doc evaluates the platform as it actually stands today.

---

## 1. Security (highest priority — exploitable today)

| # | Finding | Location | Why it matters |
|---|---|---|---|
| 1 | No Meta webhook signature verification | `backend/src/handlers/webhooks/meta-status.ts:26-43` | Anyone who discovers the webhook URL can POST fake delivery/read statuses or fake inbound replies — no `X-Hub-Signature-256` HMAC check against the app secret. |
| 2 | Almost no per-request auth checks | across handlers | Only `businesses/create.ts`, `businesses/update.ts`, `templates/create.ts`, `templates/manual-add.ts` call `getAuthEmail`. `campaigns/create.ts`, `campaigns/send.ts`, `campaigns/resume.ts`, `workshops/bulk-register.ts`, `retry-failed.ts`, `daily-sync.ts` are open to anyone with the API base URL. |
| 3 | JWT secret doubles as the Meta webhook verify token | `backend/template.yaml:28` (`JWT_SECRET: !Ref WebhookVerifyToken`) | The verify token is echoed in a browser-visible query string during Meta's webhook verification handshake, making it semi-public — if it leaks, login sessions can be forged. |
| 4 | JWT has a hardcoded fallback secret | `backend/src/lib/jwt.ts:3` (`process.env.JWT_SECRET \|\| "autoreach-secret"`) | A misconfigured deploy silently signs tokens with a publicly-known string. |
| 5 | Auth is a hardcoded 7-email allowlist, not Cognito | `backend/src/lib/auth-config.ts:2-10` | Spec called for Cognito; onboarding any new user needs a code change + redeploy. |
| 6 | No OTP rate limiting | `backend/src/handlers/auth/request-otp.ts` | Nothing stops spamming SES sends to a valid email; the 3-attempt guess limit in `verify-otp.ts:9` resets by simply requesting a new OTP. |
| 7 | Overly broad IAM policy | `backend/template.yaml:403-412` (SES `Resource: "*"`) | Should be scoped to the verified sender identity ARN. |
| 8 | Secrets (Meta access tokens, provider API keys) stored as plain DynamoDB attributes | e.g. `quality-check.ts:25`, `resume.ts:51` | No Secrets Manager/KMS envelope encryption — a table read/leak exposes live WhatsApp credentials directly. |
| 9 | Unrestricted file upload to a public CDN path | `backend/src/handlers/campaigns/upload-image.ts:20-29`, `template.yaml:362-375` | `contentType` is taken verbatim from the client, no whitelist or `ContentLengthRange`, and CloudFront serves `images/*` publicly — an HTML/SVG upload could be served same-origin (stored-XSS style risk). |
| 10 | JWT stored in `localStorage` on frontend | `frontend/src/lib/api.ts:3-6` | XSS-exfiltratable; should be an httpOnly cookie. |

## 2. Correctness bugs in "working" features

| # | Finding | Location | Impact |
|---|---|---|---|
| 1 | `resume.ts` can revive a cancelled or completed campaign | `backend/src/handlers/campaigns/resume.ts:39-149` | Never checks `campaign.status` before re-queuing `"queued"` messages to SQS — defeats `cancel.ts`, and the endpoint has no auth check either. |
| 2 | `cancel.ts` doesn't stop in-flight sends | `backend/src/handlers/campaigns/cancel.ts:30-45`, `send-worker.ts:60-166` | Cancelling only flips the DB status; messages already sitting in SQS are still sent to customers. |
| 3 | Race condition between auto-stop / send-worker / resume | `auto-stop.ts:33-41`, `send-worker.ts:383-438`, `resume.ts:136-149` | Unconditioned `UpdateCommand`s (no `ConditionExpression`) on the same status field — concurrent writes can flip-flop `completed`/`running` and silently lose an update. |
| 4 | Nightly workshop scheduler computes "today" in UTC, not IST | `backend/src/handlers/workshops/nightly-scheduler.ts:19` | Comment says "runs at 1 AM IST daily" but uses `new Date().toISOString().split("T")[0]` — at 1 AM IST, UTC is still the previous day, so contacts get activated/counted a day late. |
| 5 | Round-robin distribution is static and tier-unaware | `backend/src/lib/round-robin.ts:20-41` | Simple `index % numbers.length` up front — no rebalancing if a number fails mid-campaign, and no awareness of Meta's per-number 24h tier caps (250/1k/10k/100k), so a tier-250 number can be assigned thousands of contacts. |
| 6 | Business quality rating isn't used for number selection | `businesses/quality-check.ts` | Wired up only for dashboard display; campaign creation and round-robin never check `qualityRating`/`messagingLimit`, so a flagged/RED number can still be picked. |
| 7 | Pricing estimator is dead code | `backend/src/lib/pricing.ts:13-24`, `ReviewSchedule.tsx:206-210` | `estimateCost` is never called; the frontend hand-duplicates the rate table instead, and there's no server-side pre-send budget check. |
| 8 | Unpaginated full table Scans | `campaigns/list.ts:15-21`, `businesses/list.ts:11-13` | No `ExclusiveStartKey` loop — once a table exceeds DynamoDB's ~1MB Scan page, results silently truncate and dashboard stats undercount. |
| 9 | Notifications never expire or resolve | `backend/src/handlers/notifications/index.ts` | `resolved` is always written `false` and nothing ever flips it; no TTL attribute — the table only shrinks via manual delete. |
| 10 | No retry/backoff in frontend API client | `frontend/src/lib/api.ts:15-22` | Single `fetch`, no retry/timeout — a transient blip during a large CSV upload or schedule action surfaces as an immediate hard error. |
| 11 | Unrecognized send errors silently treated as non-retryable | `backend/src/handlers/campaigns/retry-failed.ts:91-94` | Messages can get permanently stuck "failed" with no visibility into why they were excluded from retry. |
| 12 | Full-table Scans on every inbound webhook message | `webhook-worker.ts:197` (Businesses), `webhook-worker.ts:236-246` (Messages) | O(n) per webhook event — will degrade and get expensive as data grows. |
| 13 | `processTemplateCategoryUpdate` is a stub | `webhook-worker.ts:149-157` | Only logs; never updates the Templates record, making the `template_category_update` webhook subscription currently dead weight. |
| 14 | `businessId` derived by string-splitting `campaignId` | `send-worker.ts:91,338` | Fragile convention coupling instead of reading `campaign.businessId`, which is already available. |
| 15 | Backend CSV parsing is naive `split(",")`, frontend uses `papaparse` | `campaigns/send.ts:210-219`, `file-preview.ts:40,53` | Not quote/escape-aware — a comma inside a contact name corrupts that row and misaligns every column after it; the two parsers can also disagree. |
| 16 | Parameter auto-match is purely positional | `frontend/src/components/campaign/MapParameters.tsx:62-77` | Zips `params[i]` to `csvHeaders[i]` by index, not by name/keyword — reordering CSV columns silently produces wrong mappings. |

## 3. Missing features (spec-required or expected for this product category)

| # | Feature | Status | Why it matters |
|---|---|---|---|
| ~~1~~ | ~~Opt-out / STOP-keyword compliance~~ | **False positive — corrected.** `webhook-worker.ts`'s `checkUnsubscribe()` already parses inbound STOP-style keywords and writes to `UNSUBSCRIBE_TABLE`; `send-worker.ts` consumes it before every send. Both producer and consumer exist. | N/A |
| 2 | Cross-campaign contact deduplication / global contact list | Absent | The same phone number can receive messages from multiple campaigns the same day with no dedupe. |
| 3 | Native Meta Cloud API as a first-class provider | Absent — inlined `fetch` calls duplicated across 4 files instead of behind the shared `Provider` interface used by AiSensy/WATI | Duplication risk and inconsistent error handling between providers. |
| 4 | AiSensy template fetch/sync | Absent (`daily-sync.ts` explicitly skips AiSensy businesses) | Spec's "daily template sync" only actually functions for Meta/WATI numbers. |
| 5 | Per-number 24h messaging tier tracking | Absent | Meta enforces 250/1k/10k/100k contact ceilings per number/day; nothing persists or enforces this, risking number restriction/ban. |
| 6 | Pre-send cost/budget cap | Absent (estimator exists but unused, see bug #7 above) | No way to stop a campaign from being scheduled if it exceeds a budget. |
| 7 | CloudWatch alarms / admin alerting | Absent — no `AWS::CloudWatch::Alarm` resources in `template.yaml` | Failures only surface via the in-app notifications table; no paging/email when a campaign fails broadly. |
| 8 | Audit logging | Absent | Explicitly required by the original spec ("Audit logging" under Non-Functional Requirements) — no table, field, or handler resembling an audit trail exists. |
| 9 | Multi-language / locale template support | Absent | No `language`/`locale` field anywhere in campaign or template types — can't target templates in multiple languages for the same logical message. |
| 10 | DynamoDB backup / point-in-time recovery | Absent — no `PointInTimeRecoverySpecification` in `template.yaml` for any table | No recovery path from accidental deletes/writes. |
| 11 | API documentation (OpenAPI/Swagger) | Absent | `template.yaml`'s SAM `Events` blocks are the only source of truth for the API surface. |
| 12 | Automated tests | Absent | No test framework (jest/vitest/mocha) or `*.test.*`/`*.spec.*` files anywhere in backend or frontend. |

## 4. Housekeeping

- `scripts/` has leftover ad-hoc production-data-fix artifacts: `tmp-key.json`, `tmp-vals.json`, `fix-campaign.json`, `fix-names.json`, `fix-vals.json`, `fix-running.sh`, `check-msg.json`, `query-running.json`. Worth moving into a runbook or deleting once confirmed unneeded.
- `template.yaml` has personal/dev defaults baked in (`SesFromEmail` default `otp@hardikraja.com`, `EnvName` default `"hardik"`) that should be parameterized for a non-personal deployment.

## 5. Suggested priority order

1. **Security first** — webhook signature verification, auth checks on unguarded handlers, decouple JWT secret from webhook verify token, move secrets to Secrets Manager. These are exploitable by anyone with the API URL today.
2. **Campaign state-machine correctness** — fix `resume`/`cancel`/`auto-stop` race conditions before they cause a real duplicate-send incident.
3. **Opt-out compliance** — wire STOP-keyword handling into `webhook-worker.ts`; this is a WhatsApp Business Policy compliance risk, not just a UX gap.
4. **Scale fixes** — paginate `list.ts` Scans, replace webhook-worker's full-table Scans with queries/GSIs, before data volume makes these fail silently.
5. **Everything else** — tests, monitoring/alerting, audit log, tier tracking, docs — important but not urgent.
