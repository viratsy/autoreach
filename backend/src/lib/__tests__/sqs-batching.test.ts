import { chunkForSQSBatch, SQS_MAX_BATCH_COUNT, SQS_MAX_BATCH_BYTES } from "../sqs-batching";

describe("chunkForSQSBatch", () => {
  it("chunks by count when entries are small", () => {
    const entries = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunkForSQSBatch(entries, () => 10);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(chunks.flat()).toEqual(entries);
  });

  it("reproduces the real production failure: 10 count-sized entries that exceed the byte cap must split further", () => {
    // Mirrors the real incident: 156 batches, one 10-entry chunk totaled
    // 1,404,681 bytes against the 1,048,576 hard limit.
    const bytesPerEntry = 150_000; // 10 of these = 1,500,000 > SQS_MAX_BATCH_BYTES
    const entries = Array.from({ length: 10 }, (_, i) => i);
    const chunks = chunkForSQSBatch(entries, () => bytesPerEntry);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const totalBytes = chunk.length * bytesPerEntry;
      expect(totalBytes).toBeLessThanOrEqual(SQS_MAX_BATCH_BYTES);
      expect(chunk.length).toBeLessThanOrEqual(SQS_MAX_BATCH_COUNT);
    }
  });

  it("never exceeds the byte cap even with a single huge entry (lets it through alone rather than dropping it)", () => {
    const entries = [1_200_000]; // bigger than the cap itself
    const chunks = chunkForSQSBatch(entries, (e) => e);
    expect(chunks).toEqual([[1_200_000]]);
  });

  it("packs variable-size entries efficiently without exceeding either cap", () => {
    const sizes = [400_000, 400_000, 400_000, 10_000, 10_000];
    const chunks = chunkForSQSBatch(sizes, (s) => s);
    for (const chunk of chunks) {
      const totalBytes = chunk.reduce((sum, s) => sum + s, 0);
      expect(totalBytes).toBeLessThanOrEqual(SQS_MAX_BATCH_BYTES);
      expect(chunk.length).toBeLessThanOrEqual(SQS_MAX_BATCH_COUNT);
    }
    expect(chunks.flat()).toEqual(sizes);
  });

  it("returns no chunks for an empty input", () => {
    expect(chunkForSQSBatch([], () => 0)).toEqual([]);
  });
});
