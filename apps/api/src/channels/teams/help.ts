import { buildHelpCard } from './cards';

export function buildTeamsHelpCard(): Record<string, unknown> {
  return buildHelpCard([
    { cmd: '/login', desc: 'connect your OpenOPC account' },
    { cmd: '/logout', desc: 'disconnect your account' },
    { cmd: '/whoami', desc: 'show who you are linked as' },
    { cmd: '/status', desc: 'show the effective project, agent and model' },
    { cmd: '/models', desc: 'pick the model for this conversation' },
    { cmd: '/agents', desc: 'pick the agent for this conversation' },
    { cmd: '/projects', desc: 'list connected projects' },
    { cmd: '/use <name>', desc: 'point this conversation at another project' },
  ]);
}
