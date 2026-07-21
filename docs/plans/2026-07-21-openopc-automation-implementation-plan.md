# OpenOPC 浏览器与桌面自动化实施计划

> **给执行者：** 按任务顺序实施；每个任务先写一个会失败的定向测试，再写最小实现，运行该任务的验证命令，最后创建一个独立提交。不得把浏览器 Worker、桌面 Edge Agent 或控制服务的安全校验留给后续任务。

**目标：** 在保持 Kortix 核心能力和上游升级可吸收性的前提下，交付独立的 OpenOPC 自动化控制服务、隔离浏览器 Worker、受控桌面 Edge Agent、Web 工作台和桌面专属设备控制。

**架构：** Kortix API 继续拥有用户、团队、项目、Agent、会话、WorkflowPort、计费和 IAM。OpenOPC 通过一个薄适配器把版本化 `Automation Job Protocol` 发送到独立的 Automation Control Service；控制服务再把任务派发到 Browser Worker Pool 或现有 Tunnel/Agent Edge。浏览器和桌面是两个独立执行域，共享策略、审批、凭据、审计和急停，但各自再次执行本地策略校验。

**技术栈：** TypeScript、Bun、Hono、Zod、Drizzle/PostgreSQL、Redis、Playwright、rootless OCI 容器、mTLS WebSocket、SSE、OpenTelemetry、现有 `@kortix/sdk`、现有 `agent-tunnel`。

## 全局约束

- 产品显示名称为 OpenOPC；内部 Kortix 包名、路由和上游标识保持不变以便升级合并。
- `@kortix/sdk` 是唯一产品客户端；Web、桌面和第三方模块不得直接调用 Kortix API、Worker 或 Tunnel RPC。
- 不替换 IAM、WorkflowPort、Tunnel、Billing、Registry 或 Orchestration；所有新增逻辑放在扩展边界或独立服务。
- 默认分级授权：`Observe` 设备级、`Operate` 会话级、`ExternalEffect` 每次动作确认。
- 完全访问模式只能由设备所有者或管理员临时开启；不可逆动作仍需一次性确认。
- 默认项目域名白名单、任务级临时浏览器上下文；持久上下文和开放网络模式必须显式授权并自动过期。
- CUA 缺失时不得自动下载或执行安装程序；安装必须展示来源、版本、权限和校验结果并获得明确授权。
- 急停必须撤销租约、销毁浏览器上下文、停止桌面输入，并写入审计记录。
- Android/iOS 以及已取消的生图、生视频、语音、3D、数字人和批量混剪成品页面不在本计划范围内。
- 验证以定向测试和真实黑盒冒烟为主，不运行全量测试套件；任何未执行的发布级全量门槛必须在交付记录中明确标为未验证。
- 不写入或回显凭据；新增环境变量通过现有加密配置流程维护。

## 文件地图

### 现有边界（优先复用）

- `packages/intelligence-contracts/src/`：版本化、无副作用的 Zod wire contracts。
- `packages/db/src/schema/kortix.ts`、`packages/db/src/types.ts`、`packages/db/src/index.ts`：Kortix schema 单一来源。
- `apps/api/src/tunnel/`：现有 Tunnel 路由、权限检查、RPC 转发、审计和设备生命周期。
- `packages/agent-tunnel/src/agent/`：本地 Agent、能力注册、本地 PermissionGuard 和 CUA 驱动。
- `packages/sdk/src/core/rest/projects-client/`、`packages/sdk/src/core/client/kortix.ts`：SDK REST 方法和项目句柄。
- `apps/web/src/features/workspace/project-sidebar/`、`apps/web/src/app/(app)/projects/[id]/`：项目导航与页面布局。
- `apps/desktop-electron/src/main.js`、`preload.js`：桌面壳 IPC 和远程 Web 容器。

### 新增边界

- `apps/automation-control/`：独立控制服务，不向浏览器或桌面暴露未经策略包装的执行 API。
- `apps/automation-browser-worker/`：Playwright 执行进程，只接受签名租约和结构化动作。
- `apps/api/src/automation/`：Kortix 认证上下文到控制服务的薄适配器。
- `apps/web/src/features/automation/`：Web/桌面共享的自动化工作台组件。
- `apps/web/src/app/(app)/projects/[id]/automation/`：项目自动化路由。

---

## 里程碑 A：协议与持久化基础

### 任务 1：扩展自动化协议契约

**依赖：** 无

**文件：**

- 修改：`packages/intelligence-contracts/src/compatibility.ts`
- 创建：`packages/intelligence-contracts/src/automation.ts`
- 修改：`packages/intelligence-contracts/src/index.ts`
- 创建：`packages/intelligence-contracts/src/automation.test.ts`
- 修改：`packages/intelligence-contracts/src/compatibility.test.ts`

**对外接口：**

```ts
export const AUTOMATION_PROTOCOL_VERSION = 'automation.v1' as const;
export type AutomationExecutionDomain = 'browser' | 'desktop';
export type AutomationRisk = 'observe' | 'operate' | 'external_effect';
export type AutomationJobStatus =
  | 'queued' | 'awaiting_approval' | 'dispatched' | 'running'
  | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'retryable';

export type AutomationStep = {
  step_id: string;
  sequence: number;
  action: string;
  args: Record<string, unknown>;
  risk: AutomationRisk;
  action_hash: `sha256:${string}`;
};

export type AutomationCapabilityRequirement = {
  capability: string;
  methods: string[];
  scope: Record<string, unknown>;
};

export type BrowserPolicy = {
  allowed_origins: string[];
  network_mode: 'allowlist' | 'open';
  open_network_expires_at: string | null;
  context:
    | { mode: 'temporary'; profile_id: null }
    | { mode: 'persistent'; profile_id: string };
};

export type DesktopPolicy = {
  device_id: string;
  allowed_applications: string[];
  full_access_expires_at: string | null;
  kill_switch_generation: number;
};

export type AutomationJobRequest = {
  protocol_version: 'automation.v1';
  tenant_id: string;
  project_id: string;
  source_run_id: string | null;
  execution_domain: AutomationExecutionDomain;
  steps: AutomationStep[];
  capability_requirements: AutomationCapabilityRequirement[];
  approval_policy: 'project-default' | 'full-access';
  browser_policy: BrowserPolicy | null;
  desktop_policy: DesktopPolicy | null;
  idempotency_key: string;
  deadline_at: string;
  traceparent: string | null;
};

export type AutomationEventType =
  | 'job_queued' | 'approval_required' | 'job_dispatched' | 'job_started'
  | 'step_started' | 'step_completed' | 'job_succeeded' | 'job_failed'
  | 'job_cancelled' | 'job_expired' | 'kill_switch_activated' | 'heartbeat';

export type AutomationEvent = {
  protocol_version: 'automation.v1';
  event_id: string;
  job_id: string;
  sequence: number;
  type: AutomationEventType;
  status: AutomationJobStatus | null;
  payload: Record<string, unknown>;
  trace_id: string | null;
  created_at: string;
};

export type AutomationJob = {
  job_id: string;
  account_id: string;
  actor_user_id: string;
  request: AutomationJobRequest;
  request_hash: `sha256:${string}`;
  status: AutomationJobStatus;
  policy_version: string;
  kill_switch_generation: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
};

export type AutomationApproval = {
  approval_id: string;
  job_id: string;
  step_id: string;
  project_id: string;
  action_hash: `sha256:${string}`;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  acting_user_id: string | null;
  expires_at: string;
  resolved_at: string | null;
};

export type AutomationLease = {
  lease_id: string;
  job_id: string;
  project_id: string;
  execution_domain: AutomationExecutionDomain;
  owner: string;
  permission_id: string | null;
  request_hash: `sha256:${string}`;
  kill_switch_generation: number;
  issued_at: string;
  expires_at: string;
  signature: string;
};
```

