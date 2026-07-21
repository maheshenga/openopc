import { randomUUID } from 'node:crypto';

export interface EvidenceStore {
  put(input: { reference: string; contentType: string; body: Uint8Array }): Promise<void>;
}

export function createEvidenceWriter(store: EvidenceStore, maxBytes = 1_000_000) {
  return {
    async write(contentType: string, body: Uint8Array): Promise<string> {
      if (body.byteLength > maxBytes) throw new Error('evidence exceeds size limit');
      const reference = `evidence:${randomUUID()}`;
      await store.put({ reference, contentType, body });
      return reference;
    },
  };
}
