import type {
  accountGithubInstallations,
  accountInvitations,
  accountMembers,
  accounts,
  auditEvents,
  automationApprovals,
  automationBrowserProfiles,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
  automationKillSwitches,
  automationPolicies,
  chatChannelBindings,
  chatInstalls,
  chatThreads,
  creditAccounts,
  developerInvitations,
  developerModuleArtifactUploads,
  developerModuleArtifacts,
  developerModuleReleaseDistributionEvents,
  developerModuleReleaseReviewEvents,
  developerModuleReleases,
  developerModuleTrustAttestations,
  developerModuleVerificationCapabilities,
  developerModuleVerificationFindings,
  developerModuleVerificationRuns,
  developerOrganizations,
  developerPublisherAuditEvents,
  developerPublisherMembers,
  developerPublisherRoleEnum,
  developerPublishers,
  gatewayApiKeys,
  gatewayBudgets,
  gatewayRequestLogs,
  kortixApiKeys,
  legacySandboxMigrations,
  projectGitConnections,
  projectGitCredentials,
  projectMembers,
  projectModuleInstallationEvents,
  projectModuleInstallations,
  projectSecrets,
  projectSessions,
  projectSnapshotBuilds,
  projects,
  sandboxTemplates,
  sandboxes,
  sessionSandboxes,
  tunnelAuditLogs,
  tunnelConnections,
  tunnelPermissionRequests,
  tunnelPermissions,
  usageEvents,
} from './schema/kortix';
import type { apiKeys } from './schema/public';

// Select types (what you get back from queries)
export type Account = typeof accounts.$inferSelect;
export type AccountMember = typeof accountMembers.$inferSelect;
export type AccountInvitation = typeof accountInvitations.$inferSelect;
export type AccountGithubInstallation = typeof accountGithubInstallations.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type NewAccountMember = typeof accountMembers.$inferInsert;
export type NewAccountInvitation = typeof accountInvitations.$inferInsert;
export type NewAccountGithubInstallation = typeof accountGithubInstallations.$inferInsert;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type GatewayRequestLog = typeof gatewayRequestLogs.$inferSelect;
export type NewGatewayRequestLog = typeof gatewayRequestLogs.$inferInsert;
export type GatewayApiKey = typeof gatewayApiKeys.$inferSelect;
export type NewGatewayApiKey = typeof gatewayApiKeys.$inferInsert;
export type GatewayBudget = typeof gatewayBudgets.$inferSelect;
export type NewGatewayBudget = typeof gatewayBudgets.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectGitConnection = typeof projectGitConnections.$inferSelect;
export type NewProjectGitConnection = typeof projectGitConnections.$inferInsert;
export type ProjectGitCredential = typeof projectGitCredentials.$inferSelect;
export type NewProjectGitCredential = typeof projectGitCredentials.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
export type ProjectSecret = typeof projectSecrets.$inferSelect;
export type NewProjectSecret = typeof projectSecrets.$inferInsert;
export type ProjectSession = typeof projectSessions.$inferSelect;
export type NewProjectSession = typeof projectSessions.$inferInsert;
export type ProjectSnapshotBuild = typeof projectSnapshotBuilds.$inferSelect;
export type NewProjectSnapshotBuild = typeof projectSnapshotBuilds.$inferInsert;
export type SandboxTemplate = typeof sandboxTemplates.$inferSelect;
export type NewSandboxTemplate = typeof sandboxTemplates.$inferInsert;
export type SessionSandbox = typeof sessionSandboxes.$inferSelect;
export type NewSessionSandbox = typeof sessionSandboxes.$inferInsert;
export type LegacySandboxMigration = typeof legacySandboxMigrations.$inferSelect;
export type NewLegacySandboxMigration = typeof legacySandboxMigrations.$inferInsert;
export type Sandbox = typeof sandboxes.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type CreditAccount = typeof creditAccounts.$inferSelect;
export type KortixApiKey = typeof kortixApiKeys.$inferSelect;

// Insert types (what you pass to inserts)
export type NewSandbox = typeof sandboxes.$inferInsert;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type NewKortixApiKey = typeof kortixApiKeys.$inferInsert;
export type ChatChannelBinding = typeof chatChannelBindings.$inferSelect;
export type NewChatChannelBinding = typeof chatChannelBindings.$inferInsert;
export type ChatInstall = typeof chatInstalls.$inferSelect;
export type NewChatInstall = typeof chatInstalls.$inferInsert;
export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;

// Tunnel
export type TunnelConnection = typeof tunnelConnections.$inferSelect;
export type NewTunnelConnection = typeof tunnelConnections.$inferInsert;
export type TunnelPermission = typeof tunnelPermissions.$inferSelect;
export type NewTunnelPermission = typeof tunnelPermissions.$inferInsert;
export type TunnelPermissionRequest = typeof tunnelPermissionRequests.$inferSelect;
export type NewTunnelPermissionRequest = typeof tunnelPermissionRequests.$inferInsert;
export type TunnelAuditLog = typeof tunnelAuditLogs.$inferSelect;
export type NewTunnelAuditLog = typeof tunnelAuditLogs.$inferInsert;

