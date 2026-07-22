# Automation 执行期审批原子决策设计

**日期**：2026-07-23  
**状态**：已确认，待实施计划  
**范围**：Control 端对 Browser Worker 持久审批暂停执行 approve、reject 和同步过期收敛  
**默认行为**：关闭，不接入生产运行时

## 1. 背景

Control 端已经能够在显式启用测试选项时，把 Browser Worker 的
`approval_required` 事件持久化为一个 fenced pause：目标步骤进入
`awaiting_approval`，任务进入 `awaiting_approval`，当前租约被清除，审批记录、恢复游标和审计事件在同一事务提交。

现有 PostgreSQL Approval Service 的 `resolve()` 只更新
`automation_approvals`。它不会同步目标步骤和任务，也不会追加任务审计事件。因此执行期审批被批准、拒绝或在用户尝试处理时发现已经过期后，任务快照仍可能停留在 `awaiting_approval`。

本阶段只闭合 Control 端的审批决策事务。它不实现 Browser redispatch、审批凭据进入 dispatch envelope、Worker 重启恢复或生产配置接线。

## 2. 目标与非目标

### 2.1 目标

1. 识别由 durable execution pause 创建的审批，而不改变普通审批行为。
2. 在一个 PostgreSQL 事务内锁定并验证 Approval、Job、完整 Step 快照和事件序号。
3. 原子提交 approve、reject 或同步 expiry 对 Approval、Step、Job 和审计事件的全部变化。
4. approve 时继续使用现有一次性凭据格式；数据库只保存绑定后的哈希，原始令牌只返回一次。
5. 根据真实 step sequence 重新计算恢复游标，支持首步和稀疏序列。
6. 任一条件更新冲突或事件写入失败时回滚全部变化。
7. 通过默认关闭的构造选项隔离新行为，不修改 `main.ts` 或配置。

### 2.2 非目标

- 不修改 HTTP、SDK 或共享 Browser dispatch envelope 合约。
- 不把一次性凭据发送给 Browser Worker。
- 不实现 Browser dispatch coordinator、redispatch、Worker resume 或 unknown-result 恢复。
- 不改变 Browser Worker 当前运行时行为。
- 不新增数据库表、字段、枚举或迁移。
- 不在 `main.ts`、Compose 或环境配置中启用新行为。
- 不实现定时 expiry sweeper；本阶段只在 `resolve()` 观察到过期时同步收敛状态。
- 不运行全仓测试。

## 3. 方案比较与决策

### 方案 A：扩展现有 PostgreSQL Approval Service（采用）

在 `createPostgresApprovalService()` 增加默认关闭选项，并只对满足 execution pause 签名的审批进入新事务路径。该方案复用现有租户、用户、action hash、kill-switch generation 和令牌哈希逻辑，保持路由与返回格式不变。

### 方案 B：在 HTTP Route 编排多个服务（拒绝）

Route 先调用 Approval Service，再调用 Repository 修改 Job、Step 和事件。多个数据库事务之间可能产生“审批已批准但任务仍暂停”或“任务已派发但凭据未持久化”的半提交状态，不能满足原子性。

### 方案 C：新建独立审批编排服务（暂缓）

独立服务边界更纯，但当前需要复制或拆分令牌生成、哈希绑定、授权校验和错误映射。对本阶段而言改动面更大，也增加后续吸收上游变更的成本。

## 4. 启用边界

扩展 PostgreSQL 工厂选项：

```ts
type PostgresApprovalServiceOptions = {
  now?: () => Date;
  currentGeneration?: ApprovalGenerationReader;
  durableExecutionResolutionEnabled?: boolean;
  newEventId?: () => string;
};
```

- `durableExecutionResolutionEnabled` 默认 `false`。
- 关闭时，现有 `request()`、`resolve()` 和 `consume()` 行为保持不变。
- 开启时，`resolve()` 在锁定审批、任务和步骤后识别 execution pause；普通审批继续走现有逻辑。
- `newEventId` 只用于确定性测试，默认使用 `randomUUID`。
- 本阶段不从 `main.ts` 传入该选项，因此生产入口仍关闭。

## 5. Durable execution pause 签名

一个待处理审批只有同时满足以下条件，才允许进入原子决策路径：

1. Approval 属于请求中的 account 和 project，状态为 `pending`。
2. Approval 的 `job_id`、`step_id` 和 `action_hash` 与请求及数据库步骤一致。
3. Job 状态为 `awaiting_approval`，租约 owner 和 expiry 均为空。
4. 目标 Step 状态为 `awaiting_approval`，且 `approval_id` 等于当前 Approval ID。
5. 目标步骤之前的所有步骤均为 `succeeded`。
6. 目标步骤之后的所有步骤均为 `pending`。
7. Job、Approval 和调用方提供的 action hash 完全一致。
8. 请求用户是任务 actor；account 和 project 均匹配。