**步骤：**

- [ ] 先在 `automation.test.ts` 写 schema fixture：合法浏览器任务、缺少 `project_id`、空动作列表、重复 `sequence`、已经过期的 `deadline_at`、错误动作哈希、`full-access` 搭配不可逆动作仍要求确认。
- [ ] 运行 `pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/automation.test.ts`，预期失败，因为新 schema 和常量尚不存在。
- [ ] 在 `automation.ts` 用 Zod `.strict()` 实现 `AutomationJobRequestSchema`、`AutomationJobSchema`、`AutomationEventSchema`、`AutomationApprovalSchema`、`AutomationLeaseSchema`、`BrowserPolicySchema`、`DesktopPolicySchema`、`KillSwitchSchema` 和 `AutomationErrorSchema`；所有 ID 使用 UUID，日期使用带 offset 的 ISO 字符串，动作参数限制为 JSON object，步骤数量上限为 128。
- [ ] 在 `compatibility.ts` 增加 `automation.v1`，在 `index.ts` 用显式 `.js` 后缀导出，确保 Bun 工作区和发布 tarball 的 ESM 解析一致。
- [ ] 运行 `pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/automation.test.ts src/compatibility.test.ts` 和 `pnpm.cmd --filter @kortix/intelligence-contracts typecheck`，预期全部通过。
- [ ] 提交：`git add packages/intelligence-contracts/src && git commit -m "feat: add automation wire contracts"`。

### 任务 2：建立自动化持久化模型与迁移

**依赖：** 任务 1

**文件：**

- 修改：`packages/db/src/schema/kortix.ts`
- 修改：`packages/db/src/types.ts`
- 修改：`packages/db/src/index.ts`
- 创建：`packages/db/migrations/20260721140000000_automation_control.sql`
- 创建：`packages/db/src/automation-schema.test.ts`

**数据模型：**

- `automation_jobs`：`job_id`、`account_id`、`project_id`、`actor_user_id`、`source_run_id`、`protocol_version`、`execution_domain`、`request_hash`、`idempotency_key`、`status`、`approval_policy`、`policy_snapshot_hash`、`lease_owner`、`lease_expires_at`、`cancel_requested_at`、`kill_switch_generation`、`deadline_at`、`created_at`、`updated_at`、`terminal_at`。
- `automation_job_steps`：`step_id`、`job_id`、`sequence`、`action`、`args`、`risk`、`action_hash`、`status`、`approval_id`、`started_at`、`ended_at`、`result_ref`、`error_code`。
- `automation_job_events`：`event_id`、`job_id`、正整数 `sequence`、`type`、`status`、`payload`、`trace_id`、`created_at`；以 `(job_id, sequence)` 唯一约束实现追加式事件序列。
- `automation_approvals`：`approval_id`、`job_id`、`step_id`、`action_hash`、`status`、`acting_user_id`、`token_hash`、`expires_at`、`resolved_at`、`created_at`。
- `automation_policies`：`project_id`、`allowed_origins`、`open_network_allowed`、`persistent_profiles_allowed`、`full_access_allowed`、`default_approval_policy`、`policy_version`、`updated_by`、时间戳。
- `automation_browser_profiles`：`profile_id`、`project_id`、加密对象存储引用、状态、创建者、最后使用时间和时间戳；不保存明文 Cookie 或 Token。
- `automation_kill_switches`：作用域（account/project/device）、递增 `generation`、启用者、启用时间和解除时间。

**步骤：**

- [ ] 先写 `automation-schema.test.ts`，断言表名、枚举值、唯一索引、项目/账户作用域索引和级联行为；为重复 `(job_id, sequence)`、重复幂等键和跨项目 profile 引用准备失败断言。
- [ ] 运行 `pnpm.cmd --filter @kortix/db exec bun test src/automation-schema.test.ts`，预期失败。
- [ ] 在 `kortix.ts` 添加枚举、表和 Drizzle relations；在 `types.ts` 和 `index.ts` 导出 select/insert 类型。
- [ ] 编写迁移：创建 schema 对象、枚举、表、索引、唯一约束和 `updated_at` 触发器；迁移必须使用 `IF NOT EXISTS`，不修改现有 Tunnel 表。
- [ ] 运行 `pnpm.cmd --filter @kortix/db exec bun test src/automation-schema.test.ts`、`pnpm.cmd --filter @kortix/db typecheck` 和 `pnpm.cmd --filter @kortix/db migrate:lint`，预期通过。
- [ ] 提交：`git add packages/db/src packages/db/migrations/20260721140000000_automation_control.sql && git commit -m "feat: persist automation jobs and approvals"`。

---

## 里程碑 B：独立控制服务与 Kortix 适配器

### 任务 3：创建 Automation Control Service 骨架与状态机

**依赖：** 任务 1、任务 2

**文件：**

- 创建：`apps/automation-control/package.json`
- 创建：`apps/automation-control/tsconfig.json`
- 创建：`apps/automation-control/Dockerfile`
- 创建：`apps/automation-control/src/config.ts`
- 创建：`apps/automation-control/src/state-machine.ts`
- 创建：`apps/automation-control/src/lease-manager.ts`
- 创建：`apps/automation-control/src/event-store.ts`
- 创建：`apps/automation-control/src/repository.ts`
- 创建：`apps/automation-control/src/server.ts`
- 创建：`apps/automation-control/src/main.ts`
- 创建：`apps/automation-control/src/state-machine.test.ts`
- 创建：`apps/automation-control/src/lease-manager.test.ts`
- 创建：`apps/automation-control/src/repository.test.ts`

