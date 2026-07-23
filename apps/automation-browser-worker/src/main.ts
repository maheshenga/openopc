import { startBrowserWorkerProductionRuntime } from './production-runtime';

const runtime = await startBrowserWorkerProductionRuntime();
const shutdown = () => void runtime.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
