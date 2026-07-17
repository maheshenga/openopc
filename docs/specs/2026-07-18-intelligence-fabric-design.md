# Kortix Intelligence Fabric 设计

状态：设计稿，待评审

日期：2026-07-18

## 1. 目标

在 Kortix 现有 Agent、Executor、Registry、Sandbox 和 Studio Worker 之上增加一层可插拔的 Intelligence Fabric，使图片生成可以逐步扩展为多 Agent、多模态内容生产平台，同时保持 Kortix 上游升级、旧项目配置和现有计费/IAM 边界的兼容性。

首个可交付切片是“协议优先的内容生产 Agent”：一个 Agent 能发现并调用受治理的 Studio 图片能力，产生可追踪的任务和资产；后续视频、语音、3D、数字人和批量混剪都通过相同的能力契约接入。

## 2. 范围和非目标

### 本阶段范围

- MCP 工具能力注册和渐进式发现。
- A2A Agent Card 和 Agent 间任务协作描述。
- 统一的能力、任务、事件、模型策略和资产来源契约。
- 复用现有 Studio API/Worker 执行图片任务。
- 模型质量、成本、时延和安全策略的可解释路由。
- C2PA 风格的媒体来源记录和签名资产清单。
- Registry 模块的能力声明、签名验证、SBOM 和 Sandbox 执行边界。

### 明确非目标

- 不替换现有 Studio Worker、租约、恢复、计费或对象存储实现。
- 不在 API 进程内执行第三方模块代码。
- 不把 Provider API key、URL、模型或凭据放入环境变量、Agent Card 或遥测标签。
- 本阶段不增加视频、语音、3D、数字人、批量混剪的生产路由和页面。
- 不引入第二套 Marketplace、Manifest 或权限系统。

## 3. 已验证的 Kortix 扩展边界

现有代码已经提供以下可复用边界：

- `apps/cli/src/executor/mcp.ts` 提供稳定的 MCP 元工具面，避免把整个连接器目录展开到 `tools/list`。
- `apps/api/src/executor/gateway.ts` 是凭据解析、风险策略、审批和审计的统一执行闸门。
- `packages/manifest-schema` 的 v2 将 Agent 治理与 Runtime 行为分开，并提供 `connectors`、`secrets`、`skills`、`kortix_cli` 和 `workspace` 授权。
- `packages/registry` 已支持 `registry:agent`、`registry:tool`、`registry:connector`、锁文件、内容哈希和项目级安装。
- `apps/sandbox` 提供隔离的 Daytona 执行环境。
- `apps/studio-worker/src/contracts.ts` 已把任务、尝试、资产、租约和事件抽象为可注入接口。

因此，Intelligence Fabric 作为扩展包和 API 适配层实现，不修改 Kortix 核心会话和连接器协议。

## 4. 分层架构

```text
Agent / Web / Mobile / Electron
              |
       SDK + A2A Client
              |
       Intelligence API
   (cards, capabilities, tasks)
              |
     Policy and Model Router
  (IAM, connector policy, budget,
   evaluation, data residency)
              |
       WorkflowPort adapter
              |
  Existing Studio API and Worker
              |
      Provider adapters + S3
              |
   OTel traces + C2PA provenance
```

### 4.1 协议契约包

新增一个无副作用的纯契约包（建议名称 `@kortix/intelligence-contracts`），只包含类型、Zod schema 和版本常量，不导入 API、数据库、Provider 或前端。

核心对象：

