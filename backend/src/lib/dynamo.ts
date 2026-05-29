import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLES = {
  BUSINESSES: process.env.BUSINESSES_TABLE!,
  CAMPAIGNS: process.env.CAMPAIGNS_TABLE!,
  MESSAGES: process.env.MESSAGES_TABLE!,
  TEMPLATES: process.env.TEMPLATES_TABLE!,
};
