# OpenOPC 浏览器与桌面自动化设计

**日期**：2026-07-21
**状态**：已获批准，待实施计划
**范围**：Milestone B，受控浏览器自动化与桌面自动化
**品牌**：OpenOPC；Kortix 仍作为底座内部标识

## 1. 背景与目标

OpenOPC 需要同时提供两类自动化能力：

- Web 端可独立运行的浏览器任务；
- 桌面端依赖本地设备的完整桌面控制。

两类能力必须同时建设，但保持独立执行域。它们共享权限、审批、凭据、审计和紧急停止基础设施，任何执行域都不能绕过另一个执行域的策略边界。

本设计的目标是：

1. 在不改写 Kortix 核心 IAM、WorkflowPort、Tunnel、Billing、Registry 和 Orchestration 的前提下增加自动化能力。
2. 让 Web 在不启动桌面应用时仍可独立使用；桌面应用只增加本地设备专属能力。
3. 默认采用最小权限、项目隔离、可审计和可急停的执行模型。
4. 允许设备所有者或管理员开启受限的完全访问模式，同时保留不可逆动作的逐次确认。
5. 通过独立服务和版本化协议降低 Kortix 后续升级的冲突面。

### 非目标

- Android/iOS 客户端本阶段不实现。
- 已取消的生图、生视频、语音、3D、数字人和批量混剪成品页面不在本设计范围内。
- 不把任意 shell 命令、任意 JavaScript 注入或未经策略批准的文件执行暴露为自动化动作。
- 不替换 Kortix 已有的用户、团队、Agent、会话、工作流和计费实现。

## 2. 已确认的安全决策

### 2.1 授权级别

默认授权采用三层模型：

| 级别 | 典型动作 | 授权方式 |
| --- | --- | --- |
| `Observe` | 截图、读取页面、读取辅助信息 | 设备级持久授权 |
| `Operate` | 点击、输入、启动应用、浏览器写入 | 会话级授权 |
| `ExternalEffect` | 删除、支付、发布、发送、提交、下载并执行 | 每次动作确认 |

完全访问模式是一个受限高权限配置，而不是绕过安全策略的开关：

- 仅设备所有者或管理员可以开启；
- 必须绑定租户、项目、设备、操作者和过期时间；
- 可以减少普通 `Operate` 动作的重复审批；
- 永远不能绕过 `ExternalEffect` 的逐次确认；
- 开启、使用、关闭和过期都写入高优先级审计事件。

### 2.2 浏览器来源与隔离

- 默认使用项目级域名白名单。
- 管理员可以按任务临时开启开放网络模式，并自动过期。
- 开放网络模式仍受 SSRF 防护、租户隔离、数据外传策略和高风险动作确认约束。
- 默认每个任务创建临时浏览器上下文，任务结束后清理 Cookie、缓存和站点数据。
- 受信任项目可以由管理员启用独立的持久浏览器配置，配置不能跨项目或跨租户共享。

### 2.3 桌面组件与急停

- CUA 缺失时只能在明确授权后安装；安装前展示来源、版本、权限和校验结果。
- Desktop Edge Agent 失联时立即停止输入，不能离线继续执行。
- 全局急停立即撤销活动租约、终止浏览器上下文、停止桌面输入，并保留任务现场和审计记录。

## 3. 总体架构

采用“独立自动化服务”方案。Kortix 继续负责产品身份和任务编排，自动化能力通过薄适配器进入独立服务。

