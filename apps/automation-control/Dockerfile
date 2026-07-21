FROM oven/bun:1.3.14 AS install

WORKDIR /workspace

# Build a deliberately small workspace so upstream applications are not copied
# into the control-service image or coupled to its dependency graph.
COPY apps/automation-control/package.json apps/automation-control/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/intelligence-contracts/package.json packages/intelligence-contracts/package.json
RUN bun -e 'await Bun.write("package.json", JSON.stringify({name:"automation-control-image",private:true,workspaces:["apps/automation-control","packages/db","packages/intelligence-contracts"]}))'
RUN bun install --production

FROM oven/bun:1.3.14 AS runtime

WORKDIR /workspace
ENV NODE_ENV=production \
    AUTOMATION_CONTROL_ENABLED=false \
    AUTOMATION_CONTROL_PORT=4011

COPY --from=install --chown=bun:bun /workspace/package.json /workspace/package.json
COPY --from=install --chown=bun:bun /workspace/node_modules /workspace/node_modules
COPY --chown=bun:bun apps/automation-control /workspace/apps/automation-control
COPY --chown=bun:bun packages/db /workspace/packages/db
COPY --chown=bun:bun packages/intelligence-contracts /workspace/packages/intelligence-contracts
COPY --from=install --chown=bun:bun /workspace/apps/automation-control/node_modules /workspace/apps/automation-control/node_modules
COPY --from=install --chown=bun:bun /workspace/packages/db/node_modules /workspace/packages/db/node_modules
COPY --from=install --chown=bun:bun /workspace/packages/intelligence-contracts/node_modules /workspace/packages/intelligence-contracts/node_modules

USER bun
EXPOSE 4011

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const port=process.env.AUTOMATION_CONTROL_PORT||'4011';const response=await fetch(`http://127.0.0.1:${port}/health`);if(!response.ok)process.exit(1)"]

CMD ["bun", "run", "apps/automation-control/src/main.ts"]
