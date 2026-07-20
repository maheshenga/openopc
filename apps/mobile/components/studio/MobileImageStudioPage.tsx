import type { IntelligenceImageEstimate, IntelligenceStudioAsset } from '@kortix/sdk';
import {
  useCancelIntelligenceJob,
  useCreateIntelligenceTask,
  useEstimateIntelligenceImage,
  useIntelligenceAgentCard,
  useIntelligenceAssetDownload,
  useIntelligenceAssets,
  useIntelligenceCapabilityDiscovery,
  useIntelligenceJobs,
  useIntelligenceTaskEvents,
} from '@kortix/sdk/react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Linking } from 'react-native';

import { MobileImageStudioView } from '@/components/studio/MobileImageStudioView';
import { haptics } from '@/lib/haptics';
import {
  type MobileImageAspectRatio,
  type MobileImageTaskState,
  buildMobileImageEstimateRequest,
  buildMobileImageTaskRequest,
  emptyMobileImageTaskState,
  mergeMobileImageTaskEvents,
  parseMobileImageTaskState,
  reconcileMobileImageTaskWithJob,
  selectMobileImageTarget,
  serializeMobileImageTaskState,
  shouldRefreshMobileImageEstimate,
} from '@/lib/studio/mobile-image-studio';
import { generateUUID } from '@/lib/utils/uuid';

interface MobileImageStudioPageProps {
  projectId: string;
  onBack: () => void;
}

const ACTIVE_TASK_KEY = '@kortix:mobile-image-studio:active';

function storageKey(projectId: string): string {
  return `${ACTIVE_TASK_KEY}:${projectId}`;
}

function stableErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_.-]{0,127}$/.test(code) ? code : null;
}

function userFacingError(error: unknown): string {
  const code = stableErrorCode(error);
  if (code === 'INTELLIGENCE_PERMISSION_DENIED' || code === 'STUDIO_PERMISSION_DENIED') {
    return 'You do not have permission to create images in this project.';
  }
  if (code === 'STUDIO_INSUFFICIENT_CREDITS') {
    return 'Not enough credits for this generation.';
  }
  if (code === 'STUDIO_PROVIDER_UNAVAILABLE') {
    return 'The selected image provider is unavailable.';
  }
  return 'The request could not be completed. Try again.';
}

function assetFilename(asset: IntelligenceStudioAsset): string {
  const extension =
    asset.mime_type === 'image/png' ? 'png' : asset.mime_type === 'image/webp' ? 'webp' : 'jpg';
  return `kortix-image-${asset.asset_id.slice(0, 8)}.${extension}`;
}