```mermaid
flowchart LR
    UI["OpenOPC Web / Desktop"] --> SDK["@kortix/sdk"]
    SDK --> API["Kortix API 与任务编排"]
    API --> Adapter["OpenOPC Automation Adapter"]
    Adapter --> Control["Automation Control Service"]
    Control --> Browser["Browser Worker Pool\nPlaywright 隔离容器"]
    Control --> Edge["Desktop Edge Agent\n本地 CUA"]
    Control --> Policy["Permission / Approval Policy"]
    Control --> Audit["Audit & Evidence Store"]
    Control --> Vault["Credential Broker"]
    Stop["全局紧急停止"] --> Control
    Control --> BrowserStop["终止浏览器任务"]
    Control --> DesktopStop["停止桌面输入"]


### 3.1 服务边界

系统先保持三个可部署单元，避免过早拆成大量微服务：

1. **Automation Control Service**：任务状态机、策略决定、审批、租约、设备注册、服务间认证和事件编排。
2. **Browser Worker Pool**：运行 Playwright 浏览器任务。每个任务使用独立 rootless OCI 容器和策略出口代理。
3. **Desktop Edge Agent**：运行在用户设备，负责本地窗口、鼠标、键盘和应用能力；仅接受签名任务并本地再次校验。

PostgreSQL 保存任务、策略、审批和审计索引；Redis 保存短期租约、撤销状态和限流状态；S3/OSS 兼容对象存储保存加密截图、下载证据和执行产物。

控制服务不直接调用桌面输入 API，Worker 也不能读取 Desktop Edge Agent 的凭据。两个执行域只通过版本化任务协议与控制服务通信。

## 4. 任务协议与状态机

所有自动化调用使用版本化 `Automation Job Protocol`，禁止前端或第三方模块直接调用 Playwright、CUA 或 Worker 私有接口。

### 4.1 Job Envelope

```ts
type AutomationJobRequest = {
  protocolVersion: "2026-07-21";
  tenantId: string;
  projectId: string;
  sourceRunId?: string;
  executionDomain: "browser" | "desktop";
  steps: AutomationStep[];
  capabilityRequirements: CapabilityRequirement[];
  browserPolicy?: BrowserPolicy;
  desktopPolicy?: DesktopPolicy;
  approvalPolicy: "project-default" | "full-access";
  idempotencyKey: string;
  deadlineAt: string;
  traceContext?: W3CTraceContext;
};


任务必须包含租户、团队/项目作用域、有限动作列表、能力需求、审批策略、幂等键、截止时间和 trace context。服务端补充操作者、设备、策略版本和动作哈希后，才可派发执行。

### 4.2 状态流转

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> awaiting_approval: high-risk policy
    queued --> dispatched: approved or low-risk
    awaiting_approval --> dispatched: action approved
    awaiting_approval --> cancelled: rejected or expired
    dispatched --> running
    running --> awaiting_approval: ExternalEffect action
    running --> succeeded
    running --> failed
    running --> cancelled: kill switch or user cancel
    running --> expired: lease timeou
    failed --> retryable
    retryable --> dispatched: idempotent only


### 4.3 执行与重试规则

1. 控制服务先校验租户、项目、用户、设备、执行域、域名、应用和能力范围。
2. 任务以短期签名租约发送到 Browser Worker 或 Desktop Edge Agent。
3. 执行端再次校验签名、任务哈希、权限、方法、作用域和过期时间。
4. 每个动作产生结构化事件，并引用截图或其他证据。
5. 高风险动作使用绑定到动作哈希的一次性确认令牌。
6. 断线只允许恢复幂等动作；已经产生外部副作用的动作禁止自动重试。
7. 急停撤销租约，执行端无法续租后必须停止。

浏览器动作限制为结构化导航、点击、输入、读取、截图和受策略控制的下载；禁止任意脚本注入。桌面动作限制为经过能力映射的屏幕读取、鼠标、键盘、窗口和应用操作；禁止把任意 shell 命令作为普通动作下发。

## 5. 权限、凭据与审计

### 5.1 策略判定

权限采用 `RBAC + ABAC`：

- `RBAC` 角色包括成员、项目管理员、设备所有者和平台安全管理员。
- `ABAC` 判断租户、团队、项目、设备、执行域、域名、应用、动作、时间、任务风险和当前授权配置。
- 服务端和执行端都必须判定；执行端不能只信任服务端的布尔结果。

本地 `PermissionGuard` 需要验证权限 ID、过期时间、能力、方法、作用域、任务哈希和设备绑定。Tunnel RPC 派发前必须完成本地二次校验。

### 5.2 Credential Broker

Credential Broker 按任务和动作签发短期、最小权限凭据：

- 模型、任务协议和执行 Worker 永远不读取长期密钥。
- 浏览器登录态只注入对应的隔离上下文。
- 桌面凭据只绑定指定设备和应用。
- 日志、截图和事件流自动脱敏，禁止保存明文 Cookie、Token、密码和支付信息。
- 持久浏览器配置按租户和项目独立加密存储。

### 5.3 审计与证据

审计采用追加式事件模型，记录操作者、来源设备、权限决定、审批人、动作哈希、执行域、目标域名/应用、结果、耗时和证据引用。

