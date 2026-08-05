'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import type { SelectableDeveloperPublisher } from './access';

interface DeveloperPublisherSelectProps {
  id: string;
  publishers: readonly SelectableDeveloperPublisher[];
  value: string;
  disabled?: boolean;
  onValueChange: (publisherId: string) => void;
}

export function DeveloperPublisherSelect({
  id,
  publishers,
  value,
  disabled = false,
  onValueChange,
}: DeveloperPublisherSelectProps) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="min-h-10 w-full">
        <SelectValue placeholder="Select a Publisher" />
      </SelectTrigger>
      <SelectContent>
        {publishers.map((entry) => (
          <SelectItem
            key={entry.publisher.publisher_id}
            value={entry.publisher.publisher_id}
            description={entry.publisher.publisher_id}
          >
            {entry.publisher.display_name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
