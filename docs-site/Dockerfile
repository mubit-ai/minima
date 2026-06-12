# syntax=docker/dockerfile:1
# ── builder ───────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline

# Copy the rest and build.
COPY . .
RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Replace default nginx config with ours.
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN rm /etc/nginx/conf.d/default.conf.bak 2>/dev/null; \
    # Remove the default catch-all config so ours is the only one.
    rm -f /etc/nginx/sites-enabled/default

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

# Run nginx in the foreground. Cloud Run needs the process to stay in the
# foreground; nginx -g "daemon off;" does that.
CMD ["nginx", "-g", "daemon off;"]