如果 Approval ID 已经绑定到目标步骤，但 Job、Step 或序列快照不满足上述条件，返回 `AUTOMATION_CONFLICT`，不得回退到普通审批逻辑。

如果 Approval 没有绑定到 `awaiting_approval` Step，视为普通审批，保留现有行为。

## 6. 状态转换

| 决策 | Approval | Step | Job | 公共审计事件 |
|---|---|---|---|---|
| approve | `approved` | 目标步骤 `awaiting_approval -> pending`，保留 `approval_id` | `awaiting_approval -> dispatched` | `job_dispatched` |
| reject | `rejected` | 目标及后续未完成步骤进入 `cancelled` | `awaiting_approval -> cancelled` | `job_cancelled` |
| expiry | `expired` | 目标及后续未完成步骤进入 `cancelled` | `awaiting_approval -> expired` | `job_expired` |

### 6.1 状态机补充

approve 复用现有内部 transition：

```ts
{ type: 'approval_granted' }
```

reject 复用：

```ts
{ type: 'cancelled' }
```

expiry 新增不要求租约的内部 transition：

```ts
{ type: 'approval_expired' }
```

它只允许：

```text
awaiting_approval --approval_expired--> expired
```

`approval_expired` 只能映射公共 `job_expired` 事件。现有
`lease_expired` 仍只表示 `running -> expired`，并继续要求当前租约；两者不能混用。

### 6.2 未完成步骤

approve 只把目标步骤恢复为 `pending`，后续步骤保持 `pending`。目标步骤保留
`approval_id`，供下一阶段把批准凭据绑定到恢复派发。

reject 和 expiry 把目标步骤以及后续仍为 `pending` 或
`awaiting_approval` 的步骤设为 `cancelled`。之前已成功的步骤不改变，确保终态任务没有看似仍可执行的剩余步骤。

## 7. 事务流程

`resolve()` 在 durable execution resolution 开启时执行以下事务：

1. `FOR UPDATE` 锁定 Approval。
2. 按 account、project 和 job ID `FOR UPDATE` 锁定 Job。
3. `FOR UPDATE` 锁定该 Job 的全部 Steps，并按真实 sequence 排序。
4. 在 Job 行锁保护下读取当前最大事件 sequence；所有写入同一 Job 的事件路径都必须先取得该 Job 行锁。
5. 验证 durable execution pause 签名、用户、action hash、步骤顺序、空租约和 deadline。
6. 计算 `resume_after_sequence`：目标前一个真实 sequence；目标为首步时使用 `0`。
7. 在任何写入前生成并校验最终审计事件。
8. 条件更新 Step、Approval 和 Job。
9. 插入审计事件。
10. 提交事务并返回现有 route 所需结果。

所有写入均带旧状态、Approval ID、action hash、租户范围和 Job 状态条件。第一次成功写入之后，如果任何条件更新未返回行，抛出内部冲突以强制 PostgreSQL 回滚；事务外再映射为 `AUTOMATION_CONFLICT`。

## 8. approve 处理

approve 额外执行：

1. Approval 和 Job deadline 都必须晚于
   `GREATEST(clock_timestamp(), now())`。
2. 读取当前 project kill-switch generation，并要求它等于 Job 的
   `kill_switch_generation`。
3. 生成现有 `approval.v1.*` 一次性令牌。
4. 将令牌与 Approval ID、project、action hash、Approval expiry 和 generation 绑定后保存 SHA-256 哈希。
5. 原始令牌只通过现有 resolve 返回值返回一次，不写入 Job、Step、Approval、事件或日志。
6. Step 恢复为 `pending`，Job 进入 `dispatched`，但本阶段没有 Browser coordinator 会消费该状态。

审计事件 payload：

```json
{
  "approval_id": "uuid",
  "step_id": "uuid",
  "action_hash": "sha256:...",
  "decision": "approved",
  "resume_after_sequence": 10,
  "expires_at": "2026-07-23T10:10:00.000Z"
}
```

## 9. reject 与 expiry 处理

### 9.1 reject

在 Approval 和 Job deadline 仍有效时，合法用户可以拒绝审批。事务把 Approval 设为 `rejected`，取消目标及后续未完成步骤，把 Job 设为 `cancelled` 并写入 `terminal_at`，最后追加 `job_cancelled`。

reject 不生成令牌，也不要求 kill-switch generation 仍与暂停时相同；拒绝永远不能扩大执行权限。

### 9.2 同步 expiry

如果 `resolve()` 发现 Approval deadline 或 Job deadline 已到期，expiry 优先于调用方提交的 approve/reject 决策。事务把 Approval 设为 `expired`，取消目标及后续未完成步骤，把 Job 设为 `expired` 并追加 `job_expired`。

