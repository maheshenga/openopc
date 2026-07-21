const DESKTOP_METHOD_FEATURES: Record<string, string> = {
  'desktop.cua.ensure': 'computer_use',
  'desktop.cua.start_daemon': 'computer_use',
  'desktop.cua.status': 'computer_use',
  'desktop.cua.version': 'computer_use',
  'desktop.cua.list_tools': 'computer_use',
  'desktop.cua.describe': 'computer_use',
  'desktop.cua.bring_to_front': 'windows',
  'desktop.cua.check_for_update': 'computer_use',
  'desktop.cua.check_permissions': 'computer_use',
  'desktop.cua.click': 'mouse',
  'desktop.cua.double_click': 'mouse',
  'desktop.cua.drag': 'mouse',
  'desktop.cua.end_session': 'computer_use',
  'desktop.cua.get_accessibility_tree': 'accessibility',
  'desktop.cua.get_agent_cursor_state': 'mouse',
  'desktop.cua.get_config': 'computer_use',
  'desktop.cua.get_cursor_position': 'mouse',
  'desktop.cua.get_recording_state': 'computer_use',
  'desktop.cua.get_screen_size': 'screenshot',
  'desktop.cua.get_window_state': 'accessibility',
  'desktop.cua.hotkey': 'keyboard',
  'desktop.cua.kill_app': 'apps',
  'desktop.cua.launch_app': 'apps',
  'desktop.cua.list_apps': 'apps',
  'desktop.cua.list_windows': 'windows',
  'desktop.cua.move_cursor': 'mouse',
  'desktop.cua.page': 'accessibility',
  'desktop.cua.press_key': 'keyboard',
  'desktop.cua.replay_trajectory': 'computer_use',
  'desktop.cua.right_click': 'mouse',
  'desktop.cua.scroll': 'keyboard',
  'desktop.cua.set_agent_cursor_enabled': 'mouse',
  'desktop.cua.set_agent_cursor_motion': 'mouse',
  'desktop.cua.set_agent_cursor_style': 'mouse',
  'desktop.cua.set_config': 'computer_use',
  'desktop.cua.set_value': 'accessibility',
  'desktop.cua.start_recording': 'screenshot',
  'desktop.cua.install_ffmpeg': 'computer_use',
  'desktop.cua.start_session': 'computer_use',
  'desktop.cua.stop_recording': 'screenshot',
  'desktop.cua.type_text': 'keyboard',
  'desktop.cua.zoom': 'screenshot',
};

const AUTOMATION_CONTAINERS = ['automation', 'lease'] as const;

function recordValue(
  record: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): unknown {
  if (record[camelCase] !== undefined) return record[camelCase];
  if (record[snakeCase] !== undefined) return record[snakeCase];

  for (const containerName of AUTOMATION_CONTAINERS) {
    const container = record[containerName];
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      const nested = container as Record<string, unknown>;
      if (nested[camelCase] !== undefined) return nested[camelCase];
      if (nested[snakeCase] !== undefined) return nested[snakeCase];
    }
  }

  return undefined;
}

function assertMatchingFence(
  name: string,
  expected: unknown,
  actual: unknown,
  validate: (value: unknown) => boolean,
): void {
  if (expected === undefined && actual === undefined) return;
  if (!validate(expected) || !validate(actual) || String(expected) !== String(actual)) {
    throw new Error(`Permission denied: ${name} does not match`);
  }
}

function desktopFeatureForMethod(
  method: string,
  params: Record<string, unknown>,
): string | undefined {
  if (method === 'desktop.cua.call') {
    const tool = params.tool;
    if (typeof tool !== 'string' || tool.length === 0) return undefined;
    const toolMethod = tool.startsWith('desktop.cua.') ? tool : `desktop.cua.${tool}`;
    return DESKTOP_METHOD_FEATURES[toolMethod];
  }
  return DESKTOP_METHOD_FEATURES[method];
}

export function capabilityForMethod(method: unknown): string | null {
  if (typeof method !== 'string') return null;
  const prefix = method.split('.', 1)[0];
  if (prefix === 'fs') return 'filesystem';
  if (prefix === 'shell') return 'shell';
  if (prefix === 'desktop') return 'desktop';
  return null;
}

export function assertAutomationActionPolicy(input: {
  scope: Record<string, unknown>;
  policyVersion?: string;
  method: string;
  params: Record<string, unknown>;
}): void {
  const { scope, method, params } = input;

  if (capabilityForMethod(method) === 'desktop') {
    const features = scope.features;
    if (
      features !== undefined &&
      (!Array.isArray(features) || features.some((value) => typeof value !== 'string'))
    ) {
      throw new Error('Permission denied: invalid desktop feature scope');
    }
    if (Array.isArray(features) && features.length > 0) {
      const feature = desktopFeatureForMethod(method, params);
      if (!feature) {
        throw new Error(`Permission denied: unknown desktop method ${method}`);
      }
      if (!features.includes(feature)) {
        throw new Error(`Permission denied: feature ${feature} is outside the permission scope`);
      }
    }
  }

  const expectedPolicyVersion =
    input.policyVersion ?? recordValue(scope, 'policyVersion', 'policy_version');
  const actualPolicyVersion = recordValue(params, 'policyVersion', 'policy_version');
  assertMatchingFence(
    'policy version',
    expectedPolicyVersion,
    actualPolicyVersion,
    (value) => typeof value === 'string' && value.length > 0,
  );

  assertMatchingFence(
    'action hash',
    recordValue(scope, 'actionHash', 'action_hash'),
    recordValue(params, 'actionHash', 'action_hash'),
    (value) => typeof value === 'string' && value.length > 0,
  );

  assertMatchingFence(
    'kill-switch generation',
    recordValue(scope, 'killSwitchGeneration', 'kill_switch_generation'),
    recordValue(params, 'killSwitchGeneration', 'kill_switch_generation'),
    (value) =>
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === 'string' && /^\d+$/.test(value)),
  );
}
