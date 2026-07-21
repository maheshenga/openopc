# OpenOPC Responses Provider Profile 设计

**日期：** 2026-07-21

**状态：** 已批准方案，待实施计划

## 1. 目标

在现有 Kortix LLM Gateway 上增加可验证的 provider capability profile，让路由器在调用上游前判断一个候选是否支持当前请求需要的能力，并把选择、排除和 fallback 原因写入现有脱敏 trace。

本阶段继续保留现有 Chat Completions 客户端入口。仓库已有的 `openai-responses` transport 仍负责把 Chat 请求转换为 Responses 上游请求；Web、Desktop 和 `@kortix/sdk` 不直接调用 provider。

## 2. 不在本阶段实现

- 不开放公共 `POST /v1/responses`。
- 不实现 Responses 后台任务的创建、查询、取消或持久化。
- 不启用 Computer Use、Web Search、Code Interpreter 等 provider-native tools。
- 不新增数据库表、任务系统或事件总线。
- 不修改 Kortix IAM、预算、计费、会话或现有 Chat Completions 响应契约。
- 不恢复视频、语音、3D、数字人或批量混剪成品页面。

## 3. 方案选择

### 方案 A：能力画像优先，采用

在 `@kortix/llm-gateway` 内定义严格、低基数的能力画像，把画像附加到现有 `UpstreamDescriptor`。Gateway 从 Chat 请求提取能力需求，在现有候选列表中排除显式不支持的上游，然后继续使用现有 retry、circuit breaker、fallback、计费和 trace 流程。

优点是改动增量、可测试，并且不改变客户端和 Kortix 核心事实源。缺点是本阶段不会向用户开放完整 Responses 原生状态模型。

### 方案 B：立即开放公共 Responses API，不采用

直接提供 `/v1/responses` 能带来原生请求体验，但同时需要状态续接、后台任务、取消、查询、SDK、权限和持久化契约。该范围无法在一个兼容性切片中可靠完成。

### 方案 C：直接进入浏览器自动化，不采用

Playwright MCP 的用户感知强，但在 provider 能力、origin allowlist、审批、隔离和 kill switch 尚未形成闭环前直接接入，会扩大执行风险并绕过现有 Gateway 路由能力。

## 4. 能力画像契约

在 `packages/llm-gateway` 增加 `UpstreamCapabilityProfile`。画像仅描述通过当前 Gateway 可以安全使用的端到端能力，而不是 provider 宣称但平台尚未接通的能力。

```ts
export interface UpstreamCapabilityProfile {
  transport: 'chat-completions' | 'responses';
  streaming?: boolean;
  imageInput?: boolean;
  functionTools?: boolean;
  reasoning?: boolean;
  stateContinuation?: boolean;
  background?: boolean;
}
```

字段缺失表示 `unknown`，不是 `false`。这样现有 descriptor 和第三方 OpenAI-compatible provider 不需要一次性补齐画像，也不会因升级引入行为回归。

`UpstreamDescriptor.capabilities` 为可选字段。Gateway 提供一个纯函数规范化画像：

- `transport` 必须与 `descriptor.kind` 一致；
- 只接受上述固定字段；
- 除 `transport` 外的能力字段只接受布尔值，不允许字符串、URL、任意 metadata 或 provider payload；
- `stateContinuation` 和 `background` 只有平台已形成完整创建、读取、取消和权限闭环后才能声明为 `true`。

当前 `openai-codex` descriptor 显式声明 `transport: 'responses'`。`streaming`、`imageInput`、`functionTools` 和 `reasoning` 分别在对应请求映射测试通过后才能标记为 `true`；`stateContinuation` 和 `background` 在本阶段保持 `false`。其他 descriptor 没有画像时继续按 legacy-compatible 路径工作。

## 5. 请求需求与路由

Gateway 从已解析的 Chat 请求生成 `GatewayCapabilityRequirements`：

- `streaming`：`body.stream === true`；
- `imageInput`：复用现有 `requestHasImage()`；
- `functionTools`：请求包含非空 function tools；
- `reasoning`：请求显式包含 Gateway 已支持的 reasoning/thinking 配置。

Chat 路由不得从客户端自定义 `metadata` 推导 `stateContinuation`、`background` 或 native tool 权限，防止客户端通过 metadata 绕过后续权限设计。

候选处理顺序：