**接口：**

```ts
export type AutomationTransitionEvent =
  | { type: 'approval_required' }
  | { type: 'approval_granted' }
  | { type: 'dispatched' }
  | { type: 'started' }
  | { type: 'succeeded' }
  | { type: 'failed'; retryable: boolean; externalEffectCommitted: boolean }
  | { type: 'cancelled' }
  | { type: 'lease_expired' }
  | { type: 'retry_allowed' };

export type AutomationActor = Readonly<{
  accountId: string;
  projectId: string;
  userId: string;
  roles: readonly ('member' | 'project_admin' | 'device_owner' | 'security_admin')[];
  deviceId: string | null;
}>;

export type AppendAutomationEventInput = {
  accountId: string;
  projectId: string;
  jobId: string;
  leaseOwner: string | null;
  killSwitchGeneration: number;
  event: Omit<AutomationEvent, 'event_id' | 'job_id' | 'sequence' | 'created_at'>;
  transition: AutomationTransitionEvent | null;
  occurredAt: Date;
};

export function transitionAutomationJob(
  current: AutomationJobStatus,
  event: AutomationTransitionEvent,
): AutomationJobStatus;

export interface LeaseManager {
  claim(jobId: string, owner: string, now: Date, ttlMs: number): Promise<AutomationLease | null>;
  heartbeat(jobId: string, owner: string, now: Date, ttlMs: number): Promise<boolean>;
  release(jobId: string, owner: string, now: Date): Promise<void>;
  isCurrent(jobId: string, owner: string, now: Date): Promise<boolean>;
}

export interface AutomationRepository {
  createJob(input: AutomationJobRequest, actor: AutomationActor): Promise<{ job: AutomationJob; created: boolean }>;
  getJobForProject(accountId: string, projectId: string, jobId: string): Promise<AutomationJob | null>;
  appendEvent(input: AppendAutomationEventInput): Promise<AutomationEvent>;
  requestCancellation(accountId: string, projectId: string, jobId: string, actorUserId: string): Promise<AutomationJob>;
}
```

**步骤：**

- [ ] 先写状态机表驱动测试：允许 `queued -> awaiting_approval -> dispatched -> running -> succeeded`，拒绝 `succeeded -> running`，允许 `running -> cancelled`，租约过期进入 `expired`，非幂等副作用禁止 `retryable`。
- [ ] 先写 repository 测试：相同 project/idempotency key 和相同 request hash 返回原 job；相同 key 不同 hash 返回冲突；事件 sequence 必须单调且事务失败时不推进 job 状态。
- [ ] 运行 `pnpm.cmd --filter @kortix/automation-control exec bun test src/state-machine.test.ts src/lease-manager.test.ts src/repository.test.ts`，预期失败。
- [ ] 创建 Bun/Hono 服务；`package.json` 必须定义 `start: bun run src/main.ts`、`typecheck: tsc --noEmit`、`test: bun test src`。运行时依赖固定为 `@kortix/db`、`@kortix/intelligence-contracts`、`drizzle-orm`、`hono` 和 `zod`：PostgreSQL 连接只通过 `@kortix/db` 导出的 `createDb(DATABASE_URL)` 创建，Redis 只使用 Bun 内置的 `RedisClient`，不再引入 `pg`、`postgres` 或第三方 Redis client。配置项必须包含 `AUTOMATION_CONTROL_ENABLED=false`、`AUTOMATION_CONTROL_PORT`、`DATABASE_URL`、`REDIS_URL`、`AUTOMATION_SERVICE_ID`、`AUTOMATION_CONTROL_SHARED_SECRET` 和 `AUTOMATION_LEASE_MS`，禁用时健康检查返回 `disabled` 而不是接受任务。
- [ ] 用数据库条件更新实现 fencing lease：只有当前 `lease_owner` 且 `lease_expires_at > now()` 的 Worker 可以 heartbeat、写事件和完成任务；事件写入与状态变更放进同一事务。
- [ ] 添加 `GET /health` 和 `GET /ready`，返回协议版本、feature flag、数据库和 Redis 状态，不返回密钥。
- [ ] 运行 `pnpm.cmd --filter @kortix/automation-control typecheck` 和两个定向测试，预期通过。
- [ ] 提交：`git add apps/automation-control && git commit -m "feat: scaffold automation control service"`。

### 任务 4：实现策略判定、审批令牌与急停

**依赖：** 任务 3

**文件：**

- 创建：`apps/automation-control/src/policy/types.ts`
- 创建：`apps/automation-control/src/policy/evaluate.ts`
- 创建：`apps/automation-control/src/policy/origin-policy.ts`
- 创建：`apps/automation-control/src/approval-service.ts`
- 创建：`apps/automation-control/src/kill-switch-service.ts`
- 创建：`apps/automation-control/src/credential-broker.ts`
- 创建：`apps/automation-control/src/policy/evaluate.test.ts`
- 创建：`apps/automation-control/src/approval-service.test.ts`
- 创建：`apps/automation-control/src/kill-switch-service.test.ts`
- 创建：`apps/automation-control/src/credential-broker.test.ts`

**接口：**

```ts
export type PolicyInput = Readonly<{
  actor: AutomationActor;
  job: AutomationJobRequest;
  step: AutomationStep;
  policy: {
    version: string;
    allowedOrigins: readonly string[];
    openNetworkAllowed: boolean;
    persistentProfilesAllowed: boolean;
    fullAccessAllowed: boolean;
  };
  target: {
    origin: string | null;
    resolvedAddresses: readonly string[];
    deviceId: string | null;
    applicationId: string | null;
  };
  now: Date;
}>;

export type ApprovalRequest = {
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  requestedByUserId: string;
  expiresAt: Date;
};

export type OneTimeApprovalToken = {
  token: string;
  approvalId: string;
  projectId: string;
  actionHash: `sha256:${string}`;
  expiresAt: string;
};

export type KillSwitchScope =
  | { kind: 'account'; accountId: string }
  | { kind: 'project'; accountId: string; projectId: string }
  | { kind: 'device'; accountId: string; projectId: string; deviceId: string };

export type PolicyDecision =
  | { allowed: true; policyVersion: string; risk: AutomationRisk; approvalRequired: boolean }
  | { allowed: false; code: 'ORIGIN_DENIED' | 'SCOPE_DENIED' | 'ROLE_DENIED' | 'FEATURE_DISABLED'; reason: string };

export function evaluateAutomationPolicy(input: PolicyInput): PolicyDecision;

export interface ApprovalService {
  request(input: ApprovalRequest): Promise<AutomationApproval>;
  resolve(input: { accountId: string; projectId: string; approvalId: string; actionHash: `sha256:${string}`; actorUserId: string; decision: 'approve' | 'reject' }): Promise<OneTimeApprovalToken | null>;
  consume(input: { token: string; projectId: string; approvalId: string; actionHash: `sha256:${string}`; now: Date }): Promise<boolean>;
}

export interface KillSwitchService {
  activate(scope: KillSwitchScope, actor: AutomationActor): Promise<{ generation: number; auditEventId: string }>;
  current(scope: KillSwitchScope): Promise<number>;
}
```

