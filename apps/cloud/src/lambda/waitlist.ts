/**
 * AWS Lambda entry point for the waitlist.
 *
 * This lives in the public repository on purpose: it is product code, it is
 * covered by the tests next to `waitlist.ts`, and it makes no sense to hide. The
 * private repository holds the *deployment* (buckets, distribution, table), not
 * the function's logic.
 *
 * The AWS SDK is not bundled: `@aws-sdk/client-dynamodb` is present in the Node
 * 22 Lambda runtime, and shipping a second copy would add weight to every cold
 * start for no benefit.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createWaitlistHandler, DynamoWaitlistStore, type WaitlistStore } from '../waitlist.js';

const TABLE = process.env['WAITLIST_TABLE'];

if (TABLE === undefined || TABLE.length === 0) {
  // Fail at cold start with a clear message rather than at the first signup, when
  // nobody is watching and the visitor just sees a 503.
  throw new Error('WAITLIST_TABLE is not set; refusing to start rather than dropping every signup');
}

const client = new DynamoDBClient({});

const store: WaitlistStore = new DynamoWaitlistStore(TABLE, client, {
  PutItemCommand: PutItemCommand as unknown as new (input: unknown) => unknown,
  ConditionalCheckFailedException: Error as unknown as new (...args: never[]) => Error,
});

export const handler = createWaitlistHandler({
  store,
  allowedOrigin: process.env['ALLOWED_ORIGIN'] ?? 'null',
  // Set by the deployment. Without it the Function URL would be an open write,
  // which is why the stack always sets it.
  ...(process.env['ORIGIN_VERIFY_SECRET'] !== undefined ? { originSecret: process.env['ORIGIN_VERIFY_SECRET'] } : {}),
});
