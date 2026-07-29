import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import { buildTeamsManifest } from '../channels/teams-manifest';

describe('buildTeamsManifest', () => {
  test('declares the bot with the app id and derives validDomains from the base url', () => {
    const m = buildTeamsManifest({ appId: 'app-123', baseUrl: 'https://api.kortix.com' });
    expect(m.id).toBe('app-123');
    expect(m.bots[0]!.botId).toBe('app-123');
    expect(m.bots[0]!.scopes).toEqual(['personal', 'team', 'groupchat']);
    expect(m.validDomains).toEqual(['api.kortix.com']);
    expect(m.manifestVersion).toBe('1.16');
  });

  test('presents OpenOPC in every user-visible manifest field', () => {
    const m = buildTeamsManifest({
      appId: 'app-123',
      baseUrl: 'https://api.kortix.com',
      appName: 'Kortix',
    });
    const visibleCopy = [
      m.developer.name,
      m.name.short,
      m.name.full,
      m.description.short,
      m.description.full,
      ...m.bots.flatMap((bot) =>
        (bot.commandLists ?? []).flatMap((list) =>
          list.commands.flatMap((command) => [command.title, command.description]),
        ),
      ),
    ];

    expect(m.developer.name).toBe('OpenOPC');
    expect(m.name).toEqual({ short: 'OpenOPC', full: 'OpenOPC' });
    expect(visibleCopy.every((value) => !value.includes('Kortix'))).toBe(true);
    expect(m.validDomains).toEqual(['api.kortix.com']);
  });

  test('keeps the committed Teams manifest synchronized with the builder', () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'channels', 'teams-app-manifest.json'), 'utf8'),
    );
    const baseUrl = `https://${committed.validDomains[0]}`;

    expect(committed).toEqual(buildTeamsManifest({ appId: committed.id, baseUrl }));
  });
});

mock.module('../config', () => ({ config: { MICROSOFT_APP_ID: 'app-123', MICROSOFT_APP_PASSWORD: 'secret', TEAMS_CHANNEL_ENABLED: true } }));
const { teamsMode } = await import('../channels/teams-mode');

describe('teamsMode', () => {
  test('available → exposes the messaging endpoint and admin-consent url', () => {
    const mode = teamsMode('https://api.kortix.com/');
    expect(mode.available).toBe(true);
    expect(mode.appId).toBe('app-123');
    expect(mode.messagingEndpoint).toBe('https://api.kortix.com/v1/webhooks/teams/messages');
    expect(mode.adminConsentUrl).toContain('client_id=app-123');
  });
});
