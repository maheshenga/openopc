# Automation Browser Worker Durable Approval Pause 设计

**日期**：2026-07-23

**状态**：待书面规格确认

**范围**：认证 Browser Worker 发出 `approval_required` 后的 Control 端持久化暂停

**兼容性**：内部默认关闭；不接线生产入口；不修改共享协议、数据库结构或 Kortix 核心

## 1. 背景

Automation Control 已能认证 Browser Worker heartbeat，并原子持久化 `step_started`、`step_completed` 和 `job_succeeded`。共享契约也已经允许 Worker 发出：

```ts
{
  type: 'approval_required',
  payload: { step_id, action_hash },
  trace_id,
}
```

当前 PostgreSQL heartbeat sink 对该事件失败关闭。现有数据库已经具备 `automation_approvals`、步骤 `awaiting_approval` 状态和 `approval_id` 外键；现有状态机则只支持任务创建阶段的 `queued -> awaiting_approval`，尚不支持执行中的持久化暂停。

完整恢复还缺少 Browser dispatch coordinator、审批凭据进入 dispatch envelope、一次性凭据消费以及 Worker 主运行时接线。因此本规格只实现安全的 durable pause intake，不把尚未闭合的恢复链路暴露到生产运行时。

## 2. 目标与非目标

### 2.1 目标

1. 认证 Worker 为当前高风险步骤请求审批时，在一个 PostgreSQL 事务内创建审批、暂停步骤、暂停任务、释放旧租约并写入审计事件。
2. 让旧 Worker 在审批事件提交后立即失去执行权；其后续 heartbeat 或动作事件必须被现有租约检查拒绝。
3. 区分“任务创建前审批”和“执行中审批”，避免放宽已有无租约事件路径。
4. 生成确定的审批过期时间与恢复游标，为后续 approve/reject 和 redispatch 规格提供持久化依据。
5. 通过 sink 内部默认关闭选项保持当前生产行为不变，直到完整恢复链路完成。

### 2.2 非目标

- 不实现审批通过、拒绝或过期后的任务状态变化。
- 不生成、传输或消费一次性审批令牌。
- 不修改 `AutomationBrowserDispatchEnvelope`，也不执行 redispatch。
- 不接线 Browser Worker `actionEventSink`、`consumeApproval` 或 `waitForApproval`。
- 不新增后台 expiry sweeper。
- 不修改数据库 schema、迁移、公共 `automation.v1` wire schema 或前端。
- 不在 `main.ts`、config 或 heartbeat runtime 中启用该能力。

## 3. 方案比较与决策

### 方案 A：Worker 保持租约并原地等待（拒绝）

该方案可以复用 Worker 当前的 `waitForApproval` 抽象，但会长期占用 Browser、连接和 Worker 槽位。Control 或 Worker 重启、网络断开、租约续期失败时，等待状态无法可靠恢复，也不符合“审批期间无执行权”的安全目标。

### 方案 B：默认关闭的 fenced durable pause（采用）

Control 接受审批事件后持久化暂停并清除租约；本阶段不恢复任务，也不在生产入口启用。它将审批请求与后续 redispatch 分成两个可独立审查的信任边界。

优点：事务和 fencing 语义完整；不改变共享协议；不会把半成品恢复链路暴露给运行时。缺点：在下一阶段完成前只能作为默认关闭的基础能力。

### 方案 C：一次实现暂停、审批、凭据、重新派发和 Worker 恢复（暂缓）

该方案需要同时修改 Control 状态机、approval service、HTTP routes、共享 dispatch contract、Browser dispatcher、Worker dispatch source、Worker runtime 和 unknown-result 恢复，无法形成一个小而可靠的实现计划。

决策采用方案 B。

## 4. 状态机设计

新增内部 transition：

```ts
{ type: 'execution_approval_required' }
```

状态变化为：

```text
running --execution_approval_required--> awaiting_approval
```

它仍映射到公共审计事件类型 `approval_required`，但与现有 `{ type: 'approval_required' }` 明确分离：

- `{ type: 'approval_required' }`：保留 `queued -> awaiting_approval`，用于任务派发前审批，不要求租约。
- `{ type: 'execution_approval_required' }`：只允许 `running -> awaiting_approval`，必须持有当前租约。

