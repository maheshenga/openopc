'use client';

import { RotateCcw, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

import {
  type EffectiveModuleSettings,
  type ModuleSettingField,
  type ModuleSettingValue,
  type ModuleSettingsDefinition,
  getProjectModuleSettings,
  updateProjectModuleSettings,
} from './client';

export function defaultSettingValue(field: ModuleSettingField): ModuleSettingValue {
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'number') return field.min ?? 0;
  if (field.type === 'select' || field.type === 'model-select') {
    return field.options?.[0]?.value ?? '';
  }
  return '';
}

export function moduleSettingsFormValues(
  definition: ModuleSettingsDefinition,
  settings?: EffectiveModuleSettings | null,
): Record<string, ModuleSettingValue> {
  return Object.fromEntries(
    definition.fields.map((field) => [
      field.key,
      Object.hasOwn(settings?.values ?? {}, field.key)
        ? (settings?.values[field.key] ?? null)
        : defaultSettingValue(field),
    ]),
  );
}

interface ModuleSettingsSheetProps {
  open: boolean;
  projectId: string;
  installationId: string;
  moduleTitle: string;
  definition: ModuleSettingsDefinition;
  canWrite: boolean;
  onOpenChange(open: boolean): void;
}

function messageFor(error: unknown): string {
  if (error instanceof Error && /conflict|revision|409/i.test(error.message)) {
    return '这些设置已在另一个会话中更新。请重新加载后再保存。';
  }
  return '模块设置暂时无法保存，请重试。';
}

export function ModuleSettingsSheet({
  open,
  projectId,
  installationId,
  moduleTitle,
  definition,
  canWrite,
  onOpenChange,
}: ModuleSettingsSheetProps) {
  const [settings, setSettings] = useState<EffectiveModuleSettings | null>(null);
  const [values, setValues] = useState<Record<string, ModuleSettingValue>>(() =>
    moduleSettingsFormValues(definition),
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const saveController = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setStatus('loading');
      setError(null);
      try {
        const next = await getProjectModuleSettings(projectId, installationId, signal);
        if (signal?.aborted) return;
        setSettings(next);
        setValues(moduleSettingsFormValues(definition, next));
        setStatus('ready');
      } catch (loadError) {
        if (signal?.aborted) return;
        setError(messageFor(loadError));
        setStatus('error');
      }
    },
    [definition, installationId, projectId],
  );

  useEffect(() => {
    if (!open) {
      saveController.current?.abort();
      saveController.current = null;
    }
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      saveController.current?.abort();
      saveController.current = null;
    };
  }, [load, open]);

  useEffect(
    () => () => {
      saveController.current?.abort();
      saveController.current = null;
    },
    [],
  );

  const defaults = useMemo(() => moduleSettingsFormValues(definition), [definition]);
  const patch = (key: string, value: ModuleSettingValue) =>
    setValues((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (!settings || !canWrite) return;
    const controller = new AbortController();
    saveController.current?.abort();
    saveController.current = controller;
    setStatus('saving');
    setError(null);
    try {
      const next = await updateProjectModuleSettings(
        projectId,
        installationId,
        { expected_revision: settings.revision, values },
        controller.signal,
      );
      setSettings(next);
      setValues(moduleSettingsFormValues(definition, next));
      setStatus('ready');
    } catch (saveError) {
      if (controller.signal.aborted) return;
      setError(messageFor(saveError));
      setStatus('error');
    } finally {
      if (saveController.current === controller) saveController.current = null;
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-h-[90vh] lg:max-w-md" aria-label={`${moduleTitle} settings`}>
        <ModalHeader>
          <ModalTitle>Module settings</ModalTitle>
          <ModalDescription>
            {moduleTitle} / project-owned, non-sensitive preferences
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="min-h-0 gap-0 overflow-y-auto">
          {status === 'loading' ? (
            <div className="text-muted-foreground flex min-h-48 w-full items-center justify-center gap-2 text-sm">
              <Loading /> Loading module settings...
            </div>
          ) : (
            <div className="w-full divide-y">
              {definition.fields.map((field) => {
                const value = values[field.key] ?? defaultSettingValue(field);
                return (
                  <div key={field.key} className="flex min-w-0 flex-col gap-2 py-4 first:pt-0">
                    <div className="flex min-w-0 items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Label htmlFor={`module-setting-${field.key}`}>{field.label}</Label>
                        {field.description ? (
                          <p className="text-muted-foreground mt-1 text-xs leading-5">
                            {field.description}
                          </p>
                        ) : null}
                      </div>
                      {field.type === 'boolean' ? (
                        <Switch
                          id={`module-setting-${field.key}`}
                          checked={value === true}
                          disabled={!canWrite || status === 'saving'}
                          onCheckedChange={(checked) => patch(field.key, checked)}
                        />
                      ) : null}
                    </div>
                    {field.type === 'number' ? (
                      <Input
                        id={`module-setting-${field.key}`}
                        type="number"
                        min={field.min}
                        max={field.max}
                        value={typeof value === 'number' ? value : (field.min ?? 0)}
                        disabled={!canWrite || status === 'saving'}
                        onChange={(event) => {
                          const next = Number(event.currentTarget.value);
                          if (Number.isFinite(next)) patch(field.key, next);
                        }}
                      />
                    ) : null}
                    {field.type === 'select' || field.type === 'model-select' ? (
                      <Select
                        value={typeof value === 'string' ? value : ''}
                        disabled={!canWrite || status === 'saving'}
                        onValueChange={(next) => patch(field.key, next)}
                      >
                        <SelectTrigger id={`module-setting-${field.key}`}>
                          <SelectValue placeholder="Select an option" />
                        </SelectTrigger>
                        <SelectContent>
                          {field.options?.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                    {field.type === 'text' ? (
                      <Input
                        id={`module-setting-${field.key}`}
                        value={typeof value === 'string' ? value : ''}
                        disabled={!canWrite || status === 'saving'}
                        onChange={(event) => patch(field.key, event.currentTarget.value)}
                      />
                    ) : null}
                    {field.type === 'textarea' ? (
                      <Textarea
                        id={`module-setting-${field.key}`}
                        value={typeof value === 'string' ? value : ''}
                        disabled={!canWrite || status === 'saving'}
                        onChange={(event) => patch(field.key, event.currentTarget.value)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {error ? (
            <div
              className="border-destructive/30 bg-destructive/10 text-destructive mt-4 w-full rounded-md border p-3 text-sm"
              role="alert"
            >
              {error}
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter className="gap-2 pb-5">
          <Button
            type="button"
            variant="outline"
            disabled={!canWrite || status === 'loading' || status === 'saving'}
            onClick={() => setValues(defaults)}
          >
            <RotateCcw /> Reset defaults
          </Button>
          {status === 'error' && !settings ? (
            <Button type="button" onClick={() => void load()}>
              Reload
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!canWrite || !settings || status === 'loading' || status === 'saving'}
              onClick={() => void save()}
            >
              {status === 'saving' ? <Loading /> : <Save />}
              Save settings
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
