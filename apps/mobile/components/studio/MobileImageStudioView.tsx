import type {
  IntelligenceExecutionTarget,
  IntelligenceImageEstimate,
  IntelligenceStudioAsset,
  IntelligenceStudioJob,
} from '@kortix/sdk';
import {
  ChevronLeft,
  Download,
  Image as ImageIcon,
  Minus,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import React from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { PageContent } from '@/components/ui/page-content';
import { PageHeader } from '@/components/ui/page-header';
import { Text } from '@/components/ui/text';
import type {
  MobileImageAspectRatio,
  MobileImageTaskState,
} from '@/lib/studio/mobile-image-studio';
import { useThemeColors } from '@/lib/theme-colors';

interface MobileImageStudioViewProps {
  loading: boolean;
  unavailable: boolean;
  refreshing: boolean;
  prompt: string;
  targets: readonly IntelligenceExecutionTarget[];
  selectedTarget: IntelligenceExecutionTarget | null;
  aspectRatio: MobileImageAspectRatio;
  quality: 'standard' | 'high';
  outputCount: number;
  errorMessage: string | null;
  estimate: IntelligenceImageEstimate | null;
  estimating: boolean;
  creating: boolean;
  canEstimate: boolean;
  canGenerate: boolean;
  taskState: MobileImageTaskState | null;
  cancelling: boolean;
  assets: readonly IntelligenceStudioAsset[];
  previewUrls: Readonly<Record<string, string>>;
  previewAssetId: string | null;
  jobs: readonly IntelligenceStudioJob[];
  onBack(): void;
  onRefresh(): void;
  onPromptChange(value: string): void;
  onSelectTarget(target: IntelligenceExecutionTarget): void;
  onAspectRatioChange(value: MobileImageAspectRatio): void;
  onQualityChange(value: 'standard' | 'high'): void;
  onOutputCountChange(value: number): void;
  onEstimate(): void;
  onGenerate(): void;
  onCancel(): void;
  onPreview(assetId: string | null): void;
  onDownload(asset: IntelligenceStudioAsset): void;
}

interface Palette {
  isDark: boolean;
  foreground: string;
  muted: string;
  border: string;
  subtle: string;
  primary: string;
}

const ASPECT_RATIOS: MobileImageAspectRatio[] = ['1:1', '4:3', '3:4', '16:9', '9:16'];

function SelectionButton({
  label,
  active,
  palette,
  onPress,
  flex,
}: {
  label: string;
  active: boolean;
  palette: Palette;
  onPress(): void;
  flex?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex,
        minWidth: flex ? undefined : 52,
        alignItems: 'center',
        paddingHorizontal: 11,
        paddingVertical: 9,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: active ? palette.primary : palette.border,
        backgroundColor: active ? `${palette.primary}18` : 'transparent',
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: active ? palette.primary : palette.foreground,
          fontSize: 13,
          fontFamily: 'Roobert-Medium',
          textTransform: label === 'standard' || label === 'high' ? 'capitalize' : 'none',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function CreationControls({
  props,
  palette,
}: {
  props: MobileImageStudioViewProps;
  palette: Palette;
}) {
  return (
    <>
      <View style={{ paddingTop: 4 }}>
        <Text style={{ color: palette.muted, fontSize: 12, fontFamily: 'Roobert-Medium' }}>
          PROMPT
        </Text>
        <TextInput
          value={props.prompt}
          onChangeText={props.onPromptChange}
          placeholder="Describe the image to create"
          placeholderTextColor={palette.muted}
          multiline
          maxLength={8000}
          textAlignVertical="top"
          style={{
            minHeight: 118,
            marginTop: 8,
            padding: 14,
            borderWidth: 1,
            borderColor: palette.border,
            borderRadius: 8,
            color: palette.foreground,
            backgroundColor: palette.subtle,
            fontFamily: 'Roobert',
            fontSize: 15,
            lineHeight: 21,
          }}
        />
      </View>

      <View style={{ marginTop: 18 }}>
        <Text style={{ color: palette.muted, fontSize: 12, fontFamily: 'Roobert-Medium' }}>
          MODEL
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingTop: 8 }}
        >
          {props.targets.map((target) => {
            const active =
              props.selectedTarget?.provider_config_id === target.provider_config_id &&
              props.selectedTarget?.model === target.model;
            return (
              <SelectionButton
                key={`${target.provider_config_id}:${target.model}`}
                label={target.model}
                active={active}
                palette={palette}
                onPress={() => props.onSelectTarget(target)}
              />
            );
          })}
        </ScrollView>
      </View>

      <View style={{ marginTop: 18 }}>
        <Text style={{ color: palette.muted, fontSize: 12, fontFamily: 'Roobert-Medium' }}>
          FORMAT
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {ASPECT_RATIOS.map((value) => (
            <SelectionButton
              key={value}
              label={value}
              active={props.aspectRatio === value}
              palette={palette}
              onPress={() => props.onAspectRatioChange(value)}
            />
          ))}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 12, marginTop: 18 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: palette.muted, fontSize: 12, fontFamily: 'Roobert-Medium' }}>
            QUALITY
          </Text>
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
            {(['standard', 'high'] as const).map((value) => (
              <SelectionButton
                key={value}
                label={value}
                active={props.quality === value}
                palette={palette}
                flex={1}
                onPress={() => props.onQualityChange(value)}
              />
            ))}
          </View>
        </View>
        <View style={{ width: 126 }}>
          <Text style={{ color: palette.muted, fontSize: 12, fontFamily: 'Roobert-Medium' }}>
            OUTPUTS
          </Text>
          <View
            style={{
              height: 39,
              marginTop: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderRadius: 8,
              borderWidth: 1,
              borderColor: palette.border,
            }}
          >
            <Pressable
              onPress={() => props.onOutputCountChange(Math.max(1, props.outputCount - 1))}
              disabled={props.outputCount <= 1}
              style={{ padding: 9, opacity: props.outputCount <= 1 ? 0.35 : 1 }}
            >
              <Minus size={15} color={palette.foreground} />
            </Pressable>
            <Text style={{ color: palette.foreground, fontFamily: 'Roobert-Medium' }}>
              {props.outputCount}
            </Text>
            <Pressable
              onPress={() => props.onOutputCountChange(Math.min(8, props.outputCount + 1))}
              disabled={props.outputCount >= 8}
              style={{ padding: 9, opacity: props.outputCount >= 8 ? 0.35 : 1 }}
            >
              <Plus size={15} color={palette.foreground} />
            </Pressable>
          </View>
        </View>
      </View>

      {props.errorMessage ? (
        <View
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 8,
            backgroundColor: palette.isDark ? 'rgba(239,68,68,0.12)' : 'rgba(220,38,38,0.07)',
          }}
        >
          <Text style={{ color: palette.isDark ? '#FCA5A5' : '#B91C1C', fontSize: 13 }}>
            {props.errorMessage}
          </Text>
        </View>
      ) : null}

      {props.estimate ? (
        <View
          style={{
            marginTop: 16,
            paddingVertical: 14,
            borderTopWidth: 1,
            borderBottomWidth: 1,
            borderColor: palette.border,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ flex: 1, color: palette.muted, fontSize: 13 }}>
              Maximum approved cost
            </Text>
            <Text
              style={{
                color: palette.foreground,
                fontSize: 17,
                fontFamily: 'Roobert-Medium',
              }}
            >
              {props.estimate.max_approved_credits} credits
            </Text>
          </View>
          <PrimaryCommand
            label="Generate"
            pending={props.creating}
            enabled={props.canGenerate}
            palette={palette}
            onPress={props.onGenerate}
          />
        </View>
      ) : (
        <PrimaryCommand
          label="Estimate"
          pending={props.estimating}
          enabled={props.canEstimate}
          palette={palette}
          onPress={props.onEstimate}
        />
      )}
    </>
  );
}

