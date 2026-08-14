import type { OpenOpcImageJob } from '@openopc/developer-sdk';
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock3,
  History,
  LoaderCircle,
  Plus,
  RotateCcw,
  Square,
} from 'lucide-react';
import { useState } from 'react';
import { cancelImageJob, openOpcErrorMessage } from '../lib/openopc-image-service';

type JobFilter = 'all' | 'active' | 'succeeded' | 'issues';

const JOB_FILTERS: Array<{ id: JobFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中' },
  { id: 'succeeded', label: '已完成' },
  { id: 'issues', label: '异常' },
];

interface JobsWorkspaceProps {
  jobs: OpenOpcImageJob[];
  jobError: string | null;
  loading: boolean;
  refreshing: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onRefresh: () => Promise<void>;
  onLoadMore: () => Promise<void>;
  onJobUpdated: (job: OpenOpcImageJob) => void;
  onUsePrompt: (prompt: string) => void;
}

function isActiveJob(job: OpenOpcImageJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function matchesFilter(job: OpenOpcImageJob, filter: JobFilter): boolean {
  if (filter === 'active') return isActiveJob(job);
  if (filter === 'succeeded') return job.status === 'succeeded';
  if (filter === 'issues') return job.status === 'failed' || job.status === 'cancelled';
  return true;
}

function formatCredits(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function formatCreatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function statusLabel(status: OpenOpcImageJob['status']): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '生成中';
  if (status === 'succeeded') return '已完成';
  if (status === 'cancelled') return '已取消';
  return '失败';
}

function JobStatusIcon({ status }: { status: OpenOpcImageJob['status'] }) {
  if (status === 'queued') return <Clock3 size={17} />;
  if (status === 'running') return <LoaderCircle size={17} className="spin" />;
  if (status === 'succeeded') return <CircleCheck size={17} />;
  if (status === 'cancelled') return <Ban size={17} />;
  return <CircleX size={17} />;
}

export function JobsWorkspace({
  jobs,
  jobError,
  loading,
  refreshing,
  hasMore,
  loadingMore,
  onRefresh,
  onLoadMore,
  onJobUpdated,
  onUsePrompt,
}: JobsWorkspaceProps) {
  const [filter, setFilter] = useState<JobFilter>('all');
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const visibleJobs = jobs.filter((job) => matchesFilter(job, filter));

  const cancel = async (job: OpenOpcImageJob) => {
    if (!job.cancellable || cancellingJobId) return;
    setCancellingJobId(job.job_id);
    setActionError(null);
    try {
      onJobUpdated(await cancelImageJob(job.job_id));
    } catch (reason) {
      setActionError(openOpcErrorMessage(reason, '取消任务失败'));
    } finally {
      setCancellingJobId(null);
    }
  };

  return (
    <section className="single-panel jobs-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Jobs</p>
          <h2>生成任务</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => void onRefresh()}
          disabled={loading || refreshing}
          aria-label="刷新任务"
          title="刷新任务"
        >
          <RotateCcw size={16} className={refreshing ? 'spin' : ''} />
        </button>
      </div>

      <div className="jobs-toolbar">
        <div className="segmented" aria-label="任务筛选">
          {JOB_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={filter === item.id ? 'segment is-active' : 'segment'}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="jobs-count">
          {visibleJobs.length} / {jobs.length}
        </span>
      </div>

      {jobError || actionError ? (
        <p className="inline-error jobs-error" role="alert">
          {jobError ?? actionError}
        </p>
      ) : null}

      {loading ? (
        <div className="empty-state compact">
          <LoaderCircle size={28} className="spin" />
          <p>正在读取任务</p>
        </div>
      ) : visibleJobs.length === 0 ? (
        <div className="empty-state compact">
          <History size={30} />
          <p>{jobs.length === 0 ? '还没有生成任务' : '当前筛选下没有任务'}</p>
          <span>{jobs.length === 0 ? '提交生图后会自动记录在这里' : '切换筛选查看其他状态'}</span>
        </div>
      ) : (
        <ul className="job-list">
          {visibleJobs.map((job) => {
            const usedCredits = job.actual_credits ?? job.reserved_credits;
            const errorMessage = job.error_code
              ? openOpcErrorMessage(new Error(job.error_code), `任务失败：${job.error_code}`)
              : null;
            return (
              <li className="job-row" key={job.job_id}>
                <span className={`job-state-icon is-${job.status}`} aria-hidden="true">
                  <JobStatusIcon status={job.status} />
                </span>
                <div className="job-content">
                  <div className="job-title-row">
                    <strong title={job.input.prompt}>{job.input.prompt}</strong>
                    <span className={`job-state-label is-${job.status}`}>
                      {statusLabel(job.status)}
                    </span>
                  </div>
                  <div className="job-facts">
                    <span title={job.model}>{job.model}</span>
                    <span>{job.input.aspect_ratio}</span>
                    <span>{job.input.output_count} 张</span>
                    <span>{formatCredits(usedCredits)} credits</span>
                    <span>{formatCreatedAt(job.created_at)}</span>
                  </div>
                  {errorMessage ? <p className="job-error-detail">{errorMessage}</p> : null}
                </div>
                <div className="job-actions">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => onUsePrompt(job.input.prompt)}
                    aria-label="复用提示词"
                    title="复用提示词"
                  >
                    <RotateCcw size={15} />
                  </button>
                  {job.cancellable ? (
                    <button
                      type="button"
                      className="icon-button danger-icon"
                      onClick={() => void cancel(job)}
                      disabled={cancellingJobId !== null}
                      aria-label="取消任务"
                      title="取消任务"
                    >
                      {cancellingJobId === job.job_id ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <Square size={13} />
                      )}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {jobs.length > 0 && hasMore ? (
        <div className="asset-pagination">
          <button
            type="button"
            className="button subtle"
            onClick={() => void onLoadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
            {loadingMore ? '加载中' : '加载更多'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