**步骤：**

- [ ] 先写策略测试：项目白名单允许精确 origin 和合法子路径，拒绝不匹配 origin、私网地址、DNS 重绑定目标和跨项目 profile；开放网络只接受管理员且必须有 `expires_at`；普通成员不能开启完全访问；完全访问下 `external_effect` 仍返回 `approvalRequired: true`。
- [ ] 先写审批测试：动作哈希不匹配、过期、重复消费、错误项目和错误操作者全部失败；同一令牌只能成功一次。
- [ ] 先写急停测试：激活 scope 后 generation 递增，旧租约和旧令牌被拒绝；控制服务重启后从数据库恢复 generation。
- [ ] 先写凭据测试：Broker 只返回短期引用，响应和审计 payload 不含 `authorization`、`cookie`、`password`、`token`、签名 URL 等字段。
- [ ] 运行四个测试文件，预期失败。
- [ ] 实现 `RBAC + ABAC` 判定；origin 解析使用 URL parser，不用字符串前缀比较；动作风险由服务端根据 action catalog 重新计算，不能信任客户端传入值。
- [ ] 生成随机一次性审批令牌，只保存 SHA-256 hash；令牌绑定 `approval_id + action_hash + project_id + expires_at`。
- [ ] 急停写数据库和 Redis，执行端每次续租校验 generation；停止事件通过控制服务事件流和 Tunnel notification 同时发送。
- [ ] Broker 只签发短期 credential reference，真实秘密通过现有项目 secrets/connector 服务读取并在执行前注入，严禁进入模型 prompt、普通事件或截图。
- [ ] 运行定向测试和 `pnpm.cmd --filter @kortix/automation-control typecheck`，预期通过。
- [ ] 提交：`git add apps/automation-control/src && git commit -m "feat: enforce automation policy and approvals"`。

### 任务 5：实现控制服务内部 API 与 Kortix 认证适配器

**依赖：** 任务 3、任务 4

**文件：**

- 创建：`apps/automation-control/src/internal-auth.ts`
- 创建：`apps/automation-control/src/routes/jobs.ts`
- 创建：`apps/automation-control/src/routes/approvals.ts`
- 创建：`apps/automation-control/src/routes/profiles.ts`
- 创建：`apps/automation-control/src/routes/policies.ts`
- 创建：`apps/automation-control/src/routes/kill-switch.ts`
- 创建：`apps/automation-control/src/routes/events.ts`
- 创建：`apps/automation-control/src/routes/routes.test.ts`
- 创建：`apps/api/src/automation/index.ts`
- 创建：`apps/api/src/automation/control-client.ts`
- 创建：`apps/api/src/automation/auth-context.ts`
- 创建：`apps/api/src/automation/ag-ui/projector.ts`
- 创建：`apps/api/src/automation/ag-ui/projector.test.ts`
- 创建：`apps/api/src/automation/routes/jobs.ts`
- 创建：`apps/api/src/automation/routes/approvals.ts`
- 创建：`apps/api/src/automation/routes/devices.ts`
- 创建：`apps/api/src/automation/routes/profiles.ts`
- 创建：`apps/api/src/automation/routes/policies.ts`
- 创建：`apps/api/src/automation/routes/kill-switch.ts`
- 创建：`apps/api/src/automation/routes/events.ts`
- 创建：`apps/api/src/automation/routes.test.ts`
- 修改：`apps/api/src/config.ts`
- 修改：`apps/api/src/index.ts`

**接口：**

- `POST /v1/automation/jobs`
- `GET /v1/automation/jobs/:jobId`
- `GET /v1/automation/jobs/:jobId/events`
- `POST /v1/automation/jobs/:jobId/cancel`
- `GET /v1/automation/approvals?status=pending`
- `POST /v1/automation/approvals/:approvalId/resolve`
- `GET /v1/automation/devices`
- `GET/POST /v1/automation/browser-profiles`
- `DELETE /v1/automation/browser-profiles/:profileId`
- `GET/PUT /v1/automation/policies`
- `POST /v1/automation/kill-switch`

**步骤：**

- [ ] 先写控制服务 route 测试：缺少、过期或错误 service signature 返回 401；body 不符合 `AutomationJobRequestSchema` 返回 400；相同幂等请求返回原 job；SSE 从 cursor 后开始且 sequence 单调；响应不泄漏 Worker URL、credential reference 或内部错误 payload。
- [ ] 先写 Kortix API 路由测试：无 Supabase/PAT 身份返回 401；用户不属于项目返回 403；跨账户 job/profile/approval ID 返回 404；feature flag 关闭返回稳定 `AUTOMATION_UNAVAILABLE`；合法请求只生成一份带 `tenantId`、`projectId`、`sourceRunId`、actor 和 trace context 的内部调用。
- [ ] 先写 AG-UI projector 测试：job 创建、运行、步骤、审批、成功和失败映射到现有 `OpenOpcAgUiEvent` 子集；敏感 args、credential reference、URL query 和截图内容不能进入投影。
- [ ] 运行 `pnpm.cmd --filter @kortix/automation-control exec bun test src/routes/routes.test.ts` 和 `pnpm.cmd --filter kortix-api exec bun test src/automation/routes.test.ts src/automation/ag-ui/projector.test.ts`，预期失败。
- [ ] 在控制服务创建仅内部可访问的 job、approval、profile、policy、kill-switch 和 event routes；每个请求先经过 timestamp + HMAC/mTLS service identity，再经过 Zod schema 和 project/account scope 检查。
- [ ] 按 `apps/api/src/tunnel/index.ts` 的 OpenAPI Hono 模式创建子应用，并在 `apps/api/src/index.ts` 挂载 `/v1/automation`；认证复用现有 `supabaseAuth`、PAT 和项目成员/权限查询，不建立第二套用户登录。
- [ ] `control-client.ts` 使用内部 mTLS；本地开发可使用带时间戳和 HMAC 的 service header，服务端拒绝超过 60 秒的请求。所有响应通过 `@kortix/intelligence-contracts` parser 校验后再返回。
- [ ] `ag-ui/projector.ts` 复用 `apps/api/src/intelligence/ag-ui/projector.ts` 的安全投影模式，将 durable automation events 转换为 `RUN_STARTED`、`STEP_STARTED`、`STATE_SNAPSHOT`、`TOOL_CALL_RESULT`、`RUN_FINISHED` 或 `RUN_ERROR`，不创建第二套事件协议。
- [ ] 为 GET/POST/DELETE 路由加入项目作用域、幂等键、请求大小、事件 cursor 和 SSE heartbeat 限制；任何 Worker URL、长效 credential 或原始 provider payload 不出现在响应。
- [ ] 在 `config.ts` 增加 `AUTOMATION_CONTROL_ENABLED`、`AUTOMATION_CONTROL_URL`、`AUTOMATION_CONTROL_SHARED_SECRET`、`AUTOMATION_CONTROL_MTLS_CA` 和安全的超时默认值，默认关闭。
- [ ] 运行控制服务 route 测试、Kortix API 定向测试、`pnpm.cmd --filter @kortix/automation-control typecheck` 和 `pnpm.cmd --filter kortix-api typecheck`，预期通过。
- [ ] 提交：`git add apps/automation-control/src/routes apps/automation-control/src/internal-auth.ts apps/api/src/automation apps/api/src/config.ts apps/api/src/index.ts && git commit -m "feat: expose scoped automation API"`。

