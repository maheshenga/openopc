export const SLACK_HOME_COPY = {
  examples: [
    { emoji: '🔍', prompt: '@OpenOPC scan this codebase and write me a one-pager' },
    { emoji: '🔧', prompt: '@OpenOPC open a PR that switches our logger to pino' },
    { emoji: '📊', prompt: '@OpenOPC what changed on main this week?' },
    { emoji: '📦', prompt: "@OpenOPC pull yesterday's sign-ups, group them by source, drop the CSV here" },
  ],
  heroAlt: 'OpenOPC — AI command center for your company',
  welcome: '👋  Welcome to OpenOPC',
  noProjects: '*No projects connected yet.*\nHead to your OpenOPC dashboard to link a project to this workspace.',
  managedBy: 'OpenOPC',
} as const;
