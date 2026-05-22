# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Use pnpm (the project's package manager). corepack ships with Node and
# resolves the pnpm version from package.json's packageManager field.
RUN corepack enable

# Install production dependencies separately to maximise layer reuse.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# Copy server code and the static client assets that the server serves.
COPY server ./server
COPY engine.js wall.html demo.html ./
# Preview/icon assets served from the root (see server/static.js allowlist).
COPY og-image.png favicon.svg favicon-32.png apple-touch-icon.png ./
COPY prototype ./prototype

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