```ts
type CapabilityDescriptor = {
  id: string;
  version: string;
  modality: 'text' | 'image' | 'video' | 'audio' | '3d' | 'avatar';
  operation: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  execution: 'sync' | 'async' | 'stream';
  risk: 'read' | 'write' | 'destructive';
  estimatedCostCredits?: number;
  provenanceRequired: boolean;
};

type AgentCard = {
  id: string;
  version: string;
  displayName: string;
  capabilities: string[];
  protocols: Array<'mcp' | 'a2a'>;
  auth: { kind: 'kortix-project-token' | 'service-token' };
  trustTier: 'project' | 'company' | 'verified' | 'community';
  limits: { concurrency: number; maxTaskSeconds: number };
  cardHash: string;
};

type TaskEnvelope = {
  taskId: string;
  parentTaskId: string | null;
  accountId: string;
  projectId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  capabilityId: string;
  inputRef: string;
  idempotencyKey: string;
  deadlineAt: string | null;
  approval: 'not_required' | 'pending' | 'approved' | 'denied';
};
```

`AgentCard` 是可发现的描述，不是授权凭证。每次任务仍必须通过现有 IAM、Agent grant、Connector policy 和审批网关重新授权。

### 4.2 MCP 集成

首个 MCP 面保持现有的四步发现模式：

1. `connectors`：列出可用能力域。
2. `discover`：按意图搜索能力。
3. `describe`：返回输入/输出 schema、风险和费用估计。
4. `call`：提交受 IAM 和策略约束的任务。

Studio 能力以连接器命名空间暴露，例如 `studio.image.generate`。MCP 层只负责协议转换，实际创建任务调用与 Web/API 相同的 Studio service，不复制业务逻辑。

### 4.3 A2A 集成

A2A 只处理 Agent 间的能力发现和任务协作：

- Agent Card 从项目已安装 Agent 和 Registry 元数据生成。
- 外部 Agent 必须先被项目或公司信任列表允许。
- 每个任务带 `taskId`、`parentTaskId`、`cardHash`、幂等键和过期时间。
- A2A 事件只返回状态、进度、短错误码和资产 ID，不返回凭据、签名 URL 或原始 Provider 响应。
- 外部 Agent 不可直接调用数据库、对象存储或 Provider；所有执行回到 Kortix Gateway。

## 5. 任务编排和模型路由

### 5.1 WorkflowPort

第一阶段实现一个基于现有 API/数据库任务的 `WorkflowPort`：

- `startRun`
- `appendNode`
- `addDependency`
- `pauseForApproval`
- `resumeRun`
- `cancelRun`
- `readEvents`

图片 Studio Job 是第一个叶节点。现有 Worker 继续负责租约、提交、轮询、恢复和结算。未来可增加 Temporal adapter，但不能让 Temporal 直接拥有现有 Studio 表或计费事务。

### 5.2 可解释模型路由

模型路由由确定性策略完成，顺序如下：

1. IAM、项目策略、数据区域和 Provider capability 过滤。
2. 过滤不符合输入输出 schema、分辨率、时长或安全等级的模型。
3. 用离线评测结果、延迟、可用性和成本计算分数。
4. 根据项目预算选择主模型和最多一个降级模型。
5. 记录路由原因和评测版本，不记录原始 prompt、密钥或 Provider URL。

LLM 可以提出候选，但不能自行越过路由策略选择未授权模型。

### 5.3 评测

每种能力维护版本化的 golden set：

- schema/contract 检查；
- 内容安全和版权检查；
- 视觉/音频/3D 质量评分；
- 成本、延迟、失败率和重试率；
- 回归阈值和人工抽检结果。

评测结果存为模型版本的聚合记录，任务只引用 `evaluationVersion`。

## 6. 资产来源与可信输出

每个最终资产写入不可变来源清单，至少包含：

- 输入资产 hash 和父任务 ID；
- 能力 ID、Provider 定义 ID、模型版本和评测版本；
- 变换步骤和人工审批记录；
- 内容安全检查结果；
- 平台签名和清单版本。

清单与对象一起存储，但下载响应不泄露内部对象 key。图片切片完成后即可实现，视频、音频和 3D 只需复用同一 `AssetProvenance` 接口。

## 7. 开发者模块和供应链

继续沿用 Registry 三层模型：项目、公司、全球。每个模块的 `meta.capabilities` 声明：

- secrets；
- connectors；
- network egress；
- tools；
- writes；
- required runtime。

