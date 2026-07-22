# Automation Browser 审批恢复闭环设计

**日期**：2026-07-23  
**状态**：待用户审阅  
**范围**：Automation Control 与 Browser Worker 之间的 durable approval resume 闭环  
**默认行为**：关闭  
**兼容性目标**：不改变 Kortix 既有桌面执行、公共 API、`automation.v1` 非审批任务和核心入口语义

## 1. 背景与当前状态

当前审批结算已经能够在数据库中原子地完成批准、拒绝和过期转换。批准之后，典型状态是：

- Approval 为 `approved`；
- 目标 Step 为 `pending`；
- Job 为 `dispatched`；
- 原始审批凭证只在生成响应时短暂可见，数据库只保存哈希；
- Browser Dispatcher 已经支持新签名租约、`resumeAfterSequence`、签名 dispatch envelope，以及派发前后的租约当前性检查；
- Worker 运行时已有租约、generation、action hash、cursor 校验，以及 `consumeApproval` / `waitForApproval` 钩子；
- Browser Worker 的认证来源和执行运行时尚未在生产入口组合，现有桌面 coordinator/poller 也尚未负责 Browser 恢复。

因此存在一个明确的崩溃窗口：用户已经批准，但原始凭证不再能安全地重新交给稍后上线的 Browser Worker。

## 2. 目标与非目标

### 2.1 目标

1. Worker 离线或 dispatch 响应丢失时，审批后的 Browser Step 能在租约过期后安全恢复。
2. 每个恢复 Attempt 只允许一次有效的审批消费和一次 Step 启动。
3. 凭证绑定到具体租户、项目、Job、Step、Action Hash、Lease、Generation、Attempt 和 Resume Cursor。
4. 凭证、Step 启动和审批消费在可验证的事务边界内完成，避免重复外部副作用。
5. 保持公共审批 API 的 Token 脱敏，并让现有桌面流程继续工作。
6. 通过现有 coordinator/poller 和签名 dispatch 能力实现，不另建第二套调度器。

### 2.2 非目标

- 本阶段不修改生产 `main.ts` 的运行时组合；
- 本阶段不默认启用 Browser Worker 生产闭环；
- 不改变 Kortix 的 IAM、Agent、Workflow、Billing、Registry 或 Orchestration 核心；
- 不修改既有 `automation.v1` 非审批 Browser 任务的语义；
- 不把原始 Token 放入公共 API、浏览器页面、URL、普通日志或审计事件；
- 不自动重放已经进入 `running` 的 Step；外部副作用后的恢复需要后续 reconciliation/人工处理设计；
- 不执行全仓库测试或宣称完成 Browser E2E/生产部署验证。

## 3. 方案比较与决策

### 方案 A：复用现有 Poller 自动恢复（采用）

扩展现有 coordinator/poller，使其筛选 `approved + pending` 的 Browser Job，在每次取得新鲜租约时创建短期 Resume Attempt，并通过现有 Browser Dispatcher 发送签名 envelope。Worker 在外部副作用前调用内部认证消费接口。

优点：没有第二套 scheduler；能利用现有租约、generation、cursor 和重试边界；公共 API 不需要携带新凭证；恢复与桌面路径保持分离。缺点是需要增加 Attempt 持久化和 Worker 能力声明。

### 方案 B：审批 resolve 请求内同步派发

在审批请求提交事务后立即调用 Worker。实现较小，但审批提交与 Worker 可用性耦合，并且提交成功后进程崩溃会产生永久丢失窗口。

### 方案 C：增加携带原始 Token 的独立 resume API

提供显式重试接口，但会扩大凭证暴露面，违背当前公共 API 脱敏边界；如果不额外持久化/重新签发，仍然存在响应丢失问题。

方案 A 是本设计的唯一实现方向。

## 4. 总体架构

### 4.1 Coordinator/Poller

继续使用现有调度循环，不引入第二个 scheduler。每次 fresh lease claim 后，仅处理满足以下条件的 Browser Job：

- Job 未取消、未过期，且 kill-switch generation 仍然有效；
- 关联 Approval 为 `approved`；
- 关联目标 Step 为 `pending`；
- Worker/部署具备 `browser.approval-resume` 能力；
- 功能开关允许该环境进入恢复路径。

没有能力匹配的 Worker 时保持当前状态并等待租约自然过期，不降级到无审批派发。