`TRANSITION_EVENT_TYPES` 同时允许这两个内部 transition 对应公共 `approval_required` 事件。`automationEventRequiresLease` 只把 `execution_approval_required` 标记为必须有租约，从而不改变任务创建前审批行为。

## 5. Sink 配置边界

`createPostgresHeartbeatEventSink` 增加可选参数：

```ts
type PostgresHeartbeatSinkOptions = Readonly<{
  durableApprovalPauseEnabled?: boolean;
  approvalTtlMs?: number;
  newApprovalId?: () => string;
}>;
```

规则：

- `durableApprovalPauseEnabled` 默认 `false`。
- 关闭时，`approval_required` 保持当前行为：在打开事务前返回 `semantic_mismatch`。
- 开启时，`approvalTtlMs` 默认 `600_000`（10 分钟），允许范围为 60 秒到 60 分钟。
- `newApprovalId` 默认使用 `randomUUID()`，仅作为确定性测试注入点。
- `main.ts` 本阶段继续调用无 options 的工厂，因此生产运行时仍失败关闭。

## 6. Worker 事件前置条件

进入事务前继续执行现有 wire schema、敏感字段、Worker proof、peer identity、observed-at 时间窗和 owner 格式校验。

事务内固定按以下顺序验证：

1. 锁定 account/project/job/lease owner/generation 完全匹配且未过期的任务行。
2. 要求任务状态为 `running`，任务 deadline 晚于数据库当前时间和 `observed_at`。
3. 验证 lease-scoped Worker ordinal 严格连续。
4. 锁定当前任务的全部步骤，并按 `sequence` 检查 Browser 串行执行快照。
5. 目标 `step_id` 必须存在于当前任务，且：
   - 状态为 `pending`；
   - `action_hash` 与 Worker payload 完全一致；
   - risk 为 `operate` 或 `external_effect`，不能为 `observe`；
   - 所有 sequence 更小的步骤均为 `succeeded`；
   - 所有 sequence 更大的步骤均为 `pending`。
6. 步骤不能已经绑定 `approval_id`。

任何条件不满足都返回 `semantic_mismatch`，且不创建审批、不改变步骤/任务、不插入事件，也不占用 ordinal。

Browser Worker 本身严格按 sequence 执行，因此这里的前后步骤约束只适用于 Browser approval pause，不改变通用 durable step sink 为未来并行 Agent 保留的局部步骤状态语义。

## 7. 审批有效期与恢复游标

候选过期时间为：

```text
observed_at + approvalTtlMs
```

最终 `expires_at` 取候选时间与任务 `deadline_at` 的较早值。若最终时间不晚于数据库当前时间或 `observed_at`，事件失败关闭。

`resume_after_sequence` 定义为目标步骤之前最后一个已成功步骤的真实 sequence；若目标步骤是第一个步骤，则为 `0`。它不是完成步骤数量，也不假设 sequence 连续。

恢复游标写入 `approval_required` 审计事件 payload，下一阶段 redispatch 必须重新从步骤表计算并与该值一致，不能只信任历史 payload。

## 8. 原子持久化流程

在现有任务行锁、Worker ordinal 和事件 sequence 事务中执行。所有语义校验必须在第一次 mutation 之前完成；第一次 mutation 之后的条件写入失配必须抛出事务内冲突错误，让 PostgreSQL 回滚，再由事务外层转换为 `semantic_mismatch`，不能在已修改状态后正常 return：

1. 生成 `approval_id`。
2. 条件更新目标步骤：
   - `status: pending -> awaiting_approval`；
   - `approval_id = approval_id`；
   - where 再次包含 `job_id + step_id + action_hash + status = pending + approval_id IS NULL`；
   - 未返回行时尚未产生 mutation，可直接返回 `semantic_mismatch`。
3. 插入 `automation_approvals`：
   - `job_id`、`step_id`、`action_hash` 来自已锁定的数据库状态；
   - `status = pending`；
   - `expires_at` 使用第 7 节规则；
   - `created_at = observed_at`。
4. 通过 `execution_approval_required` 将任务更新为 `awaiting_approval`：
   - `updated_at = observed_at`；
   - `lease_owner = null`；
   - `lease_expires_at = null`；
   - `terminal_at` 保持 `null`。
   - 条件更新未返回行时抛出事务内冲突错误，回滚步骤和审批写入。
5. 插入 Worker 审计事件：

