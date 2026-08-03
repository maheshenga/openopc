import type { DeveloperAccess, DeveloperPublisherMember } from '@kortix/sdk';

export type SelectableDeveloperPublisher = DeveloperAccess['publishers'][number] & {
  membership: DeveloperPublisherMember;
};

export interface DeveloperPublisherSelection {
  accountId: string | null;
  publisherId: string;
}

export function publisherSelectionChanged(
  current: DeveloperPublisherSelection,
  next: DeveloperPublisherSelection,
): boolean {
  return current.accountId !== next.accountId || current.publisherId !== next.publisherId;
}

export function selectableDeveloperPublishers(
  access: DeveloperAccess | null | undefined,
): SelectableDeveloperPublisher[] {
  return (access?.publishers ?? []).filter(
    (entry): entry is SelectableDeveloperPublisher =>
      entry.publisher.status === 'active' && entry.membership?.role === 'owner',
  );
}

export function reconcilePublisherSelection(
  current: DeveloperPublisherSelection,
  accountId: string | null,
  access: DeveloperAccess | null | undefined,
): DeveloperPublisherSelection {
  const options = selectableDeveloperPublishers(
    access?.account_id === accountId ? access : undefined,
  );
  const currentIsValid =
    current.accountId === accountId &&
    options.some((entry) => entry.publisher.publisher_id === current.publisherId);
  if (currentIsValid) return current;
  return {
    accountId,
    publisherId: options.length === 1 ? (options[0]?.publisher.publisher_id ?? '') : '',
  };
}
