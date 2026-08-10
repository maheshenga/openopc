import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { createStudioImageThumbnail, validateStudioImage } from './image';

async function imageBytes(format: 'png' | 'jpeg' | 'webp') {
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

describe('validateStudioImage', () => {
  test.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ] as const)('accepts bounded %s bytes whose MIME matches magic', async (format, mimeType) => {
    const bytes = await imageBytes(format);

    await expect(validateStudioImage({ bytes, mimeType })).resolves.toEqual({
      mimeType,
      width: 2,
      height: 3,
      sizeBytes: bytes.byteLength,
    });
  });

  test('rejects MIME and magic mismatches', async () => {
    const bytes = await imageBytes('png');

    await expect(validateStudioImage({ bytes, mimeType: 'image/jpeg' })).rejects.toMatchObject({
      code: 'STUDIO_ASSET_INVALID',
    });
  });

  test.each([
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['XML', '<?xml version="1.0"?><image/>'],
    ['HTML', '<!doctype html><html><body>not an image</body></html>'],
  ])('rejects %s markup before image decoding', async (_name, source) => {
    await expect(
      validateStudioImage({ bytes: new TextEncoder().encode(source), mimeType: 'image/png' }),
    ).rejects.toMatchObject({ code: 'STUDIO_ASSET_INVALID' });
  });

  test('rejects unsupported image types', async () => {
    const gif = new TextEncoder().encode('GIF89a');
    await expect(validateStudioImage({ bytes: gif, mimeType: 'image/gif' })).rejects.toMatchObject({
      code: 'STUDIO_ASSET_INVALID',
    });
  });

  test('rejects a single encoded image above 32 MiB before decoding', async () => {
    const bytes = new Uint8Array(32 * 1024 * 1024 + 1);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);

    await expect(validateStudioImage({ bytes, mimeType: 'image/png' })).rejects.toMatchObject({
      code: 'STUDIO_ASSET_TOO_LARGE',
    });
  });

  test('creates a bounded WebP thumbnail without enlarging the source', async () => {
    const bytes = await imageBytes('png');
    const thumbnail = await createStudioImageThumbnail({
      bytes,
      mimeType: 'image/png',
      maxDimension: 256,
    });

    expect(thumbnail).toMatchObject({ mimeType: 'image/webp', width: 2, height: 3 });
    expect(thumbnail.bytes.byteLength).toBeGreaterThan(0);
    await expect(
      validateStudioImage({ bytes: thumbnail.bytes, mimeType: thumbnail.mimeType }),
    ).resolves.toMatchObject({ width: 2, height: 3 });
  });

  test('rejects dimensions above 16,384 pixels', async () => {
    await expect(
      validateStudioImage({
        bytes: jpegWithDimensions(16_385, 1),
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_ASSET_TOO_LARGE' });
  });

  test('rejects decoded pixel counts above 100 million', async () => {
    await expect(
      validateStudioImage({
        bytes: jpegWithDimensions(10_001, 10_000),
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_ASSET_TOO_LARGE' });
  });
});

function jpegWithDimensions(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x0c,
    0x03,
    0x01,
    0x00,
    0x02,
    0x11,
    0x03,
    0x11,
    0x00,
    0x3f,
    0x00,
    0x00,
    0xff,
    0xd9,
  ]);
}
