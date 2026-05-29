import { PhoneNumber, CSVContact } from "./types";

export interface DistributedContact {
  contact: CSVContact;
  assignedNumber: PhoneNumber;
}

/**
 * Distribute contacts evenly across sending numbers using round-robin.
 * Example: 10,000 contacts across 3 numbers = ~3,333 each.
 */
export function distributeContacts(
  contacts: CSVContact[],
  numbers: PhoneNumber[]
): DistributedContact[] {
  if (numbers.length === 0) {
    throw new Error("At least one sending number is required");
  }

  return contacts.map((contact, index) => ({
    contact,
    assignedNumber: numbers[index % numbers.length],
  }));
}

/**
 * Get distribution summary for preview.
 */
export function getDistributionSummary(
  totalContacts: number,
  numbers: PhoneNumber[]
): { phoneNumberId: string; displayNumber: string; count: number }[] {
  const base = Math.floor(totalContacts / numbers.length);
  const remainder = totalContacts % numbers.length;

  return numbers.map((number, index) => ({
    phoneNumberId: number.phoneNumberId,
    displayNumber: number.displayNumber,
    count: base + (index < remainder ? 1 : 0),
  }));
}
