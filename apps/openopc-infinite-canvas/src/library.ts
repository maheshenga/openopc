import type { NodeKind, PromptRecord, WorkflowRecord } from './types';

export const DEFAULT_PROMPTS: PromptRecord[] = [
  {
    id: 'prompt-product-main',
    title: '电商产品主图',
    content: '白色摄影棚中的电商产品主图，柔和顶光，清晰材质，高级商业摄影，留出标题空间',
    tags: ['电商', '主图'],
    source: '内置',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
  {
    id: 'prompt-campaign-key-visual',
    title: '营销活动主视觉',
    content: '社交媒体活动视觉，强对比构图，品牌色点缀，主体突出，留出文案区域，商业广告质感',
    tags: ['营销', '社媒'],
    source: '内置',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
  {
    id: 'prompt-storyboard',
    title: '产品功能分镜',
    content: '产品功能分镜，四个连续镜头，统一角色和光线，清晰叙事节奏，适合短视频脚本',
    tags: ['视频', '分镜'],
    source: '内置',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
  {
    id: 'prompt-reverse-engineer',
    title: '参考图反推提示词',
    content:
      '根据参考图反推完整生成提示词，覆盖主体、构图、材质、镜头、光线和氛围，不虚构不可见细节',
    tags: ['分析', '参考图'],
    source: '内置',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
];

const STEP = (id: string, kind: NodeKind, title: string, prompt: string) => ({
  id,
  kind,
  title,
  prompt,
});

export const DEFAULT_WORKFLOWS: WorkflowRecord[] = [
  {
    id: 'workflow-product',
    title: '电商产品图',
    description: '卖点文案到主图与场景变体',
    variables: [{ key: 'product', label: '产品名称', defaultValue: '产品' }],
    steps: [
      STEP('product-text', 'text', '提炼卖点', '提炼 {{product}} 的核心卖点和视觉关键词'),
      STEP('product-main', 'image', '产品主图', '生成 {{product}} 的电商产品主图'),
      STEP('product-variant', 'image', '场景变体', '生成 {{product}} 的同风格场景变体'),
    ],
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
  {
    id: 'workflow-campaign',
    title: '营销活动套图',
    description: '策略、KV 和社交媒体延展',
    variables: [{ key: 'campaign', label: '活动主题', defaultValue: '新品活动' }],
    steps: [
      STEP('campaign-text', 'text', '活动策略', '制定 {{campaign}} 的视觉策略和传播关键词'),
      STEP('campaign-kv', 'image', '主视觉 KV', '生成 {{campaign}} 的活动主视觉 KV'),
      STEP('campaign-social', 'image', '社媒延展', '生成 {{campaign}} 的社交媒体延展图'),
    ],
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
  {
    id: 'workflow-video',
    title: '视频分镜',
    description: '脚本、关键帧、视频与音频引用',
    variables: [{ key: 'topic', label: '视频主题', defaultValue: '产品介绍' }],
    steps: [
      STEP('video-script', 'text', '分镜脚本', '编写 {{topic}} 的短视频分镜脚本'),
      STEP('video-keyframe', 'image', '关键帧', '生成 {{topic}} 的关键帧画面'),
      STEP('video-output', 'video', '视频', '根据分镜生成 {{topic}} 视频'),
      STEP('video-audio', 'audio', '配音', '准备 {{topic}} 的配音或背景音乐'),
    ],
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  },
];

export function cloneDefaults<T>(items: readonly T[]): T[] {
  return items.map((item) => structuredClone(item));
}
