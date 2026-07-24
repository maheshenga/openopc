import type {
  DeveloperModuleReviewAction,
  DeveloperModuleReviewActorKind,
  DeveloperModuleReviewEvent,
} from '@kortix/sdk';

const ACTION_LABELS: Record<DeveloperModuleReviewAction, string> = {
  submit: 'Submitted for review',
  resubmit: 'Resubmitted for review',
  request_changes: 'Changes requested',
  approve: 'Approved',
  revoke: 'Emergency revoke',
};

const ACTOR_LABELS: Record<DeveloperModuleReviewActorKind, string> = {
  publisher: 'Publisher',
  platform_admin: 'Platform administrator',
};

function eventDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString();
}

export function DeveloperModuleReviewTimeline({
  events,
}: {
  events: readonly DeveloperModuleReviewEvent[];
}) {
  return (
    <section aria-label="Review history" className="space-y-3">
      <h3 className="text-sm font-semibold">Review history</h3>
      {events.length > 0 ? (
        <ol className="space-y-3">
          {events.map((event) => (
            <li key={event.review_event_id} className="border-l-2 border-border pl-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-medium">{ACTION_LABELS[event.action]}</span>
                <span className="text-muted-foreground">by {ACTOR_LABELS[event.actor_kind]}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {eventDate(event.created_at)} · {event.from_status} to {event.to_status}
              </p>
              {event.reason ? <p className="mt-2 text-sm">{event.reason}</p> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No review history yet.</p>
      )}
    </section>
  );
}
