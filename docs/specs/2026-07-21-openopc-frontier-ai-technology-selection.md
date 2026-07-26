# OpenOPC 前沿 AI 技术选型与增量路线

- **日期：** 2026-07-21
- **状态：** 研究结论，待用户确认后进入实施计划
- **范围：** OpenOPC（Kortix 底座）的 Web SaaS、Electron、多人/多 Agent、开发者中心和模块生态
- **研究口径：** 官方规范、官方仓库和官方文档的实时快照；版本号和 GitHub star 只作为当日信号，不写入运行时契约

## 1. 结论先行

OpenOPC 最优路线不是再引入一个 Agent 平台，而是在 Kortix 现有内核上增加一层 **Capability Adapter + Protocol Projection + Trusted Module Registry**：

```text
OpenOPC Web / Admin / Electron
             |
        @openopc facade
             |
        @kortix/sdk（唯一客户端事实源）
             |
Kortix API + IAM + Executor + WorkflowPort + Studio Worker
             |
  MCP | AG-UI | A2A | Provider adapters | Module Registry
             |
Responses/Chat | Realtime/LiveKit | Image/Video/Audio/3D | Local models
             |
        OTel/OTLP + Langfuse/Phoenix sink + Evaluation
```

必须保持不变的事实源：

- Kortix 的会话、Agent、Executor、IAM、审批、审计、计费和 `@kortix/sdk`；
- `packages/intelligence-contracts`、`packages/intelligence-orchestration` 的任务/工作流契约；
- `packages/studio-runtime`、`packages/studio-adapters`、`apps/studio-worker` 的异步任务、幂等、租约、恢复和资产语义；
- `packages/registry`、`kortix.yaml`、锁文件和现有 Marketplace/Review Center；
- `packages/agent-tunnel` 的桌面设备边界和设备端 `PermissionGuard`。

新技术全部通过适配器或投影接入，并且默认关闭。这样既能提供明显的“先进感”，又能继续吸收 Kortix 上游升级。

## 2. 当前基础与缺口

| 领域 | 仓库已有能力 | 主要缺口 |
| --- | --- | --- |
| 多 Agent | AgentCard、TaskEnvelope、DAG、租约、预算、审批、事件 | 外部 Agent 互操作还不是完整 A2A 1.0 |
| 工具接入 | MCP、Connector、渐进式发现的部分实现 | 需要锁定 2025-11-25 版本协商和更完整的工具搜索 |
| 前端事件 | 会话/SSE、Intelligence hooks | 没有 AG-UI 标准事件投影 |
| 模型 | OpenAI-compatible adapter、LLM Gateway、Chat/Responses 基础 | 缺 capability profile、成本/延迟/失败原因驱动的路由 |
| 异步媒体 | StudioProviderAdapter、worker registry、幂等和资产存储 | 需要把新模态继续统一为同一 adapter，而不是新建 job 系统 |
| 桌面 | Electron bridge、tunnel、设备权限、命令校验 | 浏览器/Computer Use 的标准 provider 适配和运行时 origin allowlist |
| 模块生态 | Manifest、registry、lock、capability 声明、审核方向 | 签名、SBOM、provenance、沙箱 dry-run、回滚尚未闭环 |
| 可观测性 | Sentry、Better Stack、Prometheus、Langfuse sink 基础 | OTel GenAI span、trace context、成本和脱敏约定还需统一 |
| 质量 | evaluation schema、golden set、route snapshot | 开发者模块的发布前回归和 red-team 门禁尚未完成 |

## 3. 选型原则

1. **增量优先：** 不替换 Kortix WorkflowPort、Executor、IAM 或数据库事实源。
2. **协议优先：** 优先选择有公开规范、版本协商和多语言实现的协议。
3. **可退化：** 新 provider 不可用时，任务仍可回退到现有 provider 或明确失败，不改变旧功能。
4. **安全先于自主性：** 文件、网络、浏览器、CLI、支付和外部写操作必须经过权限、审批和审计。
5. **许可证可运营：** SaaS 默认只启用许可证、地域和商用条款清晰的组件。
6. **用户价值可见：** 技术必须转化为更少配置、更快完成、更容易恢复和更可解释的体验。