---

## 里程碑 C：执行域

### 任务 6：加固 Desktop Edge Agent 的本地校验与显式 CUA 安装

**依赖：** 任务 1、任务 4、任务 5

**文件：**

- 修改：`packages/agent-tunnel/src/agent/security/permission-guard.ts`
- 修改：`packages/agent-tunnel/src/agent/agent.ts`
- 修改：`packages/agent-tunnel/src/agent/capabilities/desktop.ts`
- 修改：`packages/agent-tunnel/src/agent/capabilities/desktop/cua-driver.ts`
- 创建：`packages/agent-tunnel/src/agent/security/automation-action-policy.ts`
- 创建：`packages/agent-tunnel/src/agent/security/permission-guard.test.ts`
- 修改：`packages/agent-tunnel/src/agent/service.test.ts`
- 创建：`packages/agent-tunnel/src/agent/capabilities/desktop/cua-driver.test.ts`

**接口：**

```ts
export interface LocalPermission {
  permissionId: string;
  capability: string;
  scope: Record<string, unknown>;
  expiresAt?: string;
  policyVersion?: string;
}

export class PermissionGuard {
  checkRequest(input: {
    permissionId: string | undefined;
    capability: string;
    method: string;
    params: Record<string, unknown>;
    now?: number;
  }): LocalPermission;
  revokeAll(): void;
}

export interface CuaInstallApproval {
  approved: true;
  source: 'github-release' | 'operator-package';
  expectedSha256: string;
  expiresAt: string;
}
```

**步骤：**

- [ ] 先写本地安全测试：未知 permission ID、过期权限、capability 不匹配、desktop method 不在 scope、错误 action hash 和 kill-switch generation 全部拒绝；合法 `screenshot` 读取通过。
- [ ] 先写 CUA 测试：`createDesktopCapability()` 初始化后不下载、不启动 daemon；`status` 在缺失 binary 时返回 `missing`；未带 `CuaInstallApproval` 的安装调用拒绝；哈希、来源或过期时间不匹配拒绝。
- [ ] 运行 `pnpm.cmd --filter @kortix/agent-tunnel exec bun test src/agent/security/permission-guard.test.ts src/agent/capabilities/desktop/cua-driver.test.ts`，预期失败。
- [ ] 扩展 `PermissionGuard`，同时校验 permission、capability、method、scope、policyVersion 和过期时间；在 `TunnelAgent.handleRpcRequest` 中先完成该校验，再查 capability registry，再调用 handler。
- [ ] 删除 `createDesktopCapability()` 的后台 `ensureInstalled/startDaemon` bootstrap；`desktop.cua.ensure` 只接受带批准对象的显式安装请求，并在安装前下载到临时文件、校验 SHA-256、限制脚本来源和执行参数。
- [ ] 添加签名 `automation.kill_switch` notification 处理：撤销所有本地租约、清空权限缓存、停止 CUA 输入会话；断开连接时也必须进入停止状态。
- [ ] 运行定向 Agent 测试、`pnpm.cmd --filter @kortix/agent-tunnel typecheck` 和 `pnpm.cmd --filter @kortix/agent-tunnel test` 中仅列出的新增/受影响文件，预期通过。
- [ ] 提交：`git add packages/agent-tunnel/src && git commit -m "fix: harden local automation authorization"`。

### 任务 7：创建隔离 Browser Worker

**依赖：** 任务 1、任务 3、任务 4

**文件：**

- 创建：`apps/automation-browser-worker/package.json`
- 创建：`apps/automation-browser-worker/tsconfig.json`
- 创建：`apps/automation-browser-worker/Dockerfile`
- 创建：`apps/automation-browser-worker/src/config.ts`
- 创建：`apps/automation-browser-worker/src/origin-guard.ts`
- 创建：`apps/automation-browser-worker/src/context-manager.ts`
- 创建：`apps/automation-browser-worker/src/action-runner.ts`
- 创建：`apps/automation-browser-worker/src/evidence-writer.ts`
- 创建：`apps/automation-browser-worker/src/worker.ts`
- 创建：`apps/automation-browser-worker/src/origin-guard.test.ts`
- 创建：`apps/automation-browser-worker/src/action-runner.test.ts`
- 创建：`apps/automation-browser-worker/src/context-manager.test.ts`

**接口：**

```ts
export interface BrowserActionRunner {
  run(input: {
    lease: AutomationLease;
    steps: readonly AutomationStep[];
    policy: BrowserPolicy;
    signal: AbortSignal;
  }): Promise<ReadonlyArray<AutomationEvent>>;
}

export function isAllowedBrowserUrl(url: string, policy: BrowserPolicy): Promise<boolean>;
```

**步骤：**

