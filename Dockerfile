FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/gala.db

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/THIRD_PARTY_NOTICES.md ./

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["npm", "start"]
