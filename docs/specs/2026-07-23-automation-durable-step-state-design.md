# Automation Browser Worker 持久化步骤状态设计

**日期**：2026-07-23

**状态**：待书面规格确认

**范围**：Automation Control 接收 Browser Worker heartbeat 后的 PostgreSQL 原子落库

**兼容性**：默认关闭；不改 Kortix 核心入口、共享协议版本或数据库结构

## 1. 背景

Automation Control 已能认证 Browser Worker heartbeat，并在 PostgreSQL 事务中校验租户、项目、任务、租约、kill-switch generation、Worker 身份和 lease-scoped ordinal。当前 sink 可以持久化 `job_started`、`job_failed`、`kill_switch_activated` 和普通 `heartbeat`，但仍对以下事件失败关闭：

- `step_started`
- `step_completed`
- `job_succeeded`
- `approval_required`

共享契约已经为步骤事件提供 `step_id` 和 `evidence_reference`；`automation_job_steps` 也已经提供 `status`、`started_at`、`ended_at` 与 `result_ref`。缺口不是协议或表结构，而是 Worker 事件与步骤行、任务终态和审计事件之间缺少同一事务内的状态约束。

本设计只闭合前三类事件。`approval_required` 继续失败关闭，直到 durable pause、lease release、approval grant、redispatch 和 resume 协议单独完成。

## 2. 目标与非目标

### 2.1 目标

1. 让合法的 Worker `step_started`、`step_completed` 和 `job_succeeded` 事件进入现有持久化流水线。
2. 在一个 PostgreSQL 事务内完成租约校验、ordinal 校验、步骤状态校验、步骤更新、任务终态更新和事件写入。
3. 拒绝未知步骤、跨任务步骤、重复或逆序的步骤状态变化，以及仍有未完成步骤时的任务成功。
4. 任何拒绝或数据库失败都不留下部分步骤状态、任务状态、Worker ordinal 或审计事件。
5. 保持现有默认关闭开关、HTTP/heartbeat 契约、错误原因以及 Kortix 原功能不变。

### 2.2 非目标

- 不实现 `approval_required`、审批后恢复或 lease 重新派发。
- 不接线 Browser Worker 主运行时，也不宣称浏览器自动化端到端完成。
- 不修改 `automation.v1`、heartbeat schema 或 `automation_job_steps` 表。
- 不验证 `evidence_reference` 指向的对象是否已经上传；本阶段只保存已经通过共享 schema 校验的 `evidence:<uuid>` 引用。
- 不重构 Desktop coordinator 或通用 `appendPostgresAutomationEvent` 路径。
- 不加入步骤重试、步骤回退、跳过或失败状态处理。
- 不按 `sequence` 强制串行启动步骤。每个步骤只遵守自身状态机，为后续并行步骤或多 Agent 执行保留空间；任务成功仍要求所有步骤完成。

## 3. 方案比较与决策

### 方案 A：在 PostgreSQL heartbeat sink 内增加事务化步骤守卫（采用）

在 `createPostgresHeartbeatEventSink` 的现有任务行锁和事务中，根据 Worker 事件锁定并更新步骤；`job_succeeded` 在同一事务内锁定并检查全部步骤。

优点：不改协议、不迁移数据库、不影响 Desktop 路径；复用现有租约、ordinal、事件 sequence 和任务状态机；失败回滚边界清晰。缺点：步骤约束暂时只覆盖认证 Worker sink，未来若其他执行域也需要相同语义，应再提取共享事务应用器。

### 方案 B：重构为所有事件写入方共享的状态投影器（暂缓）

将步骤状态处理下沉到通用 event store，让 Browser Worker、Desktop coordinator 和内部路由共享同一投影逻辑。

优点：最终一致的全局语义更强。缺点：会改变已经工作的 Desktop 路径和 repository 契约，需要更大范围回归，与当前最小闭环不匹配。

### 方案 C：只写事件，再由异步 projector 更新步骤（拒绝）

优点：事件接收路径简单。缺点：步骤状态和任务终态会短暂或永久不一致；`job_succeeded` 无法在接收时证明所有步骤已经完成；projector 失败还会引入补偿与重放复杂度。

决策采用方案 A。它在不扩大升级冲突面的前提下闭合当前 Browser Worker 信任边界。

## 4. 状态语义

| Worker 事件 | 任务前置状态 | 步骤前置状态 | 持久化结果 | 审计事件状态 |
| --- | --- | --- | --- | --- |
| `step_started` | `running` | 目标步骤为 `pending` | 步骤变为 `running`，`started_at = observed_at` | `running` |
| `step_completed` | `running` | 目标步骤为 `running` | 步骤变为 `succeeded`，写入 `ended_at` 与原样 `evidence_reference` | `running` |
| `job_succeeded` | `running` | 任务至少有一个步骤，且全部为 `succeeded` | 任务变为 `succeeded`，清除租约，写入 `terminal_at` | `succeeded` |

每个步骤只允许：

```text
pending -> running -> succeeded
```

本阶段不接受幂等重复事件：重复 `step_started`、重复 `step_completed`、未开始即完成以及完成后再次开始都返回 `semantic_mismatch`。Worker ordinal 也必须严格连续；调用方不能通过换一个 ordinal 绕过步骤状态前置条件。

步骤事件不改变任务状态，使用 `transition: null`，但其事件状态固定为 `running`。现有 `resolveAutomationEventStatus` 因而同时验证任务仍处于 `running`。`job_succeeded` 使用现有 `{ type: 'succeeded' }` transition，将任务从 `running` 转为 `succeeded`。

## 5. 事务与锁顺序

所有数据库工作继续由 `createPostgresHeartbeatEventSink` 的单个事务承载。固定锁顺序如下：