export function MobileImageStudioPage({ projectId, onBack }: MobileImageStudioPageProps) {
  const discovery = useIntelligenceCapabilityDiscovery(projectId, { pollingEnabled: false });
  const agentCard = useIntelligenceAgentCard(projectId, { pollingEnabled: false });
  const jobs = useIntelligenceJobs(projectId, null, { refetchInterval: 4_000 });
  const assets = useIntelligenceAssets(projectId, null, { refetchInterval: 5_000 });
  const estimateImage = useEstimateIntelligenceImage(projectId);
  const createTask = useCreateIntelligenceTask(projectId);
  const cancelJob = useCancelIntelligenceJob(projectId);
  const assetDownload = useIntelligenceAssetDownload(projectId);

  const [prompt, setPrompt] = useState('');
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<MobileImageAspectRatio>('1:1');
  const [quality, setQuality] = useState<'standard' | 'high'>('standard');
  const [outputCount, setOutputCount] = useState(1);
  const [estimateRequest, setEstimateRequest] = useState<ReturnType<
    typeof buildMobileImageEstimateRequest
  > | null>(null);
  const [estimate, setEstimate] = useState<IntelligenceImageEstimate | null>(null);
  const [estimateFingerprint, setEstimateFingerprint] = useState<string | null>(null);
  const [taskState, setTaskState] = useState<MobileImageTaskState | null>(null);
  const [restored, setRestored] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const requestedPreviews = useRef(new Set<string>());
  const idempotencyKey = useRef(`mobile-image:${generateUUID()}`);
  const recoveredCursors = useRef(new Set<string>());

  const targets = discovery.data?.execution_targets ?? [];
  const selectedTarget = useMemo(() => {
    if (!selectedTargetKey) return selectMobileImageTarget(targets);
    const separator = selectedTargetKey.indexOf(':');
    if (separator < 0) return selectMobileImageTarget(targets);
    return selectMobileImageTarget(targets, {
      provider_config_id: selectedTargetKey.slice(0, separator),
      model: selectedTargetKey.slice(separator + 1),
    });
  }, [selectedTargetKey, targets]);
  const draftFingerprint = JSON.stringify({
    prompt,
    providerConfigId: selectedTarget?.provider_config_id ?? null,
    model: selectedTarget?.model ?? null,
    aspectRatio,
    quality,
    outputCount,
  });

  const taskEvents = useIntelligenceTaskEvents(projectId, taskState?.taskId, taskState?.cursor, {
    enabled: !!taskState && !taskState.terminal,
    refetchInterval: 2_000,
  });

  useEffect(() => {
    const first = selectMobileImageTarget(targets);
    if (!first) {
      setSelectedTargetKey(null);
      return;
    }
    if (!selectedTarget) setSelectedTargetKey(`${first.provider_config_id}:${first.model}`);
  }, [selectedTarget, targets]);

  useEffect(() => {
    let mounted = true;
    setRestored(false);
    setTaskState(null);
    AsyncStorage.getItem(storageKey(projectId))
      .then((stored) => {
        if (mounted) setTaskState(parseMobileImageTaskState(stored));
      })
      .finally(() => {
        if (mounted) setRestored(true);
      });
    return () => {
      mounted = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!restored) return;
    if (taskState) {
      void AsyncStorage.setItem(storageKey(projectId), serializeMobileImageTaskState(taskState));
    } else {
      void AsyncStorage.removeItem(storageKey(projectId));
    }
  }, [projectId, restored, taskState]);

  useEffect(() => {
    if (!taskEvents.data) return;
    setTaskState((current) =>
      current ? mergeMobileImageTaskEvents(current, taskEvents.data) : current,
    );
  }, [taskEvents.data]);

  useEffect(() => {
    if (!taskEvents.isError || !taskState?.jobId || taskState.cursor === null) return;
    const recoveryKey = `${taskState.taskId}:${taskState.cursor}`;
    if (recoveredCursors.current.has(recoveryKey)) return;
    recoveredCursors.current.add(recoveryKey);
    const snapshot = jobs.data?.items.find((job) => job.job_id === taskState.jobId);
    setTaskState((current) => {
      if (!current) return current;
      const reconciled = snapshot ? reconcileMobileImageTaskWithJob(current, snapshot) : current;
      return { ...reconciled, cursor: null };
    });
  }, [jobs.data?.items, taskEvents.isError, taskState]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void discovery.refetch();
      void agentCard.refetch();
      void jobs.refetch();
      void assets.refetch();
      if (taskState && !taskState.terminal) void taskEvents.refetch();
    });
    return () => subscription.remove();
  }, [agentCard, assets, discovery, jobs, taskEvents, taskState]);

  useEffect(() => {
    void draftFingerprint;
    setEstimate(null);
    setEstimateRequest(null);
    setEstimateFingerprint(null);
    setErrorMessage(null);
    idempotencyKey.current = `mobile-image:${generateUUID()}`;
  }, [draftFingerprint]);

  const visibleAssets = useMemo(() => {
    const items = assets.data?.items ?? [];
    if (!taskState?.jobId) return items.slice(0, 8);
    const ids = new Set(taskState.assetIds);
    return items
      .filter((asset) => ids.has(asset.asset_id) || asset.source_job_id === taskState.jobId)
      .slice(0, 8);
  }, [assets.data?.items, taskState]);

  const requestPreview = useCallback(
    async (assetId: string) => {
      if (previewUrls[assetId] || requestedPreviews.current.has(assetId)) return;
      requestedPreviews.current.add(assetId);
      try {
        const result = await assetDownload.mutateAsync(assetId);
        setPreviewUrls((current) => ({ ...current, [assetId]: result.signed_download_url }));
      } catch {
        requestedPreviews.current.delete(assetId);
      }
    },
    [assetDownload, previewUrls],
  );

  useEffect(() => {
    for (const asset of visibleAssets) void requestPreview(asset.asset_id);
  }, [requestPreview, visibleAssets]);

  const handleEstimate = useCallback(async () => {
    if (!selectedTarget) return;
    setErrorMessage(null);
    try {
      const request = buildMobileImageEstimateRequest({
        prompt,
        target: selectedTarget,
        aspectRatio,
        quality,
        outputCount,
      });
      const result = await estimateImage.mutateAsync(request);
      setEstimateRequest(request);
      setEstimate(result);
      setEstimateFingerprint(draftFingerprint);
      haptics.selection();
    } catch (error) {
      haptics.warning();
      setErrorMessage(userFacingError(error));
    }
  }, [aspectRatio, draftFingerprint, estimateImage, outputCount, prompt, quality, selectedTarget]);

  const handleGenerate = useCallback(async () => {
    const cardHash = agentCard.data?.card_hash;
    if (!estimate || !estimateRequest || !cardHash || estimateFingerprint !== draftFingerprint)
      return;
    setErrorMessage(null);
    try {
      const request = buildMobileImageTaskRequest(estimateRequest, {
        agentCardHash: cardHash,
        idempotencyKey: idempotencyKey.current,
        estimate,
      });
      const result = await createTask.mutateAsync(request);
      setTaskState(emptyMobileImageTaskState(result.task_id, result.job_id));
      setEstimate(null);
      setEstimateRequest(null);
      setEstimateFingerprint(null);
      setPreviewUrls({});
      requestedPreviews.current.clear();
      idempotencyKey.current = `mobile-image:${generateUUID()}`;
      haptics.success();
    } catch (error) {
      haptics.warning();
      if (shouldRefreshMobileImageEstimate(stableErrorCode(error))) {
        setEstimate(null);
        setEstimateRequest(null);
        setEstimateFingerprint(null);
        idempotencyKey.current = `mobile-image:${generateUUID()}`;
      }
      setErrorMessage(userFacingError(error));
    }
  }, [
    agentCard.data?.card_hash,
    createTask,
    draftFingerprint,
    estimate,
    estimateFingerprint,
    estimateRequest,
  ]);

  const handleCancel = useCallback(async () => {
    if (!taskState?.jobId || taskState.terminal) return;
    try {
      await cancelJob.mutateAsync(taskState.jobId);
      setTaskState((current) =>
        current ? { ...current, status: 'cancelled', terminal: true } : current,
      );
      haptics.success();
    } catch (error) {
      setErrorMessage(userFacingError(error));
    }
  }, [cancelJob, taskState]);

  const handleDownload = useCallback(
    async (asset: IntelligenceStudioAsset) => {
      try {
        const result = await assetDownload.mutateAsync(asset.asset_id);
        const target = `${FileSystem.cacheDirectory}${assetFilename(asset)}`;
        const downloaded = await FileSystem.downloadAsync(result.signed_download_url, target);
        if (downloaded.status >= 400) throw new Error('DOWNLOAD_FAILED');
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(target, { mimeType: asset.mime_type });
        } else {
          await Linking.openURL(result.signed_download_url);
        }
      } catch {
        Alert.alert('Download failed', 'The image could not be downloaded. Try again.');
      }
    },
    [assetDownload],
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        discovery.refetch(),
        agentCard.refetch(),
        jobs.refetch(),
        assets.refetch(),
        ...(taskState && !taskState.terminal ? [taskEvents.refetch()] : []),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [agentCard, assets, discovery, jobs, taskEvents, taskState]);

  const loading = discovery.isLoading || agentCard.isLoading || !restored;
  const unavailable = !loading && (discovery.isError || agentCard.isError || targets.length === 0);
  const canEstimate = !!selectedTarget && prompt.trim().length > 0 && !estimateImage.isPending;
  const canGenerate =
    !!estimate &&
    !!estimateRequest &&
    estimateFingerprint === draftFingerprint &&
    !!agentCard.data?.card_hash &&
    !createTask.isPending;

  return (
    <MobileImageStudioView
      loading={loading}
      unavailable={unavailable}
      refreshing={refreshing}
      prompt={prompt}
      targets={targets}
      selectedTarget={selectedTarget}
      aspectRatio={aspectRatio}
      quality={quality}
      outputCount={outputCount}
      errorMessage={errorMessage}
      estimate={estimate}
      estimating={estimateImage.isPending}
      creating={createTask.isPending}
      canEstimate={canEstimate}
      canGenerate={canGenerate}
      taskState={taskState}
      cancelling={cancelJob.isPending}
      assets={visibleAssets}
      previewUrls={previewUrls}
      previewAssetId={previewAssetId}
      jobs={jobs.data?.items ?? []}
      onBack={onBack}
      onRefresh={() => void handleRefresh()}
      onPromptChange={setPrompt}
      onSelectTarget={(target) => {
        haptics.selection();
        setSelectedTargetKey(`${target.provider_config_id}:${target.model}`);
      }}
      onAspectRatioChange={(value) => {
        haptics.selection();
        setAspectRatio(value);
      }}
      onQualityChange={(value) => {
        haptics.selection();
        setQuality(value);
      }}
      onOutputCountChange={setOutputCount}
      onEstimate={() => void handleEstimate()}
      onGenerate={() => void handleGenerate()}
      onCancel={() => void handleCancel()}
      onPreview={setPreviewAssetId}
      onDownload={(asset) => void handleDownload(asset)}
    />
  );
}
