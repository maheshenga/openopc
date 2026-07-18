# `@kortix/intelligence-contracts`

Versioned, side-effect-free wire contracts for the Kortix Intelligence Fabric.
The package contains protocol constants, Zod schemas, and inferred TypeScript
types for capabilities, Agent Cards, task envelopes, and task events.

It does not contain provider clients, database code, credentials, or frontend
runtime code. The package is published in lockstep with the Kortix SDK so
installed SDK consumers resolve the same protocol revision as the API and CLI.
