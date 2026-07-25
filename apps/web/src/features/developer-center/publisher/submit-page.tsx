'use client';

import {
  type DeveloperModuleValidationIssue,
  createDeclarativeDeveloperModuleArtifact,
  submitDeveloperModuleRelease,
  validateDeveloperModule,
} from '@kortix/sdk';
import { ArrowLeft, Box, FileJson, ShieldCheck, Upload, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { usePermission } from '@/lib/use-permission';
import { useCurrentAccountStore } from '@/stores/current-account-store';

import { DEVELOPER_MODULE_INPUT_MAX_BYTES, developerCenterErrorCode } from '../model';
import {
  type DeveloperModuleArtifactUploadState,
  createDeveloperModuleArtifactUploadController,
  defaultDeveloperModuleArtifactUploadDependencies,
} from './artifact-upload-controller';
import {
  type DeveloperModuleSubmitControllerState,
  type SubmitControllerStage,
  type SubmitInputErrorCode,
  createArtifactBackedDeveloperModuleSubmit,
  createDeveloperModuleSubmitController,
} from './submit-controller';

export type DeveloperModuleSubmitMode = 'declarative' | 'package';

const EMPTY_PACKAGE_STATE: DeveloperModuleArtifactUploadState = {
  stage: 'idle',
  fileName: null,
  fileSize: 0,
  progress: 0,
  digest: null,
  uploadId: null,
  artifact: null,
  submission: null,
};

export interface DeveloperModuleSubmitViewProps {
  mode?: DeveloperModuleSubmitMode;
  stage: SubmitControllerStage;
  text: string;
  item: Record<string, unknown> | null;
  issues: readonly DeveloperModuleValidationIssue[];
  inputErrorCode: SubmitInputErrorCode | null;
  canWrite: boolean;
  pending: boolean;
  validating?: boolean;
  errorCode: string | null;
  packageFileName?: string | null;
  packagePublisherId?: string;
  packageState?: DeveloperModuleArtifactUploadState;
  onModeChange?: (mode: DeveloperModuleSubmitMode) => void;
  onTextChange: (value: string) => void;
  onFile?: (file: File) => void | Promise<void>;
  onValidate: () => void | Promise<void>;
  onConfirm: () => void | Promise<void>;
  onPackagePublisherIdChange?: (value: string) => void;
  onPackageFile?: (file: File) => void;
  onStartPackage?: () => void | Promise<void>;
  onCancelPackage?: () => void | Promise<void>;
}

function packageStageLabel(stage: DeveloperModuleArtifactUploadState['stage']): string {
  if (stage === 'hashing') return 'Hashing package';
  if (stage === 'requesting_upload') return 'Preparing upload';
  if (stage === 'uploading') return 'Uploading package';
  if (stage === 'finalizing') return 'Finalizing artifact';
  if (stage === 'submitting') return 'Submitting release';
  if (stage === 'submitted') return 'Release submitted';
  if (stage === 'cancelled') return 'Upload cancelled';
  if (stage === 'error') return 'Upload failed';
  return 'Ready to upload';
}

function DeveloperModulePackageUploadView({
  canWrite,
  fileName,
  publisherId,
  state,
  onPublisherIdChange,
  onFile,
  onStart,
  onCancel,
}: {
  canWrite: boolean;
  fileName: string | null;
  publisherId: string;
  state: DeveloperModuleArtifactUploadState;
  onPublisherIdChange: (value: string) => void;
  onFile: (file: File) => void;
  onStart: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}) {
  const active = ['hashing', 'requesting_upload', 'uploading', 'finalizing', 'submitting'].includes(
    state.stage,
  );
  const selectedFileName = state.fileName ?? fileName;

  return (
    <section className="space-y-5" aria-label="Package upload">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
        <label
          htmlFor="developer-module-package"
          className="flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-5 text-center"
        >
          <Box className="size-5" />
          <span className="mt-2 break-all text-sm font-medium">
            {selectedFileName ?? 'Select module package'}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">Maximum 512 MiB</span>
          <Input
            id="developer-module-package"
            type="file"
            accept=".openopc,.json,application/octet-stream,application/vnd.openopc.developer-module.v2+json"
            className="sr-only"
            disabled={active}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
            }}
          />
        </label>
        <div className="space-y-2">
          <label htmlFor="developer-module-publisher" className="text-sm font-medium">
            Publisher ID
          </label>
          <Input
            id="developer-module-publisher"
            value={publisherId}
            placeholder="acme"
            disabled={active}
            onChange={(event) => onPublisherIdChange(event.target.value)}
          />
        </div>
      </div>

      {state.stage !== 'idle' ? (
        <div className="space-y-2 border-y py-4">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">{packageStageLabel(state.stage)}</span>
            <span className="tabular-nums text-muted-foreground">{state.progress}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-foreground/10"
            aria-label="Upload progress"
          >
            <div
              className="h-full bg-foreground transition-[width]"
              style={{ width: `${Math.min(Math.max(state.progress, 0), 100)}%` }}
            />
          </div>
          {state.digest ? (
            <p className="break-all font-mono text-xs text-muted-foreground">
              Local digest: {state.digest}
            </p>
          ) : null}
          {state.artifact ? (
            <p className="break-all font-mono text-xs">
              Server artifact digest: {state.artifact.artifact_digest}
            </p>
          ) : null}
        </div>
      ) : null}

      {!canWrite ? (
        <p className="text-sm text-muted-foreground">Account write permission is required.</p>
      ) : active ? (
        <Button type="button" variant="outline" onClick={() => void onCancel()}>
          <XCircle />
          Cancel upload
        </Button>
      ) : state.stage === 'submitted' ? null : (
        <Button
          type="button"
          disabled={!fileName || !publisherId.trim()}
          onClick={() => void onStart()}
        >
          <Upload />
          Upload package
        </Button>
      )}
    </section>
  );
}

