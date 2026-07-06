# syntax=docker/dockerfile:1
# genai-ai-api-onpre — Express backend
# Node.js v24.15.0 LTS (Krypton)
# digest pinning（digest＋#version コメント方針、digest 2026-05-25 一次取得）。

# node:24.15.0-alpine
FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# Prisma クライアント生成（src/generated へ ESM 出力）。接続はせず datamodel から生成するのみだが、
# prisma.config.ts が DATABASE_URL を要求するためビルド時専用のダミーを与える（migrate は実 URL）。
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" npx prisma generate
RUN npm run build

# ---- migrate ステージ（Prisma migration 自動適用用） --------------------------------
# deploy compose の migrate init サービスが build target=migrate で使用する。build ステージ
# （prisma CLI＝devDep＋prisma/schema＋migrations を内包）を流用するため追加ビルドコストはほぼ無し。
# ランタイム image（dist＋prod node_modules のみ）からは migrate を打てないことへの恒久対処。
# DATABASE_URL は migrate サービスが実 URL を供給（migrate は厳格 Rust パーサ＝パスワード特殊文字は
# URL エンコード必須・P1013 回避）。root のまま（migrate 一回限り・runtime は USER node で起動）。
# NOTE: runtime を最終ステージに保つため migrate は build と runtime の「間」に置く
#       （compose api は target 未指定＝最終ステージをビルドするため）。
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# node:24.15.0-alpine
FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
# 3000=HTTP（単体・後方互換）/ 3443=HTTPS（内部 TLS、deploy compose）
EXPOSE 3000 3443
CMD ["node", "dist/index.js"]
