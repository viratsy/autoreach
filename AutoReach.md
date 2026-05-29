# WhatsApp Campaign Scheduler Platform (Phase 1)

## Project Overview

Build a serverless WhatsApp Campaign Scheduler platform for internal teams.

The platform is designed for businesses that manage multiple WhatsApp Business Accounts and multiple WhatsApp phone numbers.

The primary goal is to:

* Upload contact data via CSV
* Select WhatsApp templates
* Schedule campaigns
* Send broadcasts using multiple WhatsApp numbers
* Track message statuses
* Manage multiple businesses from a single platform

This is NOT a chat support platform.

Do NOT build:

* Live chat inbox
* Agent assignment
* CRM
* Conversation management
* Chatbot functionality

The system should focus only on campaign scheduling, sending, and tracking.

---

# User Roles

## Team User

Can:

* Login
* Create campaigns
* Upload CSV
* Select business
* Select sending numbers
* Select templates
* Schedule campaigns
* View campaign reports
* Duplicate campaigns

Cannot:

* Access Meta tokens
* Access backend credentials

---

# Business Management

The platform must support multiple businesses.

Example:

Business 1

* Number A
* Number B
* Number C

Business 2

* Number D
* Number E

Business 3

* Number F
* Number G

Each business contains:

* Business Name
* WhatsApp Business Account
* Phone Number IDs
* Access Tokens

Tokens must remain hidden from users.

---

# Dashboard

Display:

* Total Campaigns
* Scheduled Campaigns
* Running Campaigns
* Completed Campaigns
* Failed Campaigns

Recent Campaigns Table:

* Campaign Name
* Business
* Schedule Date
* Status
* Total Contacts
* Delivered
* Read
* Replies

Actions:

* View
* Duplicate
* Cancel

---

# Campaign Creation Flow

## Step 1

Select Business

Dropdown:

* Business 1
* Business 2
* Business 3

---

## Step 2

Select Sending Numbers

Display all available numbers under selected business.

Example:

☑ Number A

☑ Number B

☑ Number C

Multiple selection required.

---

## Step 3

Upload CSV

Supported:

.csv

Example:

name,phone,workshop_date,group_link
Virat,919999999999,15 June,https://abc.com
Navin,918888888888,20 June,https://xyz.com

Validation:

* Phone column required
* CSV cannot be empty
* Invalid numbers must be highlighted

Show preview of first 10 records.

---

## Step 4

Fetch Templates

Fetch templates for all selected numbers.

Use Meta WhatsApp Cloud API.

Store template metadata in database.

Display available templates.

Example:

adv_confirmation

emi_reminder

certificate_ready

---

## Step 5

Template Matching Engine

System must verify that selected template exists on all selected numbers.

Example:

Number A
adv_confirmation ✓

Number B
adv_confirmation ✓

Number C
adv_confirmation ✗

If mismatch occurs:

Display error.

Show available alternative templates.

Allow user to manually map template.

Example:

adv_confirmation
→ adv_confirmation_v2

---

## Step 6

Parameter Mapping

Read template variables automatically.

Example Template:

Hello {{1}}

Your workshop date is {{2}}

Join here:
{{3}}

System extracts:

1
2
3

Display mapping interface.

Example:

Parameter 1 → Name

Parameter 2 → Workshop Date

Parameter 3 → Group Link

Auto-match CSV headers when possible.

Allow manual correction.

---

## Step 7

Validation Engine

Before scheduling:

Validate:

### Template Exists

All selected numbers must have mapped template.

### Parameter Count

Template variable count must match mapping count.

### CSV Headers

Required columns must exist.

### Phone Numbers

All phone numbers must be valid.

Show all validation errors before allowing scheduling.

---

# Campaign Scheduling

User enters:

* Campaign Name
* Schedule Date
* Schedule Time

Campaign status:

Draft

Scheduled

Running

Completed

Failed

Cancelled

Use EventBridge Scheduler for campaign execution.

Each campaign generates a unique Campaign ID.

---

# Sending Engine

Broadcast messages using multiple WhatsApp numbers.

Implement Round Robin distribution.

Example:

10,000 contacts

Number A = 3,333

Number B = 3,333

Number C = 3,334

Distribution must be automatic.

Do not send all messages from one number.

---

# Campaign Tracking

Track:

* Total Contacts
* Sent
* Delivered
* Read
* Failed
* Replies

Store Meta Message IDs.

Store status updates received from webhooks.

---

# Reply Tracking

No inbox required.

Only track:

Reply Received = Yes / No

Dashboard Example:

Total Contacts: 10,000

Sent: 9,980

Delivered: 9,850

Read: 7,200

Replies: 356

Failed: 130

---

# Duplicate Campaign Feature

Every campaign must have a Duplicate action.

When user clicks Duplicate:

Copy:

* Business
* Selected Numbers
* Template Mapping
* CSV Configuration
* Parameter Mapping

Do NOT copy:

* Campaign Status
* Campaign Results
* Delivery Data

Create a new Draft Campaign.

User can modify:

* CSV
* Template
* Schedule Date
* Schedule Time

before launching.

---

# Campaign Details Page

Display:

Campaign Information

Business

Selected Numbers

Schedule Time

Template Used

CSV File

Status Metrics

Charts:

Sent

Delivered

Read

Replies

Failed

Recent Activity Log

---

# Retry Failed Messages

Provide:

Retry Failed Messages

System should:

* Identify failed contacts
* Re-send only failed contacts
* Create retry batch
* Track separately

---

# Template Sync

Create background sync process.

Run daily.

Fetch latest templates from Meta.

Store in database.

Avoid fetching templates every time user opens campaign creation.

---

# File Storage

Store uploaded CSV files in S3.

Maintain campaign-to-file mapping.

Allow CSV download from campaign details page.

---

# Architecture

Frontend

* Next.js
* TypeScript
* Tailwind CSS

Backend

* API Gateway
* AWS Lambda

Database

* DynamoDB

Storage

* Amazon S3

Scheduling

* Amazon EventBridge Scheduler

Webhooks

* Meta Webhook
* Lambda Processor

Authentication

* Amazon Cognito

---

# Non Functional Requirements

* Fully serverless
* Multi-business support
* Multi-number support
* Scalable to 100,000+ contacts per campaign
* Secure token storage
* Audit logging
* Fast CSV validation
* Responsive UI
* Mobile-friendly dashboard

---

# Future Phases (Do Not Build Yet)

Phase 2

* Campaign templates
* Approval workflow
* Contact lists
* Audience segmentation
* Scheduled recurring campaigns

Phase 3

* Email campaigns
* SMS campaigns
* Unified communication dashboard

Phase 4

* AI campaign recommendations
* AI template mapping
* Predictive delivery analytics
