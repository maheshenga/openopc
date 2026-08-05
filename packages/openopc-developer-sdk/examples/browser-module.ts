import { createOpenOpcBrowserModuleClient } from '@openopc/developer-sdk';

export async function listApprovedModels(signal?: AbortSignal) {
  const openopc = await createOpenOpcBrowserModuleClient({ signal });
  return (await openopc.ai.models.list({ signal })).data;
}