事件和证据按租户隔离，支持保留策略、安全管理员查询和导出。普通项目管理员不能修改或删除审计记录。急停、权限撤销、CUA 安装、开放网络开启和完全访问开启属于高优先级安全事件。

## 6. API、SDK 与 Kortix 兼容

### 6.1 Automation API

建议提供以下版本化 API：

- `POST /v1/automation/jobs
- `GET /v1/automation/jobs/{id}
- `GET /v1/automation/jobs/{id}/events
- `POST /v1/automation/jobs/{id}/approvals
- `POST /v1/automation/jobs/{id}/cancel
- `POST /v1/automation/kill-switch
- `GET /v1/automation/devices
- `GET/POST /v1/automation/browser-profiles
- `GET/PUT /v1/automation/policies

服务不可用时返回明确的 `automation_unavailable`，不能静默降级为未经授权的本地执行。错误响应包含错误码、可重试标志、审批状态和审计事件 ID。

### 6.2 SDK 约束

`@kortix/sdk` 是唯一的产品客户端数据入口。新增自动化 SDK 表面，不允许 Web、Desktop 或第三方模块手写原始 fetch：

```ts
const run = await sdk.automation.jobs.create({
  executionDomain: "browser",
  projectId,
  steps,
  policy: "project-default",
});

for await (const event of sdk.automation.jobs.events(run.id)) {
  renderAutomationEvent(event);
}


复用现有 IAM、团队、项目、会话、Agent 身份、AG-UI 事件投影、SSE 订阅、W3C trace context 和 GenAI telemetry。OpenOPC 只增加 `automation-adapter` 与独立服务客户端。

协议使用独立 `protocolVersion`，至少保持当前版本和上一版本兼容。所有请求带 `tenantId`、`projectId`、`sourceRunId` 和幂等键。

### 6.3 升级边界

Kortix 核心路由、编排、IAM、WorkflowPort、Tunnel、Billing 和 Registry 不重写。上游升级时优先调整适配器或协议版本，不把自动化业务逻辑复制到主应用。

## 7. Web 与桌面用户体验

Web 是主入口，桌面端沿用同一套视觉语言并增加设备专属视图。布局采用 Google 风格的中性表面、左侧导航、中央执行区和右侧权限检查栏。

### 7.1 Web 工作台

- 左侧导航：任务、浏览器、设备、审计。
- 中央区域：任务标题、执行域、上下文状态、浏览器实时视图和执行时间线。
- 右侧栏：项目范围、域名、浏览器上下文、能力、审批状态和完全访问状态。
- 顶部始终保留急停入口；开放网络模式和完全访问模式使用明显状态标识。
- 高风险动作以内联审批条暂停，不用连续弹窗打断普通流程。

### 7.2 桌面工作台

- 显示设备在线状态、Edge Agent 版本、最后心跳、当前窗口和已授予能力。
- 中央显示受控桌面画面；右侧显示读取屏幕、鼠标、键盘、启动应用、文件写入等能力开关。
- Edge Agent 未安装或 CUA 缺失时显示安装来源、版本、权限和校验结果。
- 断线、急停或审批等待时，界面明确显示“输入已暂停”，不能让用户误以为仍在执行。

### 7.3 典型用户流程

1. 用户从 Web 或桌面创建任务并选择执行域。
2. 系统展示项目、设备、域名、能力、数据访问和审批预览。
3. 控制服务签发短期租约，执行端开始运行并推送事件。
4. 遇到 `ExternalEffect` 时在当前上下文中暂停，用户确认一次具体动作。
5. 任务完成后展示结果、时间线、证据引用和审计事件 ID。

## 8. 部署、网络安全与故障恢复

### 8.1 部署拓扑

- 单机或宝塔环境使用 Docker Compose 独立部署控制服务、Browser Worker、PostgreSQL、Redis 和对象存储适配器。
- 正式集群中控制服务无状态多副本，Browser Worker 独立水平扩容。
- Web 只访问公开控制 API，不直接连接 Worker。
- Desktop Edge Agent 只建立出站 mTLS WebSocket，不要求设备开放入站端口。

### 8.2 浏览器隔离

- 每个临时任务运行在 rootless OCI 容器中。
- 禁止宿主机目录挂载，限制 CPU、内存、执行时长和下载大小。
- 所有网络流量经过策略出口代理，阻断 DNS 重绑定、私网地址、云元数据地址和恶意重定向。
- 开放网络模式也不能访问服务器内网、云元数据接口或其他租户网络。