发布和安装流程增加：

1. 内容 hash 和锁文件校验。
2. Cosign/Sigstore 签名验证（全球验证模块必需）。
3. SBOM 和依赖漏洞扫描。
4. 静态能力诚实性检查，比较声明域名与代码引用。
5. Sandbox dry-run，确认只写入声明的 target。
6. 用户同意后才授予 Connector/Secret/Network 能力。

模块永远在 Sandbox 中运行；API 只解析 Manifest、策略和签名，不加载第三方模块代码。

## 8. 客户端和未来媒体适配

Web、移动端和 Electron 只消费同一个 SDK/事件游标协议。它们不分别实现 Provider 逻辑。

未来媒体适配遵循：

- 图片：现有 `image.generate`。
- 视频：异步任务 + 时间线/片段资产。
- 语音：流式或异步音频任务，共用事件协议。
- 3D：OpenUSD 作为专业母版，glTF 作为交付格式。
- 数字人：脚本、音频、角色和视频作为可追溯父子资产。
- 批量混剪：由 WorkflowPort 组合多个媒体叶节点。

团队实时编辑可在前端使用 Yjs/CRDT，但任务状态、计费、权限和资产来源始终以服务端事件和数据库为准。

## 9. 分阶段实施

### Phase 0：收口现有 Studio

- 完成 Task 9 遥测注入和最终复审。
- 将现有指标映射到 OpenTelemetry GenAI 语义约定。
- 保持 `STUDIO_ENABLED=false`，直到部署和验收门禁通过。

### Phase 1：协议切片

- 新建契约包和版本兼容测试。
- 将 `studio.image.generate` 接入现有 MCP 元工具。
- 增加 Agent Card 生成和项目级信任列表。
- 增加任务事件游标和幂等测试。

### Phase 2：编排和评测

- 实现 WorkflowPort 的数据库适配器。
- 增加 planner/executor/reviewer 三类 Agent 角色。
- 加入模型策略路由和 golden set 评测。

### Phase 3：可信资产和模块中心

- C2PA 来源清单。
- 模块签名、SBOM、能力诚实性检查和审批 UI。
- 公司/全球 Registry 信任层。

### Phase 4：多媒体产品页面

- 图片成品页先上线。
- 按同一任务/资产协议依次加入视频、语音、3D、数字人和混剪。
- 最后加入 CRDT 团队协同画布。

## 10. 验收标准

- 旧 Manifest、旧 Registry 项、现有 MCP 工具和 Studio API 测试全部通过。
- Agent Card 能被发现，但没有权限时无法创建任务。
- 同一任务通过 Web、MCP、A2A 创建时，落入同一 Studio service 和计费路径。
- 重试、取消、恢复、审批和幂等行为与现有 Studio Worker 一致。
- 任意模块都不能在 API 进程内执行或获得未声明的凭据/网络权限。
- 资产可验证来源，且响应和遥测不包含密钥、签名 URL、原始 Provider body 或高基数租户标签。
- 可以在不修改 Kortix 核心会话模型的情况下升级 Provider、模型和客户端。

## 11. 参考技术来源

- MCP stable revision `2025-11-25`: https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2025-11-25
- A2A `v1.0.1`: https://github.com/a2aproject/A2A/releases/tag/v1.0.1
- OpenTelemetry Semantic Conventions `v1.43.0`: https://github.com/open-telemetry/semantic-conventions/releases/tag/v1.43.0
- Temporal TypeScript `v1.20.3`: https://github.com/temporalio/sdk-typescript/releases/tag/v1.20.3
- C2PA Specifications: https://github.com/c2pa-org/specifications
- Cosign `v3.1.2`: https://github.com/sigstore/cosign/releases/tag/v3.1.2
- OpenUSD `v26.05`: https://github.com/PixarAnimationStudios/OpenUSD/releases/tag/v26.05
- Yjs `v13.6.31`: https://github.com/yjs/yjs/releases/tag/v13.6.31
