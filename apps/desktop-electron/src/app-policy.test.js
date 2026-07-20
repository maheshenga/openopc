const { describe, expect, test } = require('bun:test');

const { downloadFromWebContents, normalizeDownloadUrl, shouldLoadInApp } = require('./app-policy');

describe('desktop app navigation policy', () => {
  test('keeps project Image Studio routes inside the Kortix window', () => {
    expect(shouldLoadInApp('https://kortix.com/projects/project-1/studio/image')).toBe(true);
    expect(
      shouldLoadInApp('https://dev.kortix.com/projects/project-1/studio/image?task=task-1'),
    ).toBe(true);
    expect(shouldLoadInApp('http://localhost:3000/projects/project-1/studio/image')).toBe(true);
  });

  test('keeps marketing and provider OAuth navigations outside the app window', () => {
    expect(shouldLoadInApp('https://kortix.com/pricing')).toBe(false);
    expect(shouldLoadInApp('https://supa.kortix.com/auth/v1/authorize?provider=github')).toBe(
      false,
    );
  });
});

describe('desktop native download policy', () => {
  test('allows HTTPS and loopback HTTP asset URLs', () => {
    expect(
      normalizeDownloadUrl('https://assets.example.test/object.png?signature=short-lived'),
    ).toBe('https://assets.example.test/object.png?signature=short-lived');
    expect(normalizeDownloadUrl('http://localhost:54321/storage/object.png')).toBe(
      'http://localhost:54321/storage/object.png',
    );
    expect(normalizeDownloadUrl('http://127.0.0.1:54321/storage/object.png')).toBe(
      'http://127.0.0.1:54321/storage/object.png',
    );
    expect(normalizeDownloadUrl('http://[::1]:54321/storage/object.png')).toBe(
      'http://[::1]:54321/storage/object.png',
    );
  });

  test('rejects credentials, remote HTTP, dangerous schemes, and malformed URLs', () => {
    const rejected = [
      'https://user:secret@assets.example.test/object.png',
      'http://assets.example.test/object.png',
      'file:///tmp/private.txt',
      'data:text/plain,private',
      'javascript:alert(1)',
      'not a URL',
    ];

    for (const url of rejected) {
      expect(normalizeDownloadUrl(url)).toBeNull();
    }
  });

  test('starts valid downloads on the requesting WebContents only', () => {
    const downloads = [];
    const webContents = { downloadURL: (url) => downloads.push(url) };
    const signedUrl = 'https://assets.example.test/object.png?signature=short-lived';

    downloadFromWebContents(webContents, signedUrl);

    expect(downloads).toEqual([signedUrl]);
    expect(() => downloadFromWebContents(webContents, 'file:///tmp/private.txt')).toThrow(
      'Invalid download URL',
    );
    expect(downloads).toEqual([signedUrl]);
  });
});
