import { PhoneNumber } from "./types";
import { TIER_CAPS } from "./round-robin";

/** Default safe sustained pace per number — matches send-worker.ts's MSGS_PER_SECOND
 * default (300/min, bumped from 90/min after real campaign data showed numbers only
 * start hitting Meta's own rate-limit errors around 7-18/sec — 5/sec leaves headroom
 * below that). This is a real enforced ceiling (see send.ts/send-worker.ts's FIFO
 * per-number serialization), not just a nominal config value, so this planning math
 * actually reflects what a campaign will do. */
export const DEFAULT_SAFE_MSGS_PER_SECOND = 5;

// Planning is advisory and should be conservative — unlike round-robin.ts's actual
// distribution logic (which intentionally fails open with Infinity for an unknown
// tier so it never blocks a real send), a capacity *estimate* for a number that's
// never been quality-checked should assume the smallest tier rather than pretend
// it's unconstrained.
const CONSERVATIVE_DEFAULT_TIER_CAP = TIER_CAPS.TIER_50;

export interface CapacityEstimate {
  /** Minutes to deliver totalContacts with the numbers actually provided. */
  estimatedMinutes: number;
  /** Numbers needed to hit opts.targetMinutes, if provided. */
  numbersNeededForTarget?: number;
  /** Sum of each number's cached 24h tier cap (unknown tiers counted conservatively). */
  aggregateDailyCapacity: number;
  /** True if totalContacts exceeds what the selected numbers can safely carry in 24h. */
  exceedsAggregateCapacity: boolean;
}

export function estimateCapacity(
  totalContacts: number,
  numbers: Pick<PhoneNumber, "messagingLimit">[],
  opts?: { targetMinutes?: number; safeMsgsPerSecondPerNumber?: number }
): CapacityEstimate {
  const pace = opts?.safeMsgsPerSecondPerNumber ?? DEFAULT_SAFE_MSGS_PER_SECOND;
  const numberCount = numbers.length;

  const estimatedMinutes =
    numberCount === 0 || totalContacts === 0
      ? 0
      : totalContacts / (pace * numberCount * 60);

  const numbersNeededForTarget =
    opts?.targetMinutes && opts.targetMinutes > 0
      ? Math.max(1, Math.ceil(totalContacts / (pace * opts.targetMinutes * 60)))
      : undefined;

  const aggregateDailyCapacity = numbers.reduce((sum, n) => {
    const cap = n.messagingLimit ? TIER_CAPS[n.messagingLimit] ?? CONSERVATIVE_DEFAULT_TIER_CAP : CONSERVATIVE_DEFAULT_TIER_CAP;
    return sum + cap;
  }, 0);

  return {
    estimatedMinutes,
    numbersNeededForTarget,
    aggregateDailyCapacity,
    exceedsAggregateCapacity: totalContacts > aggregateDailyCapacity,
  };
}
