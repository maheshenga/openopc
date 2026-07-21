// Keep explicit `.js` suffixes so the emitted ESM files are importable from an
// installed tarball under Node's strict ESM resolver. TypeScript's bundler
// resolution maps these specifiers back to the `.ts` sources in the workspace.
export * from './compatibility.js';
export * from './ag-ui.js';
export * from './automation.js';
export * from './capability-catalog.js';
export * from './schemas.js';
