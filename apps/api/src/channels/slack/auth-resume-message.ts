export function buildSlackAuthPromptConnectedResponse(
  opts?: { hasAccess?: boolean },
): Record<string, unknown> {
  const hasAccess = opts?.hasAccess !== false;
  const text = hasAccess
    ? '*Slack connected.*\nOpenOPC is picking up your message now.'
    : '*Slack connected.*\nYour OpenOPC account still needs access to this project. Head back to Slack and request access to continue.';
  return {
    response_type: 'ephemeral',
    replace_original: true,
    text: hasAccess
      ? 'Slack connected. OpenOPC is picking up your message now.'
      : 'Slack connected. Request project access in Slack to continue.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text,
        },
      },
    ],
  };
}
