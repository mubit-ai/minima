# syntax=docker/dockerfile:1
# ── builder ───────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Vocs shells out to `git` during the build (last-updated timestamps).
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline --no-audit --no-fund

# Copy the rest and build.
COPY . .

# PostHog (public project key) — injected at build time so Vite can bake it into
# the static bundle. Empty defaults mean a plain `docker build` still works; it
# just ships without analytics (vocs.config.ts guards on the key).
ARG VITE_PUBLIC_POSTHOG_KEY=""
ARG VITE_PUBLIC_POSTHOG_HOST="https://eu.i.posthog.com"
ENV VITE_PUBLIC_POSTHOG_KEY=$VITE_PUBLIC_POSTHOG_KEY
ENV VITE_PUBLIC_POSTHOG_HOST=$VITE_PUBLIC_POSTHOG_HOST

RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Replace default nginx config with ours.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

# Cloud Run needs the process in the foreground; nginx -g "daemon off;" does that.
CMD ["nginx", "-g", "daemon off;"]
