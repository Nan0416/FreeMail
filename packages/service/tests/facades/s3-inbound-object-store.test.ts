import { PutObjectTaggingCommand, type S3Client } from '@aws-sdk/client-s3';
import { INBOUND_INGESTED_TAG } from '@freemail/shared/storage';
import { describe, expect, it } from 'vitest';
import { S3InboundObjectStore } from '../../src/facades/s3-inbound-object-store.js';

class FakeS3 {
  readonly calls: PutObjectTaggingCommand[] = [];
  send(command: PutObjectTaggingCommand): Promise<unknown> {
    this.calls.push(command);
    return Promise.resolve({});
  }
}

describe('S3InboundObjectStore.markIngested', () => {
  it('sets exactly the tag the lifecycle rule expires on', async () => {
    const fake = new FakeS3();
    const store = new S3InboundObjectStore(fake as unknown as S3Client, 'mail-bucket');

    await store.markIngested('inbound/MSG1');

    expect(fake.calls[0]).toBeInstanceOf(PutObjectTaggingCommand);
    expect(fake.calls[0]?.input).toEqual({
      Bucket: 'mail-bucket',
      Key: 'inbound/MSG1',
      Tagging: { TagSet: [{ Key: INBOUND_INGESTED_TAG.key, Value: INBOUND_INGESTED_TAG.value }] },
    });
  });
});
