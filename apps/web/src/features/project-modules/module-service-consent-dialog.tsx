'use client';

import { Check, ShieldOff } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

import type { ModuleServiceConsent, OpenOpcServiceName, OpenOpcServiceOperation } from './client';

export type ServiceConsentAction = 'grant' | 'revoke';

export function confirmedServiceConsentAction(
  action: ServiceConsentAction,
  confirmed: boolean,
): ServiceConsentAction | null {
  return confirmed ? action : null;
}

function serviceLabel(service: OpenOpcServiceName): string {
  return service === 'ai' ? 'AI' : 'Payment';
}

export function moduleServiceConsentDialogView(
  service: OpenOpcServiceName,
  operations: readonly OpenOpcServiceOperation[],
  consent: ModuleServiceConsent | null,
) {
  const action: ServiceConsentAction = consent?.revoked_at ? 'grant' : consent ? 'revoke' : 'grant';
  const label = serviceLabel(service);
  return {
    action,
    title:
      action === 'grant' ? `Allow ${label} service access?` : `Revoke ${label} service access?`,
    description:
      action === 'grant'
        ? 'The module will receive short-lived access only for these declared operations.'
        : 'New capability tokens will stop being issued for this service.',
    operations: [...operations],
  };
}

export interface ModuleServiceConsentDialogProps {
  open: boolean;
  service: OpenOpcServiceName;
  operations: readonly OpenOpcServiceOperation[];
  consent: ModuleServiceConsent | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onGrant: () => void;
  onRevoke: () => void;
}

export function ModuleServiceConsentDialog({
  open,
  service,
  operations,
  consent,
  pending,
  onOpenChange,
  onGrant,
  onRevoke,
}: ModuleServiceConsentDialogProps) {
  const view = moduleServiceConsentDialogView(service, operations, consent);
  const action = view.action;
  const confirmedAction = confirmedServiceConsentAction(action, true);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{view.title}</AlertDialogTitle>
          <AlertDialogDescription>{view.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-1 rounded-md border border-border px-3 py-2 text-sm">
          {view.operations.map((operation) => (
            <li key={operation} className="flex items-center gap-2">
              <code>{operation}</code>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || operations.length === 0}
            onClick={() => {
              if (confirmedAction === 'grant') onGrant();
              if (confirmedAction === 'revoke') onRevoke();
            }}
          >
            {action === 'grant' ? <Check /> : <ShieldOff />}
            {action === 'grant' ? 'Allow service' : 'Revoke service'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