```json
{
  "type": "approval_required",
  "status": "awaiting_approval",
  "payload": {
    "step_id": "<uuid>",
    "action_hash": "sha256:<64 hex>",
    "approval_id": "<uuid>",
    "expires_at": "<ISO timestamp>",
    "resume_after_sequence": 0
  }
}
```

事件继续保存 Worker ID、lease ID 和 ordinal。只有事务提交后才返回 accepted event。

所有路径保持“任务行 -> 该任务全部步骤”的锁顺序。任务行锁继续串行化同一任务的 Worker ordinal 和事件 sequence；步骤锁防止其他审批或状态写入方并发改变恢复快照。

## 9. Fencing 与失败语义

事务提交后任务不再有 lease owner，状态也不再是 `running`/`dispatched`。因此旧 Worker：

- 不能续租；
- 不能通过 `isCurrent`；
- 不能提交新的 heartbeat、step 或 terminal 事件；
- 不能由同一 lease 恢复执行。

现有 sink 结果类型保持不变：

- owner、generation 或租约过期：`stale_lease`；
- 任务 deadline 已到、任务状态不再是 running：`semantic_mismatch`；
- ordinal 重放或跳号：`replayed_ordinal`；
- 步骤、hash、risk、状态、顺序或 expiry 不匹配：`semantic_mismatch`；
- PostgreSQL 异常：向上抛出，不能回退到内存状态。

如果 approval insert、步骤更新、任务更新或事件 insert 任一步骤失败，整个事务回滚。失败审批事件不占用 Worker ordinal，因为 ordinal 的事实来源仍是已提交的 `automation_job_events`。

## 10. 代码范围

预计修改：

- `apps/automation-control/src/state-machine.ts`
- `apps/automation-control/src/state-machine.test.ts`
- `apps/automation-control/src/event-store.ts`
- `apps/automation-control/src/event-store.test.ts`
- `apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts`
- `apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts`

不修改 `main.ts`、config、approval service、routes、共享 contracts、数据库 schema、迁移、Browser dispatcher 或 Browser Worker。

## 11. 测试设计

### 11.1 状态机与事件存储

1. 保留 `queued -> awaiting_approval` 的原有测试。
2. 新增 `running -> awaiting_approval` 的 `execution_approval_required` 测试。
3. 拒绝从 queued、dispatched、awaiting 或 terminal 状态应用执行中审批 transition。
4. 证明执行中审批 transition 只能映射 `approval_required` 事件。
5. 证明执行中审批必须提供租约，而创建前审批仍不需要租约。

### 11.2 Sink 成功路径

1. 开关开启、租约有效、ordinal 连续、步骤快照有效时，审批、步骤、任务和事件在同一事务提交。
2. 目标步骤正确进入 `awaiting_approval` 并绑定审批 ID。
3. 任务进入 `awaiting_approval` 并清除租约。
4. event payload 包含数据库绑定的 hash、审批 ID、过期时间和真实恢复游标。
5. 第一个步骤的恢复游标为 0；非连续 sequence 使用真实前一步 sequence。

### 11.3 Sink 失败路径

1. 默认关闭时在事务前失败关闭。
2. 未知/跨任务步骤、hash 不一致、observe risk、非 pending 状态或已有 approval ID 被拒绝。
3. 前序步骤未完成或后续步骤已经开始时被拒绝。
4. 任务不是 running、deadline 已过、租约失效或 ordinal 不连续时被拒绝。
5. 条件步骤更新未返回行时不创建部分状态。
6. approval、job 或 event insert/update 抛错时事务回滚全部变更。

### 11.4 定向验证

不运行全仓测试。实现阶段只运行相关 Automation Control 测试、该包 typecheck 和触及文件的 scoped Biome。测试输出必须单独报告，不能表述为 Browser E2E、部署或生产验证。

## 12. 后续阶段

本规格完成后仍保持生产失败关闭。下一份规格必须闭合：

1. approval approve/reject/expiry 与任务/步骤的原子状态变化；
2. 一次性凭据如何安全进入 redispatch，而数据库只保存 hash；
3. 新 lease、恢复游标重算和 dispatch attempt 幂等；
4. Worker 对绑定审批的消费、旧 lease 拒绝和执行前二次校验；
5. unknown-result 恢复与真实 PostgreSQL 并发验证。

只有这些完成并通过独立审查后，才能在 `main.ts` 接线 durable approval。
