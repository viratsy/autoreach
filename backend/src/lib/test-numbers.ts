import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./dynamo";

const CONFIG_TABLE = process.env.WORKSHOP_CONFIG_TABLE || "autoreach-workshop-config-hardik";

/**
 * QA/team numbers that get auto-included in every Crossale and
 * current-batch-scheduler audience — one shared list per AWS account.
 *
 * Stored under its own settings key rather than as a field on a workshop
 * config item. It used to hang off WSCONFIG#__DEFAULT__/CYCLE#0, which meant
 * retiring the default workshop config silently took the QA numbers with it.
 * SETTINGS#TEST_NUMBERS belongs to nothing else, so it can't be collateral
 * damage again, and it never appears in the workshop picker.
 */
export const TEST_NUMBERS_KEY = { PK: "SETTINGS#TEST_NUMBERS", SK: "GLOBAL" };

export interface TestNumber {
  name: string;
  phone: string;
}

export async function getTestNumbers(): Promise<TestNumber[]> {
  const result = await docClient.send(
    new GetCommand({ TableName: CONFIG_TABLE, Key: TEST_NUMBERS_KEY })
  );
  return (result.Item?.testNumbers as TestNumber[] | undefined) || [];
}
