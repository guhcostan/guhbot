FROM node:26-bookworm-slim
RUN npm install --global pnpm@11.9.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/cloud/ ./apps/cloud/
COPY website/ ./website/
RUN pnpm install --frozen-lockfile --filter guhbot --filter @guhbot/server... --filter @guhbot/cloud...
RUN pnpm build
RUN pnpm --filter @guhbot/cloud build
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787 8788 4173
ENTRYPOINT ["node"]
CMD ["packages/server/dist/cli.js", "--data-dir", "/data", "--companion", "--companion-port", "8787", "--companion-insecure-plaintext"]