## 4. P0：现在应该做

P0 代表高用户价值、成熟度高、可以绑定现有扩展点且不会破坏 Kortix 升级的能力。

### 4.1 Capability Catalog + MCP 2025-11-25

**用途：** 让 Agent 从大量工具和模块中按任务搜索能力，而不是把全部工具一次性放进上下文。

**落点：** `packages/registry`、`packages/intelligence-contracts`、现有 Executor MCP discovery。

**要求：**

- 版本协商、Streamable HTTP、OAuth 和标准错误语义；
- 工具分层：目录搜索 -> 小范围加载 -> 执行；
- 工具 manifest 带权限、网络域名、写入范围、费用、延迟、兼容版本和风险等级；
- MCP Tasks 映射到现有 `intelligence_tasks`，不替换任务状态机；
- 写操作、审批动作和高风险工具不得使用无约束的批量程序化调用。

**用户感知：** 输入一句目标后，系统自动找到合适的行业模块/工具，并在执行前显示将使用的能力和权限。

参考：[MCP 2025-11-25 specification](https://modelcontextprotocol.io/specification/2025-11-25)、[MCP client best practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices.md)。

### 4.2 AG-UI 事件投影

**用途：** 把现有 SSE/任务事件转换为统一的 Agent-to-UI 事件：文本流、工具调用、阶段状态、审批、artifact、错误和恢复。

**落点：** `packages/sdk` 增加 `toAgUiEvent()` 和 React hooks；API/SSE 继续作为传输；Web 和 Electron 共用同一投影。

**边界：** AG-UI 只负责 Agent 与 UI 的事件协议，不负责编排、权限或持久化；不把早期生成式 UI 协议直接写入核心数据库。

**用户感知：** 任务页会显示“正在规划 -> 并行执行 -> 等待审批 -> 生成资产 -> 校验结果”的实时过程，失败可以继续、重试或回放。

参考：[AG-UI](https://github.com/ag-ui-protocol/ag-ui)、[Architecture](https://docs.ag-ui.com/concepts/architecture.md)。

### 4.3 Responses API provider profile

**用途：** 使用 OpenAI 新一代 Responses transport 的多轮状态、MCP、文件/网页/计算机/代码工具和后台任务能力，同时保留 Chat Completions 以及其他 OpenAI-compatible provider。

**落点：** `apps/llm-gateway`、`packages/llm-gateway` 增加 capability profile 和 transport adapter；不在 Web 直接调用 provider。

**路由建议：**

- 复杂规划、审查和最终交付：高质量模型；
- 普通 Agent 工作：平衡模型；
- 分类、路由、抽取和批处理：低成本高吞吐模型；
- 路由结果记录模型版本、原因、预算、fallback 和 evaluation snapshot。

同时启用 prompt caching、预算预估和安全的工具发现。稳定的系统提示、工具描述和租户策略放在可缓存前缀；不得为了缓存而混入用户秘密。

参考：[Migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses.md)、[Tools](https://developers.openai.com/api/docs/guides/tools-tool-search.md)、[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching.md)。

### 4.4 Playwright MCP + 受控桌面自动化

**用途：** 让 Agent 能可靠地操作网页、表单、PDF 和开发者工具；这是用户最容易感知的“强大”能力之一。

**落点：** Playwright 作为确定性执行层，接入 `packages/agent-tunnel` 和现有审批/审计；Web 使用隔离浏览器，Electron 使用设备端 tunnel。

**策略：** DOM/accessibility tree 优先，视觉模型只作为 fallback；allowed/blocked origins、浏览器隔离、下载目录和高影响动作确认必须在服务端和设备端双重执行。

Stagehand 可作为 P1 的 act/observe/extract、自愈和 action caching 层，但不能替代 Playwright 基础层。

参考：[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Stagehand](https://github.com/browserbase/stagehand)。

### 4.5 统一语音传输：LiveKit + provider adapter

**用途：** 浏览器和 Electron 的实时语音对话、打断、turn detection、STT/LLM/TTS 组合以及未来电话/房间能力。

**落点：** LiveKit room/session 映射到 Kortix project/session；语音仍是模块，不恢复核心 Voice Studio 页面。OpenAI Realtime、其他 Realtime provider 和自托管 STT/TTS 通过 adapter 接入。

**选择：** LiveKit 作为生产传输和会话层；Pipecat 只作为可选 Python media worker，不同时引入两套核心实时运行时。

参考：[LiveKit Agents](https://github.com/livekit/agents)、[OpenAI voice agents](https://developers.openai.com/api/docs/guides/voice-agents.md)。

### 4.6 推理与成本路由

**服务端：** vLLM 作为自托管 GPU 的高吞吐 OpenAI-compatible worker；当前 LLM Gateway 继续是唯一业务入口。

**桌面端：** llama.cpp 作为可控的本地 OpenAI-compatible runtime；Ollama 作为易用的安装和模型管理选项；WebLLM/Transformers.js 只做轻量隐私 fallback，不承诺所有浏览器性能。

**LiteLLM：** 仅作为外部 provider adapter、路由能力参考或隔离部署选项；不直接替换当前 Gateway，避免重复虚拟密钥、预算和审计系统。

参考：[vLLM](https://github.com/vllm-project/vllm)、[llama.cpp](https://github.com/ggml-org/llama.cpp)、[Ollama](https://github.com/ollama/ollama)、[WebLLM](https://github.com/mlc-ai/web-llm)。

### 4.7 OTel/OTLP + 供应链信任闭环

**可观测性：** 以 OpenTelemetry、W3C `traceparent` 和 OTLP 为底，增加 `openopc.*` span 属性和低基数指标。记录 Agent、工具、MCP、模型、token、预算、重试、provider 和 artifact 关联；默认脱敏 prompt、response、secret、signed URL 和原始 provider body。Langfuse/Phoenix 只是可替换 sink。

**模块供应链：** 复用现有 Registry 和 CI，增加 OCI artifact digest、Cosign/Sigstore 签名、Syft SBOM、Trivy 扫描、SLSA/in-toto provenance、人工审核、安装前 capability consent 和可回滚版本。

**用户感知：** 安装模块前能看到它需要的权限、域名、成本、签名、SBOM 和评测分数；管理员能看到供应链健康和异常成本。

参考：[OpenTelemetry GenAI](https://github.com/open-telemetry/semantic-conventions-genai)、[Langfuse](https://github.com/langfuse/langfuse)、[Cosign](https://github.com/sigstore/cosign)、[OCI Image Spec](https://github.com/opencontainers/image-spec/blob/main/manifest.md)、[Syft](https://github.com/anchore/syft)、[Trivy](https://github.com/aquasecurity/trivy)、[SLSA](https://slsa.dev/)。

## 5. P1：完成基础闭环后试点

| 能力 | 推荐方案 | 价值 | 约束 |
| --- | --- | --- | --- |
| 外部 Agent 协作 | A2A 1.0 Agent Card、Send/Get/List/Cancel/Subscribe、SSE/push | 与行业 Agent/模块互操作 | 只用于跨模块/跨租户边界；内部仍用 Kortix session/task |
| Computer Use | OpenAI/Gemini/Anthropic provider adapter | 让 Web/Desktop 可完成真实电脑工作 | 隔离浏览器/VM、提示注入防护、高影响动作必须 HITL |
| 浏览器自愈 | Stagehand | 页面变化后降低脚本维护成本 | 独立 worker，动作仍走 Playwright 和审批 |
| 视频 | Wan2.2 GPU worker | 高质量 T2V/I2V/S2V，适合异步媒体模块 | 需要 GPU capacity/cost gate；不新增 job 系统 |
| 3D | TRELLIS Linux GPU worker | 文本/图片到多种 3D 表示 | Linux+NVIDIA 优先；OpenUSD 母版、glTF 交付 |
| 本地推理 | WebLLM、Transformers.js、llama.cpp | 隐私、离线、低延迟 | 设备能力检测和下载大小限制 |
| 质量门 | Promptfoo；DeepEval/Ragas 离线 worker | 模块回归、红队和工具正确性 | 不把在线 LLM judge 放进请求路径 |
| 长任务 | Temporal adapter | 多小时/多日、审批暂停恢复 | 保留 Postgres WorkflowPort 为默认事实源 |
| 纯计算插件 | WASI Preview 2、Component Model、wasmCloud/Extism | 跨语言、低权限、快速启动 | WASM 不是 OS 级隔离；文件/网络/CLI 仍进完整 sandbox |
| 记忆 | `MemoryPort`，Postgres 事实源；Mem0/Graphiti provider | 跨会话偏好和时间有效知识 | 记忆可删除、可查看、可带来源；不绑定单一供应商 |

## 6. P2：有条件再启用

- **LTX-2：** 音视频同步和 retake 能力有吸引力，但商业实体/竞争产品条款需要先完成法务和商业许可。
- **Hunyuan3D/HunyuanVideo：** 模型能力强，但地域、用户规模和 Hosted Service 条款不适合作为全球 SaaS 默认 provider。
- **Skyvern：** AGPL-3.0，不直接并入闭源 SaaS；只可在隔离服务并完成法务评估后试点。
- **Firecracker/Kata：** 只有当模块威胁模型和规模证明 gVisor/现有 sandbox 不够时再增加。
- **OPA/Cedar/OpenFGA/SpiceDB：** 仅用于跨服务 admission 或超大规模关系授权；当前 IAM 仍是唯一权限事实源。
- **A2UI 等早期生成式 UI：** 可作为模块实验，不写入核心 UI/数据库契约。

## 7. 明确不采用

1. 不用 LangGraph、CrewAI、AutoGen、Inngest、Restate 等替换 Kortix 主编排器；它们可做开发者模块示例，但不能成为第二套事实源。
2. 不建立第二套 Marketplace、Manifest、IAM、计费或资产系统。
3. 不把所有 MCP 工具一次性注入上下文，不允许模块在 API 进程直接执行第三方代码。
4. 不把 OpenAI Agent Builder 作为新平台基础；其生命周期和平台绑定风险不符合 OpenOPC 的升级目标。
5. 不把模型内部链式思考原文展示给用户；只展示阶段摘要、工具动作、证据和可审计 trace。
6. 不为了“前沿”同时引入多个向量数据库、多个记忆平台或多个主调度器。

## 8. 用户应该实际感受到的强大

技术选型最终要落到以下可见流程，而不是增加设置页面：

1. **一句话变计划：** 用户输入目标，系统给出可编辑的步骤、预计时间、预计成本和将使用的模块。
2. **并行多 Agent：** 研究、执行、校验可以并行；页面显示阶段和依赖，不展示不可读的内部思维链。
3. **自动路由：** 根据任务类型、质量、预算、延迟、数据区域和设备能力选择模型/provider，并说明原因。
4. **实时过程：** 文本、工具、审批、队列、artifact 和错误都在同一任务时间线上更新。
5. **可恢复：** 暂停、继续、重试、取消、回放和从上一步分叉都复用同一任务 ID 和幂等语义。
6. **多模态链：** 文案 -> 配音 -> 视频/数字人 -> 3D/封面等模块可以串联，产物具有父子关系和来源清单。
7. **可信模块：** 安装前显示权限、签名、SBOM、评测、成本和兼容范围；失败自动回滚上一个版本。
8. **Web/桌面无缝：** Web 完成远程工作；桌面连接后只增加本地文件、Git、CLI、浏览器和系统自动化，不改变业务页面。
9. **隐私选择：** 敏感的小任务可以切换到本地 llama.cpp/Ollama；云端任务仍遵守组织策略和审计。

## 9. 与现有仓库的绑定规则

| 新增能力 | 绑定位置 | 禁止做法 |
| --- | --- | --- |
| AG-UI | `packages/sdk` hooks + 现有 SSE | Web 直接请求 provider 或另建事件总线 |
| MCP/A2A | `packages/intelligence-contracts`、Executor adapter | 改写内部 WorkflowPort 为外部协议 |
| 新媒体 provider | `packages/studio-runtime`/`studio-adapters`、`apps/studio-worker` | 为每种模态新建 job/计费/资产表 |
| 模型路由 | `apps/llm-gateway`、provider profile | 在前端保存 key 或绕过 Gateway |
| 浏览器/桌面自动化 | `packages/agent-tunnel`、设备端 PermissionGuard | 云端静默提权或绕过本地校验 |
| Developer Center | `packages/registry`、Manifest、Review Center、IAM | 直接加载第三方 JS/原生代码进 API |
| 供应链 | 现有 CI 的 Trivy/Syft/Cosign 模式 | 只看名称或 star，不校验 digest/签名 |
| 观测/评测 | OTel + 现有 Langfuse/evaluation schema | 将 prompt、密钥或签名 URL 写入日志 |

所有新表和新路由都应是 additive；新开关关闭时，Kortix 基线行为必须保持不变。

## 10. 建议实施顺序

### 里程碑 A：体验骨架（P0）

1. Capability manifest、渐进式工具发现和 MCP 版本协商；
2. AG-UI 事件投影和任务时间线；
3. Responses provider profile、成本/延迟/fallback 记录；
4. OTel trace context、脱敏和基础成本面板。

### 里程碑 B：强大执行（P0/P1）

1. Playwright MCP 和浏览器隔离；
2. LiveKit 语音模块；
3. Desktop tunnel 的审批、kill switch、origin allowlist；
4. vLLM/llama.cpp provider onboarding。

### 里程碑 C：开发者生态（P0/P1）

1. OCI module release、Cosign、SBOM、扫描和 provenance；
2. sandbox dry-run、capability consent、Review Center、回滚；
3. Promptfoo 发布前评测、immutable evaluation snapshot；
4. 计量、分成、结算和争议记录。

### 里程碑 D：外部互操作和重任务（P1）

1. A2A 1.0 compatibility layer；
2. Temporal adapter（只针对超长任务）；
3. Wan2.2/TRELLIS/Computer Use 独立 worker 试点；
4. MemoryPort 和本地推理 fallback。

## 11. 验收门槛（不要求全量测试）

每个里程碑只运行相关的 focused gates：

- SDK 类型/公共导出和事件映射测试；
- API/IAM/预算/审批/幂等/租约/恢复测试；
- Web 无桌面完成任务、SSE 重连和任务回放测试；
- Electron tunnel、origin、PermissionGuard、撤销和 kill switch 测试；
- provider adapter 的 fake、超时、未知结果、取消和计费证据测试；
- 模块 manifest、签名、SBOM、sandbox、租户隔离、安装/回滚测试；
- 受保护的真实 provider smoke test（不把密钥写入仓库）；
- `git diff --check`、依赖许可证和 secret/signed-URL 扫描。

不得把“所有测试通过”作为每次增量开发的前置条件；但未经对应 focused gate 证明的能力，不标记为生产可用。

## 12. 官方资料

- [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [A2A specification](https://a2a-protocol.org/latest/specification/)
- [AG-UI](https://github.com/ag-ui-protocol/ag-ui)
- [OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses.md)
- [OpenAI computer use](https://platform.openai.com/docs/guides/tools-computer-use)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [LiveKit Agents](https://github.com/livekit/agents)
- [vLLM](https://github.com/vllm-project/vllm)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [Wan2.2](https://github.com/Wan-Video/Wan2.2)
- [Microsoft TRELLIS](https://github.com/microsoft/TRELLIS)
- [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai)
- [Cosign](https://github.com/sigstore/cosign)
- [WASI](https://github.com/WebAssembly/WASI)
- [Temporal](https://temporal.io/)

## 13. 决策请求

建议先批准 **P0 全部**，并将 P1 限定为独立试点；P2 只有在许可证、地域、GPU 成本和真实负载验收通过后才进入生产。批准后，下一份实施计划只覆盖里程碑 A 的四项能力，不对 Kortix 核心编排、数据库、客户端业务页面或现有多媒体范围做大规模改写。
