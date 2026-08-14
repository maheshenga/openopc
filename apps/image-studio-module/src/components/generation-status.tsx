import { LoaderCircle, Square } from 'lucide-react';
import type { OpenOpcImageEstimate, OpenOpcImageJob } from '@openopc/developer-sdk';

interface GenerationStatusProps {
  busy: boolean;
  job: OpenOpcImageJob | null;
  estimate: OpenOpcImageEstimate | null;
  progress: number | null;
  cancelling?: boolean;
  label?: string;
  onCancel?: () => void;
}

function formatCredits(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function formatExpiry(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function statusLabel(job: OpenOpcImageJob | null): string {
  if (!job) return '正在准备任务';
  if (job.status === 'queued') return '正在排队';
  if (job.status === 'running') return '正在生成';
  if (job.status === 'succeeded') return '正在整理结果';
  if (job.status === 'cancelled') return '任务已取消';
  return '任务失败';
}

export function GenerationStatus({
  busy,
  job,
  estimate,
  progress,
  cancelling = false,
  label,
  onCancel,
}: GenerationStatusProps) {
  if (!busy) return null;
  const normalizedProgress = progress === null
    ? null
    : Math.min(1, Math.max(0, progress));
  const canCancel = Boolean(onCancel && (!job || job.cancellable));
  const expiry = estimate ? formatExpiry(estimate.expires_at) : null;

  return (
    <div className="generation-status" aria-live="polite">
      <div className="job-status">
        <span>{label ?? statusLabel(job)}</span>
        <span className="progress-value">
          {normalizedProgress === null
            ? <LoaderCircle size={13} className="spin" />
            : `${Math.round(normalizedProgress * 100)}%`}
        </span>
      </div>
      <progress
        className="generation-progress"
        max={1}
        value={normalizedProgress ?? undefined}
        aria-label="生成进度"
      />
      {estimate?.line_items.length ? (
        <details className="estimate-details">
          <summary>费用明细</summary>
          <div className="estimate-lines">
            {estimate.line_items.map((item, index) => (
              <div className="estimate-line" key={`${item.label}-${index}`}>
                <span>{item.label}</span>
                <span>{formatCredits(item.credits)} credits</span>
              </div>
            ))}
            <div className="estimate-line estimate-total">
              <span>平台服务费</span>
              <span>{formatCredits(estimate.platform_cost_credits ?? 0)} credits</span>
            </div>
          </div>
        </details>
      ) : null}
      <div className="generation-meta">
        <span>
          {estimate
            ? `预估上限 ${formatCredits(estimate.max_approved_credits)} credits${expiry ? ` · 有效至 ${expiry}` : ''}`
            : '正在获取费用预估'}
        </span>
        {canCancel ? (
          <button
            type="button"
            className="cancel-job"
            onClick={onCancel}
            disabled={cancelling}
          >
            <Square size={11} />{cancelling ? '取消中' : '取消'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
