import { describe, expect, test } from 'bun:test';
import { StudioProviderCallError } from '@kortix/studio-runtime';
import sharp from 'sharp';
import { assertOpenAiCompatibleOutputBudget, parseOpenAiCompatibleImageResponse } from './response';

async function imageBytes(format: 'png' | 'jpeg' | 'webp'): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 4,
        background: { r: 20, g: 40, b: 60, alpha: 1 },
      },
    })
      [format]()
      .toBuffer(),
  );
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe('OpenAI-compatible image response', () => {
  test('returns detected PNG, JPEG, and WebP base64 assets with fresh replay streams', async () => {
    const fixtures = await Promise.all([imageBytes('png'), imageBytes('jpeg'), imageBytes('webp')]);
    const result = await parseOpenAiCompatibleImageResponse({
      response: jsonResponse({
        data: fixtures.map((bytes) => ({ b64_json: Buffer.from(bytes).toString('base64') })),
      }),
      expectedOutputCount: 3,
    });

    expect(result.assets.map((asset) => asset.mime_type)).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
    expect(result.assets.map((asset) => asset.filename)).toEqual([
      'studio-image-1.png',
      'studio-image-2.jpg',
      'studio-image-3.webp',
    ]);
    for (const [index, asset] of result.assets.entries()) {
      expect(asset.size_bytes).toBe(fixtures[index]?.byteLength);
      expect(asset.replayable_within_attempt).toBe(true);
      const first = await readAll(await asset.openBody());
      const second = await readAll(await asset.openBody());
      expect(first).toEqual(fixtures[index]);
      expect(second).toEqual(fixtures[index]);
      expect(first).not.toBe(second);
    }
    expect(result.usage).toBeUndefined();
  });

  test('validates URL output initially and refetches identical bytes only before signed expiry', async () => {
    const bytes = await imageBytes('png');
    let now = Date.parse('2026-07-16T08:00:00.000Z');
    let fetches = 0;
    const expires = Math.floor((now + 60_000) / 1_000);
    const result = await parseOpenAiCompatibleImageResponse({
      response: jsonResponse({
        data: [{ url: `https://assets.example.test/output.png?expires=${expires}&sig=opaque` }],
      }),
      expectedOutputCount: 1,
      now: () => now,
      fetchOutput: async () => {
        fetches += 1;
        return new Response(bytes.slice(), { headers: { 'content-type': 'image/png' } });
      },
    });

    expect(fetches).toBe(1);
    const asset = result.assets[0];
    expect(asset).toMatchObject({
      filename: 'studio-image-1.png',
      mime_type: 'image/png',
      size_bytes: bytes.byteLength,
      replayable_within_attempt: true,
    });
    expect(await readAll(await asset?.openBody())).toEqual(bytes);
    expect(fetches).toBe(2);

    now += 61_000;
    await expect(asset?.openBody()).rejects.toMatchObject({
      classification: 'unknown_outcome',
      message: 'STUDIO_PROVIDER_OUTPUT_UNAVAILABLE',
    });
    expect(fetches).toBe(2);
  });

  test('rejects malformed JSON shapes, count mismatch, and ambiguous output items', async () => {
    const invalidResponses = [
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      jsonResponse([]),
      jsonResponse({ data: 'not-an-array' }),
      jsonResponse({ data: [] }),
      jsonResponse({ data: [{}] }),
      jsonResponse({ data: [{ b64_json: 'AAAA', url: 'https://assets.example.test/a' }] }),
    ];
    for (const response of invalidResponses) {
      await expect(
        parseOpenAiCompatibleImageResponse({ response, expectedOutputCount: 1 }),
      ).rejects.toMatchObject({ classification: 'terminal', message: 'STUDIO_ASSET_INVALID' });
    }
  });

  test('strictly rejects permissive base64, non-image bytes, and URL MIME mismatch', async () => {
    for (const encoded of ['AAAA===', 'a Gk=', '!!!!', Buffer.from('<svg/>').toString('base64')]) {
      await expect(
        parseOpenAiCompatibleImageResponse({
          response: jsonResponse({ data: [{ b64_json: encoded }] }),
          expectedOutputCount: 1,
        }),
      ).rejects.toMatchObject({ classification: 'terminal', message: 'STUDIO_ASSET_INVALID' });
    }

    const bytes = await imageBytes('png');
    const expires = Math.floor(Date.now() / 1_000) + 60;
    await expect(
      parseOpenAiCompatibleImageResponse({
        response: jsonResponse({
          data: [{ url: `https://assets.example.test/output?expires=${expires}` }],
        }),
        expectedOutputCount: 1,
        fetchOutput: async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }),
      }),
    ).rejects.toMatchObject({ classification: 'terminal', message: 'STUDIO_ASSET_INVALID' });
  });

  test('rejects output URL schemes and userinfo before any fetch', async () => {
    let fetches = 0;
    const expires = Math.floor(Date.now() / 1_000) + 60;
    for (const url of [
      `ftp://assets.example.test/output?expires=${expires}`,
      `https://user:password@assets.example.test/output?expires=${expires}`,
    ]) {
      await expect(
        parseOpenAiCompatibleImageResponse({
          response: jsonResponse({ data: [{ url }] }),
          expectedOutputCount: 1,
          fetchOutput: async () => {
            fetches += 1;
            return new Response(await imageBytes('png'), {
              headers: { 'content-type': 'image/png' },
            });
          },
        }),
      ).rejects.toMatchObject({ classification: 'terminal', message: 'STUDIO_ASSET_INVALID' });
    }
    expect(fetches).toBe(0);
  });

  test('enforces JSON, single-image, and total-output byte ceilings', async () => {
    const oneMiB = new Uint8Array(1024 * 1024);
    let chunks = 0;
    await expect(
      parseOpenAiCompatibleImageResponse({
        response: new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (chunks < 129) {
                chunks += 1;
                controller.enqueue(oneMiB);
              } else {
                controller.close();
              }
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
        expectedOutputCount: 1,
      }),
    ).rejects.toMatchObject({ classification: 'terminal', message: 'STUDIO_ASSET_TOO_LARGE' });

    const tooLarge = Buffer.alloc(32 * 1024 * 1024 + 1).toString('base64');
    await expect(
      parseOpenAiCompatibleImageResponse({
        response: jsonResponse({ data: [{ b64_json: tooLarge }] }),
        expectedOutputCount: 1,
      }),
    ).rejects.toMatchObject({ classification: 'terminal', message: 'STUDIO_ASSET_TOO_LARGE' });

    expect(() =>
      assertOpenAiCompatibleOutputBudget([
        32 * 1024 * 1024,
        32 * 1024 * 1024,
        32 * 1024 * 1024,
        32 * 1024 * 1024,
        1,
      ]),
    ).toThrow('STUDIO_ASSET_TOO_LARGE');
  });

  test('detects changed URL content on replay without exposing the signed URL', async () => {
    const first = await imageBytes('png');
    const changed = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 4,
        background: { r: 200, g: 10, b: 5, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    let fetches = 0;
    const expires = Math.floor(Date.now() / 1_000) + 60;
    const result = await parseOpenAiCompatibleImageResponse({
      response: jsonResponse({
        data: [{ url: `https://assets.example.test/private.png?expires=${expires}&secret=query` }],
      }),
      expectedOutputCount: 1,
      fetchOutput: async () => {
        fetches += 1;
        return new Response(fetches === 1 ? first : changed, {
          headers: { 'content-type': 'image/png' },
        });
      },
    });

    let error: unknown;
    try {
      await result.assets[0]?.openBody();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StudioProviderCallError);
    expect(error).toMatchObject({
      classification: 'unknown_outcome',
      message: 'STUDIO_PROVIDER_OUTPUT_CHANGED',
    });
    expect(String(error)).not.toContain('assets.example.test');
    expect(String(error)).not.toContain('secret=query');
  });
});