1. 以 `account_id + project_id + job_id + lease_owner + kill_switch_generation` 锁定任务行，并再次以数据库时钟验证租约未过期。
2. 在任务锁保护下读取当前 lease-scoped Worker 最大 ordinal，要求新 ordinal 正好加一。
3. 通过现有状态机解析事件对应的任务状态。
4. 对步骤事件，以 `job_id + step_id` 锁定目标步骤并验证前置状态；对 `job_succeeded`，按任务读取并锁定全部步骤。
5. 完成步骤更新；若事件带任务 transition，则完成任务更新。
6. 分配下一个任务事件 sequence，并插入带 Worker identity、lease ID 和 ordinal 的审计事件。
7. 提交后才返回 accepted event。

同一任务的所有 Worker heartbeat 先竞争任务行锁，因此 sequence、ordinal、步骤变化和任务终态被串行化。步骤锁仍然保留，用于防止审批服务或未来其他写入方在不持有同一任务锁时并发修改目标步骤。所有路径都保持“先任务、后步骤”的锁顺序，避免新增反向锁顺序。

### 5.1 `step_started`

- 按 `job_id + step_id` 查询并 `FOR UPDATE`。
- 找不到步骤或步骤不属于当前任务时，返回 `semantic_mismatch`。
- 只有 `pending` 可进入 `running`。
- 写入 `status = running` 和 `started_at = observed_at`。
- 更新语句再次带 `job_id + step_id + status = pending` 条件；未返回行即失败关闭。

### 5.2 `step_completed`

- 按 `job_id + step_id` 查询并 `FOR UPDATE`。
- 只有 `running` 可进入 `succeeded`。
- 写入 `status = succeeded`、`ended_at = observed_at`、`result_ref = evidence_reference`。
- 更新语句再次带 `job_id + step_id + status = running` 条件；未返回行即失败关闭。

### 5.3 `job_succeeded`

- 锁定当前任务的全部步骤，读取 `step_id`、`sequence` 和 `status`。
- 零步骤或任一步骤不是 `succeeded` 时返回 `semantic_mismatch`。
- 通过现有任务状态机执行 `running -> succeeded`。
- 写入 `status = succeeded`、`updated_at = observed_at`、`terminal_at = observed_at`，并清空 `lease_owner` 与 `lease_expires_at`。
- 在同一事务中插入最终 `job_succeeded` 事件。

## 6. 错误与回滚

现有 sink 结果类型不扩展：

- 租约、owner 或 generation 不匹配：`stale_lease`
- ordinal 重放或跳号：`replayed_ordinal`
- 未知/跨任务步骤、错误步骤状态、错误任务状态、零步骤成功、存在未完成步骤：`semantic_mismatch`
- PostgreSQL 查询、更新或插入异常：异常向上抛出，由 heartbeat route 按依赖失败处理；不能转换成 accepted 或回退到内存状态。

语义拒绝发生在任何持久化更新之前。即使更新后发生 event insert 失败，PostgreSQL 事务也必须回滚步骤和任务更新。失败的事件不占用 ordinal：ordinal 的事实来源仍是已经提交的 `automation_job_events`。

## 7. 代码边界

预计只修改：

- `apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts`
- `apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts`

若测试夹具需要区分任务更新和步骤更新，只在同一测试文件内增强 fake transaction。此阶段不修改共享 contracts、数据库 schema、迁移、主运行时接线、配置开关或前端。

## 8. 测试设计

使用测试先行，先把当前“步骤事件统一失败关闭”测试拆成具体状态测试，再实现逻辑。

### 8.1 成功路径

1. `pending` 步骤接收 `step_started`，步骤与事件在同一事务写入。
2. `running` 步骤接收 `step_completed`，保存 `succeeded`、结束时间和 evidence reference。
3. 所有步骤为 `succeeded` 时接收 `job_succeeded`，任务终结、租约清除并写入最终事件。

### 8.2 失败路径

1. 未知 `step_id` 或属于其他任务的步骤被拒绝。
2. `step_started` 遇到非 `pending` 状态被拒绝，包括重复 started。
3. `step_completed` 遇到非 `running` 状态被拒绝，包括未开始和重复 completed。
4. 零步骤或仍有 `pending`/`running` 步骤时，`job_succeeded` 被拒绝。
5. 旧 lease、错误 owner/generation 和错误/跳号 ordinal 继续在步骤状态读取或更新前被拒绝。
6. 步骤更新或事件插入抛错时，事务不返回 accepted；使用能够表达 commit/rollback 的测试夹具证明无部分状态。
7. `approval_required` 继续在开启事务前失败关闭。

### 8.3 定向验证

不运行全仓测试。实现阶段只运行：

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/postgres-heartbeat-sink.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
pnpm.cmd exec biome check apps/automation-control/src/dispatch/postgres-heartbeat-sink.ts apps/automation-control/src/dispatch/postgres-heartbeat-sink.test.ts
```

如实现没有触及其他包，不把其他包或浏览器 E2E 的结果计入本阶段完成证据。

## 9. 兼容性与后续阶段

本设计不改变公共 wire schema、数据库 schema 或服务部署边界。功能仍受现有 Automation/Worker 默认关闭开关保护；关闭时不会进入新路径。变更集中在 OpenOPC 的独立 Automation Control 服务，避免改写 Kortix 的 IAM、Agent、Workflow、Billing、Registry 或 Orchestration 核心。

完成本阶段后，仍需按顺序推进：

1. durable `approval_required` pause/release/redispatch/resume；
2. dispatch attempt 幂等与 unknown-result 恢复；
3. Browser Worker 主运行时 heartbeat/dispatch 组合；
4. 真实 PostgreSQL 并发验证与部署 readiness 加固。

上述工作不属于本规格的完成条件。