- [ ] 先写 origin guard 测试：精确白名单通过，端口/协议变化、跨域重定向、`127.0.0.1`、RFC1918、IPv6 loopback、云元数据地址、DNS 解析到私网的域名和开放网络未获授权全部拒绝。
- [ ] 先写 action runner 测试：允许 `navigate/click/fill/read/screenshot`，拒绝 `evaluate`、任意脚本、未声明 action、超过步骤上限和下载到执行路径；`submit/delete/send` 产生 `approval_required` 事件并暂停。
- [ ] 先写 context manager 测试：临时上下文结束清理，持久 profile 只接受同一 project ID 的加密引用，kill signal 后 browser/context/page 全部关闭。
- [ ] 运行三个测试文件，预期失败。
- [ ] 创建 `package.json`，定义 `start: bun run src/worker.ts`、`typecheck: tsc --noEmit`、`test: bun test src`，依赖 `@kortix/intelligence-contracts` 和 Playwright；使用 Playwright 创建 rootless 容器内的 Chromium，为每个请求创建独立 context，所有请求通过 `context.route` 经过 origin guard，禁止 `page.evaluate` 和任意 JS 注入。
- [ ] 导航、点击和输入使用结构化 locator/坐标动作；每一步重新检查租约、kill-switch generation、origin 和动作哈希；下载写入隔离临时目录并只产生证据引用。
- [ ] 对持久 profile 使用加密对象存储引用和一次性 Broker credential，不把 profile 目录挂载到宿主机；设置 CPU、内存、步骤、下载和执行时长上限。
- [ ] 运行定向测试和 `pnpm.cmd --filter @kortix/automation-browser-worker typecheck`，预期通过。
- [ ] 提交：`git add apps/automation-browser-worker && git commit -m "feat: add isolated browser automation worker"`。

### 任务 8：连接控制服务与两个执行域

**依赖：** 任务 4、任务 5、任务 6、任务 7

**文件：**

- 创建：`apps/automation-control/src/dispatch/browser-dispatcher.ts`
- 创建：`apps/automation-control/src/dispatch/desktop-dispatcher.ts`
- 创建：`apps/automation-control/src/dispatch/worker-auth.ts`
- 创建：`apps/automation-control/src/dispatch/heartbeat.ts`
- 创建：`apps/automation-control/src/dispatch/retry-policy.ts`
- 创建：`apps/automation-control/src/dispatch/dispatch.test.ts`
- 创建：`apps/automation-control/src/dispatch/retry-policy.test.ts`

**步骤：**

- [ ] 先写 dispatch 测试：浏览器任务只能发送到 Browser Worker，桌面任务只能通过现有 Tunnel `executeTunnelRpc` 到指定 tunnel；执行域不匹配、账户不匹配、旧租约、旧 generation 和错误 service signature 全部拒绝。
- [ ] 先写 retry 测试：读取/截图等幂等动作可在租约恢复后重试；点击提交、支付、删除、发送等 `external_effect` 不自动重试；未知结果进入 `retryable`/`expired` 并要求人工处理。
- [ ] 运行两个测试文件，预期失败。
- [ ] Browser dispatcher 通过 mTLS service identity 派发签名 job envelope；Worker 通过 heartbeat 返回事件序号和证据引用，控制服务用事务性 outbox 持久化后再推送 SSE。
- [ ] Desktop dispatcher 只调用现有 `executeTunnelRpc`/`relayRpcToConnectedAgent`，把 `permissionId`、job lease、action hash 和 trace context 放入受控 params；不创建第二条桌面 RPC 通道。
- [ ] 统一处理 heartbeat、租约 fencing、断线、kill switch、Worker 崩溃和服务重启；完成任务前再次检查不可逆动作是否有未消费的一次性批准令牌。
- [ ] 运行控制服务定向测试和 `pnpm.cmd --filter @kortix/automation-control typecheck`，预期通过。
- [ ] 提交：`git add apps/automation-control/src/dispatch && git commit -m "feat: dispatch scoped automation jobs"`。

---

## 里程碑 D：客户端与用户界面

### 任务 9：扩展 `@kortix/sdk` 自动化表面

**依赖：** 任务 1、任务 5、任务 8

**文件：**

- 创建：`packages/sdk/src/core/rest/projects-client/automation.ts`
- 创建：`packages/sdk/src/core/rest/projects-client/automation.test.ts`
- 修改：`packages/sdk/src/core/rest/projects-client/index.ts`
- 修改：`packages/sdk/src/core/client/kortix.ts`
- 创建：`packages/sdk/src/react/use-automation.ts`
- 创建：`packages/sdk/src/react/use-automation.test.tsx`
- 修改：`packages/sdk/src/react/index.ts`
- 修改：`packages/sdk/src/public-surface.test.ts`
- 修改：`packages/sdk/src/public-type-surface.test.ts`

**公开方法：**

```ts
project(projectId).automation.jobs.create(input);
project(projectId).automation.jobs.get(jobId);
project(projectId).automation.jobs.events(jobId, cursor?);
project(projectId).automation.jobs.cancel(jobId);
project(projectId).automation.approvals.list();
project(projectId).automation.approvals.resolve(approvalId, input);
project(projectId).automation.devices.list();
project(projectId).automation.browserProfiles.list();
project(projectId).automation.browserProfiles.create(input);
project(projectId).automation.browserProfiles.revoke(profileId);
project(projectId).automation.policy.get();
project(projectId).automation.policy.set(input);
project(projectId).automation.killSwitch.activate(scope);
```

**步骤：**

- [ ] 先在 `automation.test.ts` 写真实 wire fixture 测试：每个方法使用 `backendApi`，解析成功响应，拒绝 malformed 2xx、跨项目 ID、未知错误码和含凭据字段的 payload；SSE 使用现有 `openEventStream` 并验证 cursor/heartbeat/reconnect。
- [ ] 先在 `use-automation.test.tsx` 写 query key、轮询、mutation invalidation 和取消后的终态测试。
- [ ] 运行 `pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/automation.test.ts src/react/use-automation.test.tsx`，预期失败。
- [ ] 在 `automation.ts` 复用现有 `unwrap`、`backendApi`、安全错误码 parser 和 `platformConfig`；不要在 SDK 中 import React、Next、Tunnel 或 Worker 包。
- [ ] 在 `kortix.ts` 以直接引用方式挂到现有 `project().intelligence` 同级的 `automation` 句柄；在 barrel 和 public snapshots 中只增加名称，不删除或重命名已有导出。
- [ ] 在 React 层只包装 SDK 方法，使用现有 TanStack Query 约定；SSE 复用 SDK event stream，不在 Web host 手写 `fetch`。
- [ ] 运行新增测试、`pnpm.cmd --filter @kortix/sdk typecheck`、`pnpm.cmd --filter @kortix/sdk exec bun test src/public-surface.test.ts src/public-type-surface.test.ts`；按用户约束不运行完整 SDK suite，交付记录标明该发布级门槛未执行。
- [ ] 提交：`git add packages/sdk/src && git commit -m "feat: expose automation through sdk"`。

