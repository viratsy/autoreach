// SendMessageBatch caps out at BOTH 10 entries AND 1,048,576 total bytes.
// Chunking by count alone silently blows past the byte cap on large
// campaigns (rich per-contact params easily push 10×200-contact batches
// over 1MB), which throws BatchRequestTooLong and aborts before a single
// message is queued — this is what happened to a real 30,702-contact
// campaign (12 numbers, 156 batches) whose single 10-entry chunk totaled
// 1,404,681 bytes.
export const SQS_MAX_BATCH_COUNT = 10;
export const SQS_MAX_BATCH_BYTES = 950_000; // safety margin under the 1,048,576 hard limit

/** Splits entries into chunks that respect both the count and byte-size caps. */
export function chunkForSQSBatch<T>(entries: T[], getBytes: (entry: T) => number): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let chunkBytes = 0;

  for (const entry of entries) {
    const entryBytes = getBytes(entry);
    if (chunk.length >= SQS_MAX_BATCH_COUNT || (chunk.length > 0 && chunkBytes + entryBytes > SQS_MAX_BATCH_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(entry);
    chunkBytes += entryBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);

  return chunks;
}