### 8.3 故障恢复

- 任务使用短期租约和心跳；执行端失联后租约自动失效。
- Browser Worker 崩溃后清理临时上下文；只有幂等步骤允许迁移重试。
- 使用事务性 Outbox 保存任务状态和事件，避免状态提交后事件丢失。
- 审批令牌、开放网络权限和完全访问模式均有明确过期时间。
- 控制服务恢复后按事件序号对账，不重复执行已经产生外部副作用的动作。
- 全局急停在 Redis 和数据库同时记录；实时连接中断时，执行端也会因无法续租而停止。

## 9. 可观测性

每个任务和动作都携带 `traceId`、`tenantId`、`projectId`、`sourceRunId`、`executionDomain` 和 `policyVersion`。控制服务、Worker 和 Edge Agent 输出结构化日志并关联同一 trace。

至少采集：

- 排队、审批、派发、执行和完成耗时；
- Worker/Edge Agent 心跳、租约失效和断线次数；
- 策略拒绝、审批重放、跨作用域请求和 SSRF 拦截；
- 浏览器资源使用、下载大小和任务成本；
- 急停延迟、停止确认和未收敛任务数。

监控面板沿用现有 OpenOPC Ops Gateway 指标体系，新增自动化执行域、租户和策略版本维度。任何跨租户拒绝或外部影响动作异常都应产生告警。

## 10. 定向验证计划

本阶段不运行全量测试套件，只运行与新边界直接相关的定向验证：

### 10.1 协议与 SDK

- Job Protocol 版本兼容、状态机、事件序号和幂等键契约测试。
- `@kortix/sdk` 与 Automation API 请求/响应契约测试。
- AG-UI/SSE 事件投影和 trace context 传递测试。

### 10.2 安全策略

- 跨租户、跨团队、跨项目访问拒绝。
- 过期租约、错误能力、错误域名、错误应用和重放审批令牌拒绝。
- 开放网络模式的管理员、项目和过期条件。
- 完全访问模式下不可逆动作仍逐次确认。
- SSRF、私网地址、云元数据地址和恶意重定向拦截。
- 急停后浏览器上下文销毁、桌面输入停止和租约无法续期。

### 10.3 执行端冒烟

- 临时浏览器任务。
- 持久项目浏览器任务。
- Desktop Edge Agent 屏幕读取任务。
- 需要确认的桌面输入任务。
- CUA 缺失时的明确授权安装流程。

### 10.4 故障注入与回归

- Worker 崩溃、Edge Agent 断线、控制服务重启、Redis 暂时不可用。
- Kortix 原有 Agent、会话、工作流、团队、计费和 SDK 流程保持可用。
- 关闭自动化 feature flag 后回到原有行为。

## 11. 分阶段上线与回滚

1. **阶段 A：协议与控制服务**。默认关闭，只允许内部契约测试。
2. **阶段 B：Web 浏览器自动化**。临时隔离上下文，限定白名单域名。
3. **阶段 C：Desktop Edge Agent**。管理员邀请设备，明确授权安装 CUA。
4. **阶段 D：持久浏览器、开放网络和完全访问**。仅管理员灰度启用。
5. **阶段 E：团队策略、开发者模块和计费扩展**。前述安全指标稳定后再接入。

回滚只关闭 feature flag、停止新任务和新设备注册，并保留急停通道。Automation Adapter 可以独立回滚为 `automation_unavailable`，不修改 Kortix 核心数据，不执行破坏性数据库回滚。

## 12. 验收标准

- 浏览器和桌面两个执行域都无法绕过本地权限校验。
- 高风险动作无法无审批执行或重放。
- 急停在浏览器和桌面端都能收敛到停止状态。
- 任一自动化服务故障不影响 Kortix 原有功能。
- Web 可独立使用；桌面端只增加本地设备能力。
- 上游 Kortix 升级只需调整适配器或协议版本。
- 定向验证覆盖协议、安全、执行端、故障和原有功能回归。

## 13. 后续实施边界

实施应先按本设计生成独立计划，优先完成协议、策略和控制服务，再接入 Browser Worker 和 Desktop Edge Agent。任何新增动作、权限等级、外部网络能力或长期凭据类型都必须先更新本设计和对应契约测试。