### 4.2 Resume Issuer

新增窄接口服务，负责在事务内创建 Resume Attempt。它生成高熵短期 Token，持久化 Token 哈希和完整绑定，返回的原始 Token 只交给当前 Control 进程用于构造签名 envelope。

为了支持多个租约尝试而不覆盖原始用户审批凭证，Attempt 使用独立的内部持久化记录；Approval 表现有 `tokenHash` 仍用于兼容既有审批消费路径。Attempt 成功消费后，Approval 统一转为 `consumed`。

逻辑记录至少包含：

```text
attempt_id, approval_id, job_id, step_id, project_id
lease_id, lease_owner, generation, resume_after_sequence
action_hash, token_hash, status
issued_at, expires_at, consumed_at
```

Attempt 状态为 `issued -> consumed` 或 `issued -> expired/rejected`。对同一 Attempt 的重复消费必须幂等；不同 Attempt 不能绕过 Step 前置状态。

### 4.3 Versioned Browser Resume Envelope

既有 `automation.v1` 非审批任务保持原样。审批恢复使用可区分的版本化变体（例如 `automation.browser-resume.v1`），其中包含：

- 现有 Job Request、签名 Lease、Policy Version 和 Resume Cursor；
- Approval ID、Attempt ID、Action Hash；
- 短期审批 Token（仅在 Control 内存和签名传输中存在）；
- 能力/协议标识，防止旧 Worker 把未消费审批的 Step 当作普通任务执行。

新 Worker 必须显式声明该能力；旧 Worker 只能继续接收非审批 `automation.v1` 任务。

### 4.4 Browser Worker

Worker 按以下顺序处理：

1. 验证 envelope 签名、协议版本和租约窗口；
2. 验证 project、Job、generation、action hash 和 cursor；
3. 在产生外部副作用前调用认证的 `consume-and-start`；
4. 只有消费成功后才执行 Browser Action；
5. 通过既有事件/heartbeat 路径报告 Step 和 Job 结果。

生产入口的组合仍由后续激活阶段完成，本阶段提供可独立测试的 factory、契约和测试 harness。

## 5. 数据流与状态转换

### 5.1 正常路径

```text
approved / pending / dispatched
        |
        v
Poller 取得 fresh lease
        |
        v
事务创建 Attempt + 绑定 token hash
        |
        v
签名 browser-resume envelope
        |
        v
Worker 校验 envelope
        |
        v
consume-and-start 事务
  Approval: approved -> consumed
  Step:     pending  -> running
  Event:    job_started
        |
        v
Browser 外部副作用
        |
        v
Step completed / Job terminal
```

`consume-and-start` 必须锁定 Attempt、Approval、Job 和目标 Step，并在一次数据库事务中完成凭证校验、Approval 消费、Step 启动和 `job_started` 事件写入。任何一项失败都回滚全部状态。

### 5.2 崩溃路径

- Dispatch 丢失、Worker 未消费：Attempt 保持 `issued`；租约过期后，Poller 只要 Step 仍为 `pending` 就创建新 Attempt。
- Token 过期、签名错误、Lease/Generation/Cursor 不匹配：当前 Attempt fail-closed，不执行外部操作。
- 已消费且 Step 为 `running` 后 Worker 崩溃：禁止自动重放，保留 `running` 并交给后续恢复/人工处理。
- Approval 被拒绝、过期、取消或 Job 触发 kill switch：所有未消费 Attempt 失效。

## 6. 错误处理与安全边界

### 6.1 稳定错误分类

| 条件 | 结果 |
| --- | --- |
| Envelope 签名或协议错误 | `DISPATCH_INVALID`，永久拒绝当前 Attempt |
| Token 不匹配/已失效 | `APPROVAL_CREDENTIAL_INVALID`，不暴露具体原因 |
| Lease/Owner/Generation 过期或不一致 | `LEASE_STALE`，等待新的 Attempt |
| Action Hash/Cursor 不匹配 | `DISPATCH_MISMATCH`，永久拒绝当前 Attempt |
| Approval 已是终态 | `APPROVAL_TERMINAL`，不重试 |
| 同一 Attempt 重复消费 | 幂等成功，不重复启动 Step |
| 不同 Attempt 竞争已启动 Step | 拒绝，不重放 |
| PostgreSQL/认证依赖瞬时失败 | 不返回 accepted，由 Poller 退避重试 |

