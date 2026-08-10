export interface AllowEntry {
  method: string;
  path: string;
  reason: string;
}

export const uncoveredAllow: AllowEntry[] = [
  {
    method: "GET",
    path: "/v1/admin/developer/applications",
    reason: "existing admin developer application read surface; covered by admin contract tests and intentionally outside the public ke2e catalog",
  },
  {
    method: "GET",
    path: "/v1/admin/developer/applications/:*",
    reason: "existing admin developer application detail surface; covered by admin contract tests and intentionally outside the public ke2e catalog",
  },
  {
    method: "GET",
    path: "/v1/module-host/platform/releases/:*",
    reason: "existing module-host platform release lookup; covered by host/release contract tests and intentionally outside the public ke2e catalog",
  },
  {
    method: "GET",
    path: "/v1/module-host/platform/releases/:*/*",
    reason: "existing module-host platform release asset lookup; covered by host/release contract tests and intentionally outside the public ke2e catalog",
  },
  {
    method: "GET",
    path: "/v1/module-services/ai/images/models",
    reason: "module capability-token API; covered by the dedicated SDK, route, grant-revalidation, and browser-bootstrap suites until ke2e can issue module capabilities",
  },
  {
    method: "POST",
    path: "/v1/module-services/ai/images/estimates",
    reason: "module capability-token API; covered by the dedicated SDK, route, grant-revalidation, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "POST",
    path: "/v1/module-services/ai/images/jobs",
    reason: "module capability-token API; covered by idempotency, grant binding, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "GET",
    path: "/v1/module-services/ai/images/jobs/:*",
    reason: "module capability-token API; covered by grant-isolation, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "GET",
    path: "/v1/module-services/ai/images/jobs/:*/events",
    reason: "module capability-token API; covered by cursor, fallback, redaction, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "GET",
    path: "/v1/module-services/ai/images/jobs/:*/outputs",
    reason: "module capability-token API; covered by direct output pagination, grant-isolation, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "POST",
    path: "/v1/module-services/ai/images/jobs/:*/cancel",
    reason: "module capability-token API; covered by terminal-state, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "POST",
    path: "/v1/module-services/ai/images/assets",
    reason: "module capability-token multipart API; covered by MIME, size, storage-integrity, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "GET",
    path: "/v1/module-services/ai/images/assets",
    reason: "module capability-token API; covered by pagination, grant-isolation, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "GET",
    path: "/v1/module-services/ai/images/assets/:*/preview-url",
    reason: "module capability-token API; covered by signed-URL validation, grant-isolation, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "GET",
    path: "/v1/module-services/ai/images/assets/:*/thumbnail-url",
    reason: "module capability-token API; covered by bounded derivative generation, private cache semantics, grant-isolation, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "GET",
    path: "/v1/module-services/ai/images/assets/:*/download",
    reason: "module capability-token API; covered by byte-integrity, grant-isolation, SDK, route, and Studio backend suites until ke2e can issue module capabilities",
  },
  {
    method: "POST",
    path: "/v1/module-services/ai/images/assets/:*/delete",
    reason: "module capability-token API; covered by the stable fail-closed SDK and route contract until deletion policy and ke2e capability issuance are available",
  },
  {
    method: "POST",
    path: "/v1/module-services/ai/images/assets/:*/retention",
    reason: "module capability-token API; covered by the stable fail-closed SDK and route contract until retention mutation and ke2e capability issuance are available",
  },
  {
    method: "PUT",
    path: "/v1/executor/projects/:*/connectors/:*/sensitive",
    reason:
      "executor-scoped runtime endpoint — called by the in-sandbox executor with its own token, not by end-user clients; the user-facing equivalent is flow-covered",
  },
  {
    method: "DELETE",
    path: "/v1/projects/:*/channels/teams/installation",
    reason: "teams disconnect — manage-ACL teardown symmetric with the flow-covered connect",
  },
  {
    method: "GET",
    path: "/v1/projects/:*/channels/teams/manifest",
    reason: "teams sideload manifest — read-only generated artifact",
  },
  {
    method: "GET",
    path: "/v1/channels/teams/identity/login/:*",
    reason: "unauthenticated HTML redirect to the web teams-login page (identity link flow)",
  },
  {
    method: "POST",
    path: "/v1/channels/teams/identity/bind",
    reason: "authed identity bind, hit from the web teams-login page — mirrors the slack identity bind",
  },
  {
    method: "GET",
    path: "/v1/projects/:*/channels/teams/file",
    reason: "server-side file download proxy, exercised via the in-sandbox teams CLI, not end-user clients",
  },
  {
    method: "POST",
    path: "/v1/projects/:*/channels/teams/file/upload",
    reason: "server-side consent-card upload, exercised via the in-sandbox teams CLI, not end-user clients",
  },
  {
    method: "POST",
    path: "/v1/webhooks/teams/:*/messages",
    reason: "Bot Framework BYO-bot inbound webhook — JWT-authed by Microsoft, same shape as the flow-covered managed /v1/webhooks/teams/messages",
  },
  {
    method: "GET",
    path: "/v1/webhooks/teams/oauth/callback",
    reason: "Teams admin-consent OAuth callback — browser redirect from Microsoft (admin_consent+tenant), not an API client route; mirrors the slack oauth callback",
  },
];

export const externalRoutes: AllowEntry[] = [
  { method: "GET", path: "/v1/llm/models", reason: "llm-gateway standalone service (gateway-*.kortix.com), not in the main API manifest" },
  { method: "GET", path: "/v1/models", reason: "llm-gateway model-catalog alias" },
  { method: "GET", path: "/v1/openai/models", reason: "llm-gateway OpenAI-compat catalog alias" },
  { method: "POST", path: "/v1/chat/completions", reason: "llm-gateway chat completions" },
  { method: "POST", path: "/v1/llm/chat/completions", reason: "llm-gateway chat completions alias" },
  { method: "POST", path: "/v1/openai/chat/completions", reason: "llm-gateway OpenAI-compat chat alias" },
  { method: "GET", path: "/v1/setup/health", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/install-status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/sandbox-providers", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/setup-status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/setup-wizard-step", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/bootstrap-owner", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/setup-complete", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/setup-wizard-step", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
];