1. 现有 control plane 返回模型路由计划。
2. 现有 `resolveUpstream` 返回有限候选集。
3. Gateway 规范化每个候选画像。
4. 显式画像畸形时排除该候选并记录 `PROFILE_INVALID`。
5. 画像中某项显式为 `false` 且请求需要该能力时，排除该候选并记录 `CAPABILITY_UNSUPPORTED`。
6. 字段缺失的 legacy 候选保持当前行为，不因 `unknown` 被排除。
7. 剩余候选进入现有 retry、circuit breaker、empty-completion 和 fallback 流程。

如果存在上游候选但全部因能力不兼容被排除，Gateway 在任何 provider I/O 前返回稳定的 `capability_unavailable` 错误。若根本没有解析出候选，继续使用现有 `model_unavailable` 错误。

如果所有候选都因显式画像畸形被排除，这是 control-plane/provider 配置错误，返回现有类别的 `routing_unavailable` `502`，而不是向用户返回 `capability_unavailable`。

## 6. Trace 与脱敏

复用现有 `GatewayTrace.metadata.gatewayRouting`，增加低基数决策字段：

```ts
{
  requiredCapabilities: ['streaming', 'function_tools'],
  selectedProfile: {
    transport: 'responses',
    streaming: true,
    functionTools: true
  },
  exclusions: [
    {
      model: 'model-id',
      reason: 'CAPABILITY_UNSUPPORTED',
      capabilities: ['function_tools']
    }
  ]
}
```

允许记录模型 ID、transport、能力布尔值和固定原因码。禁止记录 prompt、input/output、tool arguments、provider URL、header、credential、token、cookie、signed URL、原始 provider body 或 reasoning 内容。

`candidatesTried` 仍只表示实际发起过 provider 请求的候选；能力不兼容但未发送请求的候选只进入脱敏 routing decisions。

## 7. 兼容性边界

- `capabilities` 为 additive optional field，现有 `UpstreamDescriptor` 构造代码保持可编译。
- 缺少画像不会改变当前 Chat 请求分发。
- 只对显式 `false` 的能力做预分发排除。
- 现有 `openai-compat`、Anthropic、Bedrock 和 Codex transport 不改响应转换格式。
- 现有 `ModelRoutePlan`、IAM、billing、budget、retry 和 circuit breaker 接口不改名、不搬迁。
- 不在 Web、Desktop 或 SDK 增加 raw `fetch`。

## 8. 错误处理

- 无 Bearer token、预算拒绝、路由不可用和模型不可用继续返回现有错误。
- 全部候选能力不兼容时返回 HTTP `400` 和 `capability_unavailable`。
- 全部候选画像无效时返回 HTTP `502` 和 `routing_unavailable`。
- 错误响应只包含稳定代码、请求 ID、请求模型和可操作建议，不列出 provider URL、凭据或原始上游信息。
- provider 在运行时错误地宣称支持某项能力时，继续进入现有上游错误、retry 和 fallback 机制；画像不是绕过运行时防护的保证。

## 9. 聚焦验收

实施采用 RED-GREEN：

1. `UpstreamCapabilityProfile` 规范化测试先失败，覆盖固定字段、transport 一致性和未知字段拒绝。
2. 请求需求提取测试覆盖 streaming、image、function tools 和 reasoning，确认 metadata 不能启用后台或状态续接。
3. handler 测试覆盖显式不支持候选被跳过、`unknown` 保持兼容、兼容 fallback 被选中以及全不兼容时零 provider I/O。
4. trace 测试覆盖固定原因码、所需能力、选中画像，并扫描敏感字段。
5. API descriptor 测试确认 `openai-codex` 使用 Responses transport 且后台/状态续接保持关闭。
6. 运行 `@kortix/llm-gateway` 聚焦测试与 typecheck、API descriptor 聚焦测试与 API typecheck、Biome 和 `git diff --check`。

不运行仓库全量测试，也不以本阶段通过作为公共 Responses API 或生产就绪声明。

## 10. 后续阶段

画像闭环稳定后，再分别规划：

1. 原生 `/v1/responses` 前台请求契约；
2. Responses 后台任务、状态续接、取消与持久化；
3. OTel trace context 和 GenAI semantic attributes；
4. Playwright MCP、浏览器隔离、审批、origin allowlist 和 kill switch。