// OpenOPC automation control
export type AutomationJob = typeof automationJobs.$inferSelect;
export type NewAutomationJob = typeof automationJobs.$inferInsert;
export type AutomationJobStep = typeof automationJobSteps.$inferSelect;
export type NewAutomationJobStep = typeof automationJobSteps.$inferInsert;
export type AutomationJobEvent = typeof automationJobEvents.$inferSelect;
export type NewAutomationJobEvent = typeof automationJobEvents.$inferInsert;
export type AutomationApproval = typeof automationApprovals.$inferSelect;
export type NewAutomationApproval = typeof automationApprovals.$inferInsert;
export type AutomationPolicy = typeof automationPolicies.$inferSelect;
export type NewAutomationPolicy = typeof automationPolicies.$inferInsert;
export type AutomationBrowserProfile = typeof automationBrowserProfiles.$inferSelect;
export type NewAutomationBrowserProfile = typeof automationBrowserProfiles.$inferInsert;
export type AutomationKillSwitch = typeof automationKillSwitches.$inferSelect;
export type NewAutomationKillSwitch = typeof automationKillSwitches.$inferInsert;

// OpenOPC Developer Center
export type DeveloperInvitation = typeof developerInvitations.$inferSelect;
export type NewDeveloperInvitation = typeof developerInvitations.$inferInsert;
export type DeveloperOrganization = typeof developerOrganizations.$inferSelect;
export type NewDeveloperOrganization = typeof developerOrganizations.$inferInsert;
export type DeveloperPublisher = typeof developerPublishers.$inferSelect;
export type NewDeveloperPublisher = typeof developerPublishers.$inferInsert;
export type DeveloperPublisherMember = typeof developerPublisherMembers.$inferSelect;
export type NewDeveloperPublisherMember = typeof developerPublisherMembers.$inferInsert;
export type DeveloperPublisherAuditEvent = typeof developerPublisherAuditEvents.$inferSelect;
export type NewDeveloperPublisherAuditEvent = typeof developerPublisherAuditEvents.$inferInsert;
export type DeveloperPublisherRole = (typeof developerPublisherRoleEnum.enumValues)[number];
export type DeveloperModuleArtifactUpload = typeof developerModuleArtifactUploads.$inferSelect;
export type NewDeveloperModuleArtifactUpload = typeof developerModuleArtifactUploads.$inferInsert;
export type DeveloperModuleArtifact = typeof developerModuleArtifacts.$inferSelect;
export type NewDeveloperModuleArtifact = typeof developerModuleArtifacts.$inferInsert;
export type DeveloperModuleRelease = typeof developerModuleReleases.$inferSelect;
export type NewDeveloperModuleRelease = typeof developerModuleReleases.$inferInsert;
export type DeveloperModuleVerificationRun = typeof developerModuleVerificationRuns.$inferSelect;
export type NewDeveloperModuleVerificationRun = typeof developerModuleVerificationRuns.$inferInsert;
export type DeveloperModuleVerificationFinding =
  typeof developerModuleVerificationFindings.$inferSelect;
export type NewDeveloperModuleVerificationFinding =
  typeof developerModuleVerificationFindings.$inferInsert;
export type DeveloperModuleTrustAttestation = typeof developerModuleTrustAttestations.$inferSelect;
export type NewDeveloperModuleTrustAttestation =
  typeof developerModuleTrustAttestations.$inferInsert;
export type DeveloperModuleVerificationCapability =
  typeof developerModuleVerificationCapabilities.$inferSelect;
export type NewDeveloperModuleVerificationCapability =
  typeof developerModuleVerificationCapabilities.$inferInsert;
export type DeveloperModuleReleaseReviewEvent =
  typeof developerModuleReleaseReviewEvents.$inferSelect;
export type NewDeveloperModuleReleaseReviewEvent =
  typeof developerModuleReleaseReviewEvents.$inferInsert;
export type DeveloperModuleReleaseDistributionEvent =
  typeof developerModuleReleaseDistributionEvents.$inferSelect;
export type NewDeveloperModuleReleaseDistributionEvent =
  typeof developerModuleReleaseDistributionEvents.$inferInsert;
export type ProjectModuleInstallation = typeof projectModuleInstallations.$inferSelect;
export type NewProjectModuleInstallation = typeof projectModuleInstallations.$inferInsert;
export type ProjectModuleInstallationEvent = typeof projectModuleInstallationEvents.$inferSelect;
export type NewProjectModuleInstallationEvent = typeof projectModuleInstallationEvents.$inferInsert;

// Aliases
export type SandboxSelect = Sandbox;
