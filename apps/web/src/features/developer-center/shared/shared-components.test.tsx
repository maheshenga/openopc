import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeveloperModuleManifestView } from './module-manifest-view';
import { DeveloperModuleRequirements } from './module-requirements';
import { DeveloperModuleStatusBadge } from './module-status-badge';
import { DeveloperModuleReviewTimeline } from './review-timeline';

describe('Developer Center shared views', () => {
  test('renders stable status and requirement labels', () => {
    const html = renderToStaticMarkup(
      <>
        <DeveloperModuleStatusBadge status="review_pending" />
        <DeveloperModuleRequirements requirements={['manifest_review', 'human_review']} />
      </>,
    );

    expect(html).toContain('Review pending');
    expect(html).toContain('Manifest review');
    expect(html).toContain('Human review');
  });

  test('renders structured permissions and escaped raw JSON', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleManifestView
        manifest={{
          id: 'acme.module',
          permissions: { network: ['https://api.example.test'] },
          unsafe: '<script>',
        }}
      />,
    );

    expect(html).toContain('acme.module');
    expect(html).toContain('https://api.example.test');
    expect(html).not.toContain('<script>');
  });

  test('renders immutable events without privileged actions', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleReviewTimeline
        events={[
          {
            review_event_id: '1',
            action: 'submit',
            from_status: 'validated',
            to_status: 'review_pending',
            actor_kind: 'publisher',
            actor_user_id: 'user',
            reason: null,
            evidence: [],
            created_at: '2026-07-24T00:00:00.000Z',
            release_id: 'release',
            account_id: 'account',
            sequence: 1,
          } as never,
        ]}
      />,
    );

    expect(html).toContain('Submitted for review');
    expect(html).toContain('Publisher');
    expect(html).not.toContain('Approve');
  });
});
