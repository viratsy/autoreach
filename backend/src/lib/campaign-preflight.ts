import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { filterNumbersWithImageHeader } from "./reengagement-contacts";

const s3 = new S3Client({});

/**
 * The checks that decide whether an unattended campaign is safe to schedule
 * without a human looking at it first.
 *
 * Context for why this exists at all: the current-batch scheduler used to
 * create every campaign as a draft so someone would confirm it. In practice
 * nobody confirmed the early ones — the 08:00 run key sat unapproved 17 times
 * in a row — and 72 expired drafts covering 91,244 recipients were never sent.
 * The gate was costing far more than it saved.
 *
 * But it WAS saving something. On 2026-09-17 a campaign went out pointing at a
 * header image the S3 lifecycle rule had deleted, and all 655 of its messages
 * failed. So the answer is not "stop checking", it is "check the things that
 * actually break, automatically, and only involve a human when one of them
 * fails".
 *
 * Every check here is a known production failure mode, not a hypothetical.
 */
export interface PreflightIssue {
  code: "image_missing" | "image_required_but_absent";
  detail: string;
}

export interface PreflightInput {
  businessId: string;
  templateName: string;
  /** Numbers the campaign will actually send from. */
  phoneNumberIds: string[];
  /** The header image the config wants to send, if any. */
  headerImageUrl?: string;
  csvBucket: string;
}

/** Turns a CloudFront/S3 URL into the object key it refers to. */
export function s3KeyFromUrl(url: string): string {
  const afterHost = url.includes(".net/") ? url.split(".net/", 2)[1] : url;
  try {
    return decodeURIComponent(afterHost);
  } catch {
    // A malformed escape sequence shouldn't crash the whole run — fall back to
    // the raw path and let the existence check decide.
    return afterHost;
  }
}

export async function preflightCampaign(input: PreflightInput): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const url = (input.headerImageUrl || "").trim();

  // 1. The image the config points at must still exist.
  //
  // Meta fetches header media over public HTTPS at send time. If the object is
  // gone it cannot, and EVERY message fails — error 131053 when the send was
  // accepted first, or an outright rejection when it wasn't. The old lifecycle
  // rule deleted images/ after 30 days, which is how a 40-day-old image was
  // still referenced by a live config. The rule is fixed, but 42 dead
  // references survive it across both accounts.
  if (url) {
    const key = s3KeyFromUrl(url);
    try {
      await s3.send(new HeadObjectCommand({ Bucket: input.csvBucket, Key: key }));
    } catch {
      issues.push({
        code: "image_missing",
        detail: `header image no longer exists in S3 (${key}) — every message would fail`,
      });
    }
  }

  // 2. A template that HAS an image header must be given one.
  //
  // The inverse of the bug fixed in the schedulers on 2026-09-19. There, numbers
  // whose copy had no header slot were being sent an image. Here, a number whose
  // copy DOES have an image header is sent nothing — Meta rejects that with
  // 131008 "required parameter is missing". Only reachable when a config has no
  // headerImageUrl at all, so it is checked independently of the image above.
  if (!url) {
    const needImage = await filterNumbersWithImageHeader(
      input.businessId,
      input.templateName,
      input.phoneNumberIds
    );
    if (needImage.length > 0) {
      issues.push({
        code: "image_required_but_absent",
        detail:
          `${needImage.length} of ${input.phoneNumberIds.length} numbers have "${input.templateName}" ` +
          `approved WITH an image header, but the config supplies no image — those sends would be rejected`,
      });
    }
  }

  return issues;
}