错误响应不能通过消息文本泄露 Token 是否存在、哈希值或其他租户信息。

### 6.2 凭证和租户隔离

- 原始 Token 不进入公共 API、URL、浏览器端、普通日志、指标标签或事件载荷；
- Token 哈希必须绑定 Approval、Project、Job、Step、Action Hash、Lease、Generation、Attempt 和有效期；
- Control 内部消费接口只接受现有认证的 Control↔Worker 通道；
- 每次消费重新验证账户/项目/Job 归属；
- kill-switch generation 变化立即废止旧 envelope 和 Attempt；
- 旧协议 Worker 不得接收审批恢复变体；
- 功能开关默认关闭，关闭时不创建 Attempt、不改变现有桌面流程。

## 7. 可观测性

写入以下结构化事件，事件只携带 ID、状态、错误码和时间，不携带 Token：

- `browser_resume_attempt_issued`
- `browser_resume_dispatched`
- `browser_resume_consumed`
- `browser_resume_rejected`
- `browser_resume_expired`
- `browser_resume_duplicate`

指标至少包括恢复成功率、审批消费延迟、Attempt 过期次数、凭证拒绝次数、重复消费次数和 Worker 不可用时长。日志统一携带 `traceId`、`jobId`、`stepId`、`approvalId`、`attemptId`，并实行敏感字段过滤。

## 8. 测试策略与验收标准

### 8.1 契约与纯函数测试

- Resume Envelope 签名、版本和解析；
- 绑定字段缺失或不一致时拒绝；
- 旧 `automation.v1` 非审批 envelope 行为不变；
- 公共 API 和错误响应不包含原始 Token。

### 8.2 事务与并发测试

- 只有 `approved + pending` 才能创建 Attempt；
- 并发 `consume-and-start` 只有一个事务成功；
- 同一 Attempt 重复消费幂等；
- 不同租约/项目/Action Hash/Generation/Cursor 必须失败；
- 任意数据库错误都不留下部分 Step、Approval 或事件状态。

### 8.3 Poller 与 Worker 测试

- Worker 离线后重新上线可恢复一次；
- Dispatch 丢失后租约过期能生成新 Attempt；
- Step 进入 `running` 后不会自动重放；
- kill switch、取消和终态 Approval 会阻止派发；
- 日志和事件不出现 Token 原文。

### 8.4 聚焦验收命令

不执行全仓库测试。实施阶段至少运行：

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-approval-resume.test.ts src/dispatch/browser-approval-resume.postgres.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
pnpm.cmd exec biome check apps/automation-control/src/dispatch/browser-approval-resume.ts apps/automation-control/src/dispatch/browser-approval-resume.test.ts apps/automation-browser-worker/src/approval-resume.ts apps/automation-browser-worker/src/approval-resume.test.ts
```

完成标准是：上述聚焦测试、类型检查和格式检查通过；默认关闭行为通过；并覆盖“Worker 离线后恢复一次、旧 Attempt 失效、重复消费不重复执行、公共 API 不泄露 Token”四个验收场景。不得将未运行的 Browser E2E、全仓库测试或生产部署验证描述为已完成证据。

## 9. 代码边界、迁移与上游兼容

预期改动集中在 Automation 扩展边界：

- Resume Attempt 的契约、持久化和事务服务；
- Browser resume envelope 的版本化 schema/dispatcher 适配；
- Worker 的消费门和测试 harness；
- coordinator/poller 的 Browser 恢复筛选；
- 定向测试与必要数据库迁移。

不修改 Kortix IAM、Agent、Workflow、Billing、Registry、Orchestration 和既有桌面 coordinator 的公共契约。新增字段和协议采用显式版本化/能力协商；旧 Worker 继续按原协议工作。生产 `main.ts` 的组合、部署 readiness、真实 PostgreSQL 并发和 Browser Worker 端到端接线属于后续激活阶段，不纳入本设计的默认开启范围。

## 10. 后续阶段顺序

1. 用户审阅并批准本规格；
2. 编写实施计划，拆分契约、Attempt 持久化、Control 事务、Dispatcher、Worker 消费门和聚焦测试；
3. 在默认关闭条件下实现并验证闭环；
4. 单独设计生产入口组合、认证 heartbeat/dispatch 传输、readiness 和真实 Browser E2E；
5. 通过部署前审查后再启用环境级开关。