function PrimaryCommand({
  label,
  pending,
  enabled,
  palette,
  onPress,
}: {
  label: string;
  pending: boolean;
  enabled: boolean;
  palette: Palette;
  onPress(): void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={!enabled}
      activeOpacity={0.8}
      style={{
        marginTop: label === 'Estimate' ? 18 : 12,
        minHeight: 46,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        backgroundColor: palette.foreground,
        opacity: enabled ? 1 : 0.45,
      }}
    >
      {pending ? (
        <ActivityIndicator color={palette.isDark ? '#121215' : '#FFFFFF'} />
      ) : (
        <Text
          style={{
            color: palette.isDark ? '#121215' : '#FFFFFF',
            fontFamily: 'Roobert-Medium',
          }}
        >
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

function TaskAndAssets({
  props,
  palette,
}: {
  props: MobileImageStudioViewProps;
  palette: Palette;
}) {
  return (
    <>
      {props.taskState ? (
        <View style={{ marginTop: 28 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text
              style={{
                flex: 1,
                color: palette.foreground,
                fontSize: 17,
                fontFamily: 'Roobert-Medium',
              }}
            >
              Current task
            </Text>
            <Text style={{ color: palette.muted, fontSize: 12, textTransform: 'capitalize' }}>
              {props.taskState.status.replace('_', ' ')}
            </Text>
          </View>
          <View
            style={{
              height: 6,
              marginTop: 12,
              borderRadius: 3,
              overflow: 'hidden',
              backgroundColor: palette.subtle,
            }}
          >
            <View
              style={{
                width: `${Math.round(props.taskState.progress * 100)}%` as `${number}%`,
                height: '100%',
                backgroundColor: props.taskState.status === 'failed' ? '#DC2626' : palette.primary,
              }}
            />
          </View>
          {!props.taskState.terminal ? (
            <TouchableOpacity
              onPress={props.onCancel}
              disabled={props.cancelling}
              style={{
                alignSelf: 'flex-start',
                marginTop: 12,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: palette.border,
              }}
            >
              <Text style={{ color: palette.foreground, fontSize: 13 }}>
                {props.cancelling ? 'Cancelling...' : 'Cancel'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {props.assets.length > 0 ? (
        <View style={{ marginTop: 28 }}>
          <Text style={{ color: palette.foreground, fontSize: 17, fontFamily: 'Roobert-Medium' }}>
            Outputs
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            {props.assets.map((asset) => {
              const url = props.previewUrls[asset.asset_id];
              return (
                <Pressable
                  key={asset.asset_id}
                  onPress={() => url && props.onPreview(asset.asset_id)}
                  style={{
                    width: '48%',
                    aspectRatio: 1,
                    borderRadius: 8,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: palette.border,
                    backgroundColor: palette.subtle,
                  }}
                >
                  {url ? (
                    <Image
                      source={{ uri: url }}
                      resizeMode="cover"
                      style={{ width: '100%', height: '100%' }}
                    />
                  ) : (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                      <ActivityIndicator color={palette.muted} />
                    </View>
                  )}
                  <TouchableOpacity
                    onPress={() => props.onDownload(asset)}
                    style={{
                      position: 'absolute',
                      right: 7,
                      bottom: 7,
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(0,0,0,0.72)',
                    }}
                  >
                    <Download size={15} color="#FFFFFF" />
                  </TouchableOpacity>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </>
  );
}

function RecentTasks({
  jobs,
  palette,
}: { jobs: readonly IntelligenceStudioJob[]; palette: Palette }) {
  if (jobs.length === 0) return null;
  return (
    <View style={{ marginTop: 30 }}>
      <Text style={{ color: palette.foreground, fontSize: 17, fontFamily: 'Roobert-Medium' }}>
        Recent tasks
      </Text>
      <View style={{ marginTop: 8 }}>
        {jobs.slice(0, 6).map((job, index) => (
          <View
            key={job.job_id}
            style={{
              paddingVertical: 12,
              borderTopWidth: index === 0 ? 0 : 1,
              borderColor: palette.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor:
                  job.status === 'succeeded'
                    ? '#16A34A'
                    : job.status === 'failed'
                      ? '#DC2626'
                      : job.status === 'cancelled'
                        ? palette.muted
                        : palette.primary,
              }}
            />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: palette.foreground, fontSize: 14 }}>
                {job.input.image.prompt}
              </Text>
              <Text numberOfLines={1} style={{ marginTop: 2, color: palette.muted, fontSize: 11 }}>
                {job.model}
              </Text>
            </View>
            <Text style={{ color: palette.muted, fontSize: 11, textTransform: 'capitalize' }}>
              {job.status}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function MobileImageStudioView(props: MobileImageStudioViewProps) {
  const { colorScheme } = useColorScheme();
  const theme = useThemeColors();
  const palette: Palette = {
    isDark: colorScheme === 'dark',
    foreground: colorScheme === 'dark' ? '#F8F8F8' : '#121215',
    muted: colorScheme === 'dark' ? '#A1A1AA' : '#71717A',
    border: colorScheme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.09)',
    subtle: colorScheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)',
    primary: theme.primary,
  };
  const previewAsset =
    props.assets.find((asset) => asset.asset_id === props.previewAssetId) ?? null;

  return (
    <View style={{ flex: 1, backgroundColor: palette.isDark ? '#121215' : '#F5F5F5' }}>
      <PageHeader
        title={
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <TouchableOpacity onPress={props.onBack} hitSlop={10} style={{ padding: 2 }}>
              <ChevronLeft size={22} color={palette.foreground} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: palette.foreground,
                  fontFamily: 'Roobert-Medium',
                  fontSize: 16,
                }}
              >
                Image Studio
              </Text>
              <Text style={{ color: palette.muted, fontFamily: 'Roobert', fontSize: 11 }}>
                Project workspace
              </Text>
            </View>
          </View>
        }
        hideRightDrawerToggle
        rightActions={
          <TouchableOpacity
            onPress={props.onRefresh}
            disabled={props.refreshing}
            hitSlop={10}
            style={{ padding: 5 }}
          >
            {props.refreshing ? (
              <ActivityIndicator size="small" color={palette.muted} />
            ) : (
              <RefreshCw size={18} color={palette.muted} />
            )}
          </TouchableOpacity>
        }
      />

      <PageContent>
        {props.loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={palette.primary} />
            <Text style={{ marginTop: 12, color: palette.muted }}>Loading Image Studio...</Text>
          </View>
        ) : props.unavailable ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 }}>
            <View
              style={{
                width: 54,
                height: 54,
                borderRadius: 8,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: palette.subtle,
              }}
            >
              <ImageIcon size={24} color={palette.muted} />
            </View>
            <Text
              style={{
                marginTop: 16,
                color: palette.foreground,
                fontSize: 17,
                fontFamily: 'Roobert-Medium',
              }}
            >
              Image generation unavailable
            </Text>
            <TouchableOpacity
              onPress={props.onRefresh}
              style={{
                marginTop: 16,
                paddingHorizontal: 18,
                paddingVertical: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: palette.border,
              }}
            >
              <Text style={{ color: palette.foreground, fontFamily: 'Roobert-Medium' }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={props.refreshing}
                onRefresh={props.onRefresh}
                tintColor={palette.muted}
              />
            }
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48 }}
          >
            <CreationControls props={props} palette={palette} />
            <TaskAndAssets props={props} palette={palette} />
            <RecentTasks jobs={props.jobs} palette={palette} />
          </ScrollView>
        )}
      </PageContent>

      <Modal
        visible={!!previewAsset}
        transparent
        animationType="fade"
        onRequestClose={() => props.onPreview(null)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.92)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 18,
          }}
        >
          <TouchableOpacity
            onPress={() => props.onPreview(null)}
            style={{
              position: 'absolute',
              top: 54,
              right: 18,
              zIndex: 2,
              width: 38,
              height: 38,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(255,255,255,0.12)',
            }}
          >
            <X size={20} color="#FFFFFF" />
          </TouchableOpacity>
          {previewAsset && props.previewUrls[previewAsset.asset_id] ? (
            <Image
              source={{ uri: props.previewUrls[previewAsset.asset_id] }}
              resizeMode="contain"
              style={{ width: '100%', height: '78%' }}
            />
          ) : null}
          {previewAsset ? (
            <TouchableOpacity
              onPress={() => props.onDownload(previewAsset)}
              style={{
                marginTop: 18,
                minHeight: 44,
                paddingHorizontal: 18,
                borderRadius: 8,
                backgroundColor: '#FFFFFF',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Download size={16} color="#121215" />
              <Text style={{ color: '#121215', fontFamily: 'Roobert-Medium' }}>Download</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}
