FROM node:22-alpine
WORKDIR /app
# Headless Chromium for server-side PDF
RUN apk add --no-cache chromium && corepack enable
ENV CHROME_PATH=/usr/bin/chromium-browser
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec prisma generate && pnpm --filter @erp/shared build && pnpm --filter api build
EXPOSE 4000
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node apps/api/dist/main.js"]