function textValue(item: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return 'Not declared';
}

function listValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ') || 'None';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value === undefined || value === null ? 'None' : String(value);
}

export function DeveloperModuleSubmitView({
  mode = 'declarative',
  stage,
  text,
  item,
  issues,
  inputErrorCode,
  canWrite,
  pending,
  validating = false,
  errorCode,
  packageFileName = null,
  packagePublisherId = '',
  packageState = EMPTY_PACKAGE_STATE,
  onModeChange = () => undefined,
  onTextChange,
  onFile,
  onValidate,
  onConfirm,
  onPackagePublisherIdChange = () => undefined,
  onPackageFile = () => undefined,
  onStartPackage = () => undefined,
  onCancelPackage = () => undefined,
}: DeveloperModuleSubmitViewProps) {
  const confirmation = stage !== 'input' && item;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 md:px-8">
      <header className="space-y-4">
        <Button asChild type="button" size="xs" variant="ghost">
          <Link href="/developer/modules">
            <ArrowLeft />
            Recent releases
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">Submit module version</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Validate one Registry Module manifest before creating an immutable release.
          </p>
        </div>
      </header>

      {errorCode ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          {errorCode}
        </div>
      ) : null}

      <div
        role="tablist"
        aria-label="Submission type"
        className="inline-flex h-9 w-fit items-center gap-1 rounded-lg bg-foreground/5 p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'declarative'}
          className="h-7 rounded-md px-3 text-sm font-medium aria-selected:bg-background aria-selected:shadow-sm"
          onClick={() => onModeChange('declarative')}
        >
          Declarative JSON
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'package'}
          className="h-7 rounded-md px-3 text-sm font-medium aria-selected:bg-background aria-selected:shadow-sm"
          onClick={() => onModeChange('package')}
        >
          Package upload
        </button>
      </div>

      {mode === 'package' ? (
        <DeveloperModulePackageUploadView
          canWrite={canWrite}
          fileName={packageFileName}
          publisherId={packagePublisherId}
          state={packageState}
          onPublisherIdChange={onPackagePublisherIdChange}
          onFile={onPackageFile}
          onStart={onStartPackage}
          onCancel={onCancelPackage}
        />
      ) : !confirmation ? (
        <section className="space-y-5" aria-label="Module manifest input">
          <div className="grid gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
            <label
              htmlFor="developer-module-file"
              className="flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-5 text-center"
            >
              <Upload className="size-5" />
              <span className="mt-2 text-sm font-medium">Upload JSON</span>
              <span className="mt-1 text-xs text-muted-foreground">Maximum 1 MiB</span>
              <Input
                id="developer-module-file"
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onFile?.(file);
                }}
              />
            </label>
            <div className="space-y-2">
              <label htmlFor="developer-module-json" className="text-sm font-medium">
                Paste JSON
              </label>
              <Textarea
                id="developer-module-json"
                value={text}
                minHeight={132}
                maxHeight={420}
                spellCheck={false}
                placeholder="Paste a registry:module item"
                onChange={(event) => onTextChange(event.target.value)}
              />
            </div>
          </div>

          {inputErrorCode ? (
            <p className="text-sm font-medium text-destructive">{inputErrorCode}</p>
          ) : null}
          {issues.length > 0 ? (
            <ul className="space-y-2" aria-label="Validation issues">
              {issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`} className="rounded-lg border px-3 py-2 text-sm">
                  <span className="font-medium">{issue.path || 'manifest'}</span>: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}

          {!canWrite ? (
            <p className="text-sm text-muted-foreground">
              Account write permission is required to validate and submit a release.
            </p>
          ) : null}
          <Button
            type="button"
            disabled={!canWrite || validating}
            onClick={() => void onValidate()}
          >
            {validating ? <Loading /> : <FileJson />}
            {validating ? 'Validating...' : 'Validate'}
          </Button>
        </section>
      ) : (
        <section className="space-y-5" aria-label="Confirm submission">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5" />
              <h2 className="text-lg font-semibold">Confirm submission</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Validation passed. Persistence begins only when you submit this release.
            </p>
          </div>

          <dl className="grid gap-x-6 gap-y-4 border-y py-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Publisher</dt>
              <dd className="mt-1 break-words text-sm font-medium">
                {textValue(item, 'publisher_id', 'publisher')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Module ID</dt>
              <dd className="mt-1 break-words text-sm font-medium">
                {textValue(item, 'id', 'module_id')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Version</dt>
              <dd className="mt-1 text-sm font-medium">
                {textValue(item, 'version', 'module_version')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Execution mode</dt>
              <dd className="mt-1 text-sm font-medium">
                {textValue(item, 'execution_mode', 'executionMode')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Permissions</dt>
              <dd className="mt-1 break-words text-sm">{listValue(item.permissions)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Review requirements</dt>
              <dd className="mt-1 break-words text-sm">{listValue(item.review_requirements)}</dd>
            </div>
          </dl>

          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">Validated JSON</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
              {text}
            </pre>
          </details>

          {!canWrite ? (
            <p className="text-sm text-muted-foreground">Account write permission is required.</p>
          ) : (
            <Button type="button" disabled={pending} onClick={() => void onConfirm()}>
              {pending ? <Loading /> : <ShieldCheck />}
              {pending ? 'Submitting...' : 'Submit release'}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onTextChange(text)}
          >
            Edit manifest
          </Button>
        </section>
      )}
    </main>
  );
}

export function PublisherModuleSubmitPage() {
  const router = useRouter();
  const selectedAccountId = useCurrentAccountStore((state) => state.selectedAccountId);
  const writePermission = usePermission(selectedAccountId ?? undefined, 'account.write');
  const [mode, setMode] = useState<DeveloperModuleSubmitMode>('declarative');
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [packagePublisherId, setPackagePublisherId] = useState('');
  const [packageState, setPackageState] =
    useState<DeveloperModuleArtifactUploadState>(EMPTY_PACKAGE_STATE);
  const controller = useMemo(
    () =>
      createDeveloperModuleSubmitController({
        validate: validateDeveloperModule,
        submit: createArtifactBackedDeveloperModuleSubmit({
          createArtifact: createDeclarativeDeveloperModuleArtifact,
          submitRelease: submitDeveloperModuleRelease,
        }),
      }),
    [],
  );
  const packageController = useMemo(
    () =>
      createDeveloperModuleArtifactUploadController(
        defaultDeveloperModuleArtifactUploadDependencies,
        setPackageState,
      ),
    [],
  );
  const [controllerState, setControllerState] = useState<DeveloperModuleSubmitControllerState>(() =>
    controller.getState(),
  );
  const [validating, setValidating] = useState(false);
  const [fileError, setFileError] = useState<SubmitInputErrorCode | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const changeText = (value: string) => {
    setFileError(null);
    setErrorCode(null);
    setControllerState(controller.setText(value));
  };

  const loadFile = async (file: File) => {
    setErrorCode(null);
    if (file.size > DEVELOPER_MODULE_INPUT_MAX_BYTES) {
      setFileError('INPUT_TOO_LARGE');
      return;
    }
    try {
      changeText(await file.text());
    } catch (error) {
      setErrorCode(developerCenterErrorCode(error));
    }
  };

  const validate = async () => {
    setErrorCode(null);
    setValidating(true);
    try {
      setControllerState(await controller.validate());
    } catch (error) {
      setErrorCode(developerCenterErrorCode(error));
    } finally {
      setValidating(false);
    }
  };

  const confirm = async () => {
    if (!selectedAccountId) return;
    setErrorCode(null);
    try {
      const pending = controller.confirm(selectedAccountId);
      setControllerState(controller.getState());
      const result = await pending;
      setControllerState(controller.getState());
      router.push(`/developer/modules/${encodeURIComponent(result.release.release_id)}`);
    } catch (error) {
      setControllerState(controller.getState());
      setErrorCode(developerCenterErrorCode(error));
    }
  };

  const selectPackage = (file: File) => {
    setErrorCode(null);
    if (packageState.stage !== 'idle' && packageState.stage !== 'submitted') {
      try {
        packageController.reset();
      } catch {
        return;
      }
    }
    setPackageFile(file);
  };

  const submitPackage = async () => {
    if (!selectedAccountId || !packageFile || !packagePublisherId.trim()) return;
    setErrorCode(null);
    try {
      const result = await packageController.start(packageFile, {
        accountId: selectedAccountId,
        publisherId: packagePublisherId.trim(),
      });
      if (result) {
        router.push(`/developer/modules/${encodeURIComponent(result.release.release_id)}`);
      }
    } catch (error) {
      setErrorCode(developerCenterErrorCode(error));
    }
  };

  return (
    <DeveloperModuleSubmitView
      mode={mode}
      stage={controllerState.stage}
      text={controllerState.text}
      item={controllerState.parsedItem}
      issues={controllerState.issues}
      inputErrorCode={fileError ?? controllerState.inputErrorCode}
      canWrite={writePermission.allowed}
      pending={controllerState.stage === 'submitting'}
      validating={validating}
      errorCode={errorCode}
      packageFileName={packageFile?.name ?? null}
      packagePublisherId={packagePublisherId}
      packageState={packageState}
      onModeChange={setMode}
      onTextChange={changeText}
      onFile={loadFile}
      onValidate={validate}
      onConfirm={confirm}
      onPackagePublisherIdChange={setPackagePublisherId}
      onPackageFile={selectPackage}
      onStartPackage={submitPackage}
      onCancelPackage={() => packageController.cancel()}
    />
  );
}
