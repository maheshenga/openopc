import { z } from 'zod';

export const OPENOPC_RELEASE_PROFILE_IDS = [
  'openopc-restricted-public-beta-v1',
  'openopc-web-desktop-developer-beta-v2',
  'openopc-image-studio-developer-beta-v3',
] as const;
export type OpenOpcReleaseProfileId = (typeof OPENOPC_RELEASE_PROFILE_IDS)[number];

export const OPENOPC_RELEASE_PROFILE_DIGESTS = {
  'openopc-restricted-public-beta-v1':
    'sha256:e548465c35cb5041b38092b2937164f2abecfb6781ab0e545532ce95f387956c',
  'openopc-web-desktop-developer-beta-v2':
    'sha256:28460381982dcfcfc67994c7f6fc091f920cffe82a23a7204e943c0693563b03',
  'openopc-image-studio-developer-beta-v3':
    'sha256:184ef4c2d10b8fe311b3b764c96c371c02295a67b445b0c5538b01e627a7267f',
} as const satisfies Record<OpenOpcReleaseProfileId, `sha256:${string}`>;

export const OpenOpcReleaseProfileIdSchema = z.enum(OPENOPC_RELEASE_PROFILE_IDS);

export const RESTRICTED_RUNTIME_CAPABILITIES = [
  'studio.text.generate',
  'studio.image.generate',
  'studio.video.generate',
  'module.wasi.execute',
  'module.oci.execute',
  'module.app.render',
  'module.ai.gateway',
  'commerce.purchase',
  'commerce.settlement',
  'native.mobile',
  'studio.3d',
  'studio.digital-human',
  'studio.batch-remix',
  'voice.realtime',
  'artifact.remote-url',
] as const;

export const RestrictedRuntimeCapabilitySchema = z.enum(RESTRICTED_RUNTIME_CAPABILITIES);

export type RestrictedRuntimeCapability =
  | 'studio.text.generate'
  | 'studio.image.generate'
  | 'studio.video.generate'
  | 'module.wasi.execute'
  | 'module.oci.execute'
  | 'module.app.render'
  | 'module.ai.gateway'
  | 'commerce.purchase'
  | 'commerce.settlement'
  | 'native.mobile'
  | 'studio.3d'
  | 'studio.digital-human'
  | 'studio.batch-remix'
  | 'voice.realtime'
  | 'artifact.remote-url';

export const RELEASE_PROFILE_UNAVAILABLE =
  'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE' as const;

export const RESTRICTED_DISABLED_CAPABILITIES = [
  'module.oci.execute',
  'module.app.render',
  'module.ai.gateway',
  'commerce.purchase',
  'commerce.settlement',
  'native.mobile',
  'studio.3d',
  'studio.digital-human',
  'studio.batch-remix',
  'voice.realtime',
  'artifact.remote-url',
] as const satisfies readonly RestrictedRuntimeCapability[];

export interface DisabledCapabilityRecordV1 {
  capability: RestrictedRuntimeCapability;
  artifactAbsent: boolean;
  deployedServiceAbsent: boolean;
  serverFlag: false;
  apiCliRejected: boolean;
  iamCapabilityAbsent: boolean;
  legacyDirectRouteRejected: boolean;
  uiAdvertised: false;
}

export interface DisabledStateAssessmentV1 {
  schemaVersion: 1;
  releaseProfileId: 'openopc-restricted-public-beta-v1';
  releaseProfileDigest: `sha256:${string}`;
  commit: string;
  controlSha: string;
  records: DisabledCapabilityRecordV1[];
  assessmentDigest: `sha256:${string}`;
}

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const ReleaseProfileStatusSchema = z
  .object({
    ready: z.boolean(),
    ready_for: OpenOpcReleaseProfileIdSchema.nullable(),
    release_profile_id: OpenOpcReleaseProfileIdSchema.nullable(),
    release_profile_digest: Sha256DigestSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const readyIdentity =
      value.ready_for !== null &&
      value.ready_for === value.release_profile_id &&
      value.release_profile_digest !== null;
    const unavailableIdentity =
      value.ready_for === null &&
      value.release_profile_id === null &&
      value.release_profile_digest === null;
    if ((value.ready && !readyIdentity) || (!value.ready && !unavailableIdentity)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'release profile readiness mismatch',
      });
    }
  });

export const ReleaseProfileUnavailableSchema = z
  .object({
    code: z.literal(RELEASE_PROFILE_UNAVAILABLE),
    capability: RestrictedRuntimeCapabilitySchema,
  })
  .strict();

export const DisabledCapabilityRecordV1Schema: z.ZodType<DisabledCapabilityRecordV1> = z
  .object({
    capability: RestrictedRuntimeCapabilitySchema,
    artifactAbsent: z.literal(true),
    deployedServiceAbsent: z.literal(true),
    serverFlag: z.literal(false),
    apiCliRejected: z.literal(true),
    iamCapabilityAbsent: z.literal(true),
    legacyDirectRouteRejected: z.literal(true),
    uiAdvertised: z.literal(false),
  })
  .strict();

export const DisabledStateAssessmentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    releaseProfileId: z.literal('openopc-restricted-public-beta-v1'),
    releaseProfileDigest: Sha256DigestSchema,
    commit: GitShaSchema,
    controlSha: GitShaSchema,
    records: z.array(DisabledCapabilityRecordV1Schema),
    assessmentDigest: Sha256DigestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.records.length !== RESTRICTED_DISABLED_CAPABILITIES.length ||
      value.records.some(
        (record, index) => record.capability !== RESTRICTED_DISABLED_CAPABILITIES[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'disabled capability records must match the protected profile',
        path: ['records'],
      });
    }
  });