### 任务 10：实现 Web/桌面共享自动化工作台

**依赖：** 任务 9

**文件：**

- 创建：`apps/web/src/app/(app)/projects/[id]/automation/page.tsx`
- 创建：`apps/web/src/features/automation/automation-workbench.tsx`
- 创建：`apps/web/src/features/automation/automation-live-view.tsx`
- 创建：`apps/web/src/features/automation/automation-inspector.tsx`
- 创建：`apps/web/src/features/automation/automation-timeline.tsx`
- 创建：`apps/web/src/features/automation/automation-approval-bar.tsx`
- 创建：`apps/web/src/features/automation/automation-device-panel.tsx`
- 创建：`apps/web/src/features/automation/use-automation-workbench.ts`
- 创建：`apps/web/src/features/automation/automation-workbench.test.tsx`
- 创建：`apps/web/src/features/automation/automation-approval-bar.test.tsx`
- 创建：`apps/web/src/features/workspace/project-sidebar/footer/project-automation-nav.tsx`
- 修改：`apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx`

**交互契约：**

- Web 端默认打开 `/projects/:id/automation`，可独立创建浏览器任务，不依赖桌面进程。
- 左侧导航为任务、浏览器、设备、审计；中央为实时页面/桌面视图和事件时间线；右侧为项目、域名、能力、上下文、审批和完全访问状态。
- 顶部始终显示急停；高风险动作以内联审批条暂停，不连续弹窗打断低风险步骤。
- 桌面端复用同一路由，只有在 `isDesktop()` 且设备在线时显示本地窗口、Edge Agent 版本、能力开关和输入暂停状态。

**步骤：**

- [ ] 先写组件测试：未登录/feature flag off 不显示入口；Web 任务显示临时隔离和域名策略；`ExternalEffect` 显示动作摘要和确认按钮；确认后只提交当前 action hash；急停后所有操作按钮变为停止/已停止；桌面离线不允许发送桌面任务。
- [ ] 运行 `pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/automation/automation-workbench.test.tsx src/features/automation/automation-approval-bar.test.tsx`，预期失败。
- [ ] 组合现有 `@/components/ui/*`、`SidebarMenuButton`、`Table`、`Badge` 和 `Button`，遵循中性 Google 风格、紧凑信息层级和稳定布局；不引入新的 UI 框架或装饰性大卡片。
- [ ] `use-automation-workbench.ts` 只调用 `@kortix/sdk/react`，以 query key 绑定 project/job，订阅 SSE 后按 sequence 去重；页面卸载时关闭订阅，不取消服务器任务。
- [ ] `automation-live-view.tsx` 只渲染服务端提供的截图/安全 viewport 引用，不把任意 HTML 注入主页面；错误、等待审批、失联、已急停和完成均有明确状态。
- [ ] 在项目侧边栏增加入口测试，确保现有 Studio 只保留 image/assets，已取消的 video/voice/3d/digital-human/batch-remix 路径不回归。
- [ ] 运行新增组件测试和 `pnpm.cmd --filter Kortix-Computer-Frontend exec eslint "src/features/automation" "src/app/(app)/projects/[id]/automation"`；不运行全量 Web 测试。
- [ ] 提交：`git add apps/web/src/app apps/web/src/features/automation apps/web/src/features/workspace/project-sidebar && git commit -m "feat: add automation workbench"`。

### 任务 11：把桌面壳接入 Edge Agent 生命周期

**依赖：** 任务 6、任务 10

**文件：**

- 创建：`apps/desktop-electron/src/automation-edge.js`
- 创建：`apps/desktop-electron/src/automation-edge.test.js`
- 修改：`apps/desktop-electron/src/main.js`
- 修改：`apps/desktop-electron/src/preload.js`
- 修改：`apps/desktop-electron/package.json`

**IPC 接口：**

```js
automation_edge_status
automation_edge_start
automation_edge_stop
automation_edge_install_cua
automation_edge_kill_switch
```

**步骤：**

- [ ] 先写 `automation-edge.test.js`：不受信页面调用 IPC 被拒绝；未授权 install 被拒绝；start/stop 只管理本应用创建的子进程；kill switch 先发送停止再 kill；进程退出后状态变为 offline。
- [ ] 运行 `pnpm.cmd --filter @kortix/desktop-electron exec node --test src/automation-edge.test.js`，预期失败。
- [ ] 在 `package.json` 增加 `agent-tunnel: workspace:@kortix/agent-tunnel@*` 并将 CLI 作为受控 extra resource 打包；在 `automation-edge.js` 使用 `child_process.spawn` 启动该 CLI，记录 PID、设备 ID、退出码和心跳；不把 API token 放进 argv 或日志，使用受保护的用户配置路径和环境注入。
- [ ] 在 `main.js` 的 `isTrustedSender` IPC funnel 中加入上述命令；保留 origin gate、参数白名单和当前窗口绑定，禁止预览页或外部 OAuth popup 调用。
- [ ] `preload.js` 只暴露窄接口，Web 端通过 `window.__TAURI__.core.invoke` 获取状态；CUA 安装命令必须携带服务端返回的显式授权摘要和校验值。
- [ ] 运行 Node 测试、`pnpm.cmd --filter @kortix/desktop-electron exec node --check src/main.js` 和 `node --check src/automation-edge.js`，预期通过。
- [ ] 提交：`git add apps/desktop-electron/src apps/desktop-electron/package.json && git commit -m "feat: manage desktop automation edge"`。

---

## 里程碑 E：运维、指标与上线

### 任务 12：接入可观测性、Compose 和 feature flags

**依赖：** 任务 3、任务 7、任务 8、任务 10、任务 11

**文件：**

- 修改：`apps/api/src/ops/index.ts`
- 修改：`apps/web/src/hooks/admin/use-ops-overview.ts`
- 修改：`apps/web/src/app/admin/ops/page.tsx`
- 创建：`apps/web/src/app/admin/ops/automation-ops-panel.tsx`
- 创建：`apps/api/src/ops/automation-metrics.test.ts`
- 修改：`scripts/compose/docker-compose.yml`
- 修改：`apps/automation-control/Dockerfile`
- 修改：`apps/automation-browser-worker/Dockerfile`
- 修改：`.github/workflows/ci.yml`
- 修改：`.github/workflows/package-tests.yml`
- 创建：`docs/operations/automation-control.md`
- 创建：`docs/operations/automation-kill-switch.md`

**步骤：**

