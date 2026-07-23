import { startAutomationControlProductionRuntime } from './production-runtime';

const runtime = await startAutomationControlProductionRuntime({
  dependencies: {
    observe: (event) => console.info(JSON.stringify(event)),
  },
});
const shutdown = () => void runtime.close();

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