事务提交后，服务向调用方返回现有
`AUTOMATION_APPROVAL_EXPIRED` 错误。实现必须让事务先返回内部 expired 结果，再在事务外抛出业务错误，避免抛错导致过期状态被回滚。

本阶段不主动扫描无人处理的过期审批；定时收敛属于后续生产接线。

## 10. 审计事件与序号

事件使用现有 `AutomationEventSchema`，字段包括：

- 新 UUID `event_id`；
- Job 内严格递增的 `sequence`；
- 与决策对应的 type 和 status；
- Approval、Step、action hash、decision、expiry 和恢复游标；
- `trace_id: null`；
- Worker identity、lease ID 和 ordinal 均为空，因为事件来源是 Control 用户决策，而不是 Worker。

事件、Approval、Step 和 Job 必须在同一事务提交，不能通过事务后异步补写。

## 11. 错误处理

- account/project/actor 不匹配：沿用 `AUTOMATION_NOT_FOUND` 或 `AUTOMATION_FORBIDDEN`，避免泄漏跨租户存在性。
- action hash 不匹配：`AUTOMATION_CONFLICT`。
- Approval 已解决、Step/Job 状态不匹配、存在租约或步骤快照不连续：`AUTOMATION_CONFLICT`。
- Approval 或 Job 到期：先原子收敛，再返回 `AUTOMATION_APPROVAL_EXPIRED`。
- kill-switch generation 改变：approve 返回 `AUTOMATION_CONFLICT`，不生成令牌、不修改状态。
- 条件更新冲突：事务回滚后返回 `AUTOMATION_CONFLICT`。
- 数据库写入失败：保留原始错误并回滚，不伪装为业务冲突。

## 12. 文件边界

预计修改：

- `apps/automation-control/src/state-machine.ts`
- `apps/automation-control/src/state-machine.test.ts`
- `apps/automation-control/src/event-store.ts`
- `apps/automation-control/src/event-store.test.ts`
- `apps/automation-control/src/approval-service.ts`
- `apps/automation-control/src/approval-service.postgres.test.ts`（新建）

不修改：

- `apps/automation-control/src/main.ts`
- `apps/automation-control/src/config.ts`
- `apps/automation-control/src/routes/approvals.ts`
- Browser dispatcher、dispatch coordinator、Browser Worker
- 共享 contracts、数据库 schema 和 migrations
- Web、桌面和移动端

## 13. 测试设计

### 13.1 状态机与事件边界

1. `approval_expired` 只允许 `awaiting_approval -> expired`。
2. 它只映射 `job_expired`，且不要求租约。
3. 现有 `lease_expired` 和 `approval_granted` 行为保持不变。

### 13.2 默认关闭与兼容性

1. 默认构造不进入 durable resolution 查询或写入。
2. 普通审批在选项开启时仍走原有逻辑。
3. `main.ts` 不传入新选项。

### 13.3 成功路径

1. approve 原子更新 Approval、目标 Step、Job 和事件，返回一次性令牌。
2. reject 原子拒绝 Approval、取消未完成步骤、终止 Job 并写事件。
3. Approval 或 Job deadline 到期时原子执行 expiry，再返回过期错误。
4. 首步恢复游标为 `0`；稀疏 sequence 使用真实前序值。
5. 数据库和事件序列化内容不包含原始令牌。

### 13.4 拒绝矩阵

覆盖跨租户、错误 actor、错误 hash、非 pending Approval、非 awaiting Job、非 awaiting Step、Approval ID 不匹配、残留租约、前序未成功、后序已开始和 generation 改变。

### 13.5 回滚矩阵

覆盖 Step update 无返回行、Approval update 无返回行、Job update 无返回行和 event insert 失败。第一次写入后的内部冲突映射为 `AUTOMATION_CONFLICT`；数据库异常原样抛出；所有场景均不得留下部分提交。

### 13.6 定向验证

只运行：

- 状态机测试；
- event-store 测试；
- PostgreSQL approval service 新增测试；
- Automation Control typecheck；
- 触及文件的 scoped Biome。

不把定向验证表述为 Browser E2E、生产部署或完整恢复闭环。

## 14. 后续阶段

本阶段完成后，生产仍保持关闭。下一阶段需要设计并实现：

1. 一次性凭据如何通过受控 resume API 进入 Browser redispatch；
2. 新 lease、dispatch attempt 幂等和恢复游标绑定；
3. Browser envelope 的审批凭据字段与签名；
4. Worker 启动恢复、一次性消费、旧 lease 拒绝和执行前二次校验；
5. unknown-result、真实 PostgreSQL 并发和 Browser E2E；
6. 所有边界通过后再修改 `main.ts` 和配置。