- [ ] 先写 `automation-metrics.test.ts`：空数据返回稳定零值；按 execution domain 聚合任务、审批等待、失败、租约失效、急停延迟和 Browser Worker/Edge 在线数；查询不能跨账户泄漏 payload。
- [ ] 运行 `pnpm.cmd --filter kortix-api exec bun test src/ops/automation-metrics.test.ts`，预期失败。
- [ ] 在 Ops overview 增加 `automation` 节点，记录 queued/running/waiting/succeeded/failed/cancelled、审批拒绝、origin 拦截、租约失效、急停和 p50/p95/p99；复用现有 trace/OTLP 配置，不添加第二套 telemetry。
- [ ] 在 Admin Ops 页面增加紧凑的 Automation panel；急停按钮要求范围和二次确认，成功后展示 generation 和事件 ID。
- [ ] Compose 增加独立 control、browser-worker、Redis 网络和 rootless worker 配置；Worker 不挂载宿主目录，限制资源和 egress；默认 `AUTOMATION_CONTROL_ENABLED=false`。
- [ ] CI 仅增加受影响包的 typecheck/test 路径和 Dockerfile 静态检查；不把 feature flag 打开到现有默认环境。
- [ ] 运行定向 API/前端测试和 `docker compose -f scripts/compose/docker-compose.yml config`，预期通过。
- [ ] 提交：`git add apps/api/src/ops apps/web/src/app/admin/ops apps/web/src/hooks/admin/use-ops-overview.ts scripts/compose .github/workflows docs/operations/automation-control.md docs/operations/automation-kill-switch.md && git commit -m "ops: add automation observability and deployment"`。

### 任务 13：执行定向黑盒验收与灰度清单

**依赖：** 任务 1 至任务 12

**文件：**

- 创建：`tests/automation/automation-contract-smoke.test.ts`
- 创建：`tests/automation/automation-security-smoke.test.ts`
- 创建：`tests/automation/automation-browser-smoke.test.ts`
- 创建：`tests/automation/automation-desktop-smoke.test.ts`
- 创建：`tests/automation/automation-failure-injection.test.ts`
- 创建：`docs/runbooks/2026-07-21-openopc-automation-release-checklist.md`

**步骤：**

- [ ] 先写黑盒断言：真实 API 创建浏览器任务、读取 SSE、等待审批、消费一次性确认、完成并读取证据引用；每个请求断言 HTTP 状态和关键字段。
- [ ] 写安全断言：跨租户、错误项目、错误 origin、私网/元数据地址、过期 lease、重放 approval、未经授权 full-access、CUA 未授权安装和急停后的输入全部失败。
- [ ] 写浏览器冒烟：临时上下文任务完成且上下文被销毁；持久 profile 只能在同一项目恢复；开放网络模式没有管理员临时授权时失败。
- [ ] 写桌面冒烟：在线 Edge Agent 可读取屏幕；输入动作在审批前暂停；断开或 kill switch 后停止续租和输入；CUA 缺失只显示安装授权状态。
- [ ] 写故障注入：Worker 崩溃、Edge 断线、控制服务重启、Redis 暂停；断言任务最终为 stopped/expired/retryable，且外部副作用不会重复。
- [ ] 运行以下定向命令，不跑全量套件：

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/automation.test.ts
pnpm.cmd --filter @kortix/db exec bun test src/automation-schema.test.ts
pnpm.cmd --filter @kortix/automation-control test
pnpm.cmd --filter @kortix/automation-browser-worker test
pnpm.cmd --filter kortix-api exec bun test src/automation/routes.test.ts src/ops/automation-metrics.test.ts
pnpm.cmd --filter @kortix/agent-tunnel exec bun test src/agent/security/permission-guard.test.ts src/agent/capabilities/desktop/cua-driver.test.ts
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/automation/automation-workbench.test.tsx src/features/automation/automation-approval-bar.test.tsx
pnpm.cmd --filter @kortix/desktop-electron exec node --test src/automation-edge.test.js
```

- [ ] 启动 Compose 后用真实 HTTP/SSE 输入运行五类 smoke；保存请求、响应、事件序号、审计 ID、急停 generation 和截图证据。
- [ ] 只在阶段 A/B/C 验收全部通过后，将浏览器白名单和桌面 Edge Agent 对内部管理员灰度开启；阶段 D 的持久 profile、开放网络和完全访问必须单独审批并设过期时间。
- [ ] 运行 `git diff --check` 和受影响包 typecheck；在交付记录中列出未执行的全量 suite、真实外部支付/发布场景和任何环境限制。
- [ ] 提交：`git add tests/automation docs/runbooks/2026-07-21-openopc-automation-release-checklist.md && git commit -m "test: verify controlled automation rollout"`。

## 依赖与提交顺序

```text
1 contracts
   -> 2 database
      -> 3 control skeleton -> 4 policy/approval -> 5 API adapter
         -> 6 desktop hardening
         -> 7 browser worker
            -> 8 dispatch
               -> 9 SDK -> 10 Web workbench -> 11 Electron bridge
                  -> 12 ops/deploy -> 13 black-box acceptance
```

每个任务只提交其列出的文件。若某任务发现不属于本任务的现有缺陷，记录到任务提交说明，不顺手重构。任何需要修改 Kortix 核心路由、IAM、WorkflowPort、Billing、Registry 或 Orchestration 的方案都必须暂停并回到设计评审，不得在实施中暗改边界。

## 规格覆盖自检

| 规格要求 | 计划任务 |
| --- | --- |
| 独立控制服务和双执行域 | 3、7、8 |
| 分级授权、完全访问仍确认不可逆动作 | 4、6、10、13 |
| 项目域名白名单、开放网络临时授权 | 4、7、10、13 |
| 临时/持久浏览器上下文 | 4、7、9、13 |
| CUA 显式安装和本地二次校验 | 6、11、13 |
| 签名租约、幂等、事件序列和故障恢复 | 2、3、8、13 |
| Credential Broker 和脱敏审计 | 4、5、8、12 |
| `@kortix/sdk` 单一入口与 AG-UI/SSE/trace 复用 | 5、9、10 |
| Google 风格 Web/桌面工作台 | 10、11 |
| Compose、Ops 指标、灰度和回滚 | 12、13 |
| Android/iOS 与已取消成品页面不回归 | 全局约束、任务 10 |

## 计划自检结果

- 没有未定义的任务依赖；每个后续公开接口在前置任务中有类型或路由定义。
- 每个代码任务都包含失败测试、最小实现、定向验证和独立提交步骤。
- 所有行为描述都已落实到明确文件、接口、测试和验证命令，没有未决占位项。
- SDK 全量套件按用户要求不在本阶段执行；该限制在任务 9 和任务 13 的验证记录中显式保留。
