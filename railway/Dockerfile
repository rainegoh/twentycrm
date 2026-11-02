# Railway builds the last stage, so this is packages/twenty-docker/twenty/Dockerfile cut off after the
# `twenty` (server + frontend) stage. Regenerate it after pulling upstream changes to that file:
#   sed -n '1,195p' packages/twenty-docker/twenty/Dockerfile >> railway/Dockerfile

# ===========================================================================
# Base image
# ===========================================================================

FROM node:26.12.1-alpine3.23@sha256:bc2b334006f15c7167bbeb2f08f28c2df883f7594a0470e04454ebe7560cfe68 AS node-base

# Node 26 images no longer bundle Yarn; run the release pinned in .yarnrc.yml.
RUN printf '%s\n' '#!/bin/sh' 'exec node "/app/$(sed -n "s/^yarnPath: //p" /app/.yarnrc.yml)" "$@"' \
      > /usr/local/bin/yarn && \
    chmod +x /usr/local/bin/yarn

# ===========================================================================
# Dependency stages
# ===========================================================================

FROM node-base AS front-deps

WORKDIR /app

COPY ./package.json ./yarn.lock ./.yarnrc.yml ./tsconfig.base.json ./nx.json /app/
COPY ./.yarn/releases /app/.yarn/releases
COPY ./.yarn/patches /app/.yarn/patches

COPY ./packages/twenty-ui/package.json /app/packages/twenty-ui/
COPY ./packages/twenty-shared/package.json /app/packages/twenty-shared/
COPY ./packages/twenty-front/package.json /app/packages/twenty-front/
COPY ./packages/twenty-front-component-renderer/package.json /app/packages/twenty-front-component-renderer/
COPY ./packages/twenty-sdk/package.json /app/packages/twenty-sdk/
COPY ./packages/twenty-client-sdk/package.json /app/packages/twenty-client-sdk/

RUN yarn workspaces focus twenty-monorepo twenty-front twenty-front-component-renderer twenty-ui twenty-shared twenty-sdk twenty-client-sdk && yarn cache clean && npx nx reset


FROM node-base AS server-deps

WORKDIR /app

COPY ./package.json ./yarn.lock ./.yarnrc.yml ./tsconfig.base.json ./nx.json /app/
COPY ./.yarn/releases /app/.yarn/releases
COPY ./.yarn/patches /app/.yarn/patches

COPY ./packages/twenty-emails/package.json /app/packages/twenty-emails/
COPY ./packages/twenty-server/package.json /app/packages/twenty-server/
COPY ./packages/twenty-server/patches /app/packages/twenty-server/patches
COPY ./packages/twenty-shared/package.json /app/packages/twenty-shared/
COPY ./packages/twenty-client-sdk/package.json /app/packages/twenty-client-sdk/
COPY ./packages/twenty-oxlint-rules/package.json /app/packages/twenty-oxlint-rules/

RUN yarn workspaces focus twenty-monorepo twenty-server twenty-emails twenty-shared twenty-client-sdk && yarn cache clean && npx nx reset


FROM server-deps AS twenty-server-build

COPY ./packages/twenty-emails /app/packages/twenty-emails
COPY ./packages/twenty-shared /app/packages/twenty-shared
COPY ./packages/twenty-client-sdk /app/packages/twenty-client-sdk
COPY ./packages/twenty-server /app/packages/twenty-server

RUN npx nx run twenty-server:lingui:extract && \
    npx nx run twenty-server:lingui:compile && \
    npx nx run twenty-emails:lingui:extract && \
    npx nx run twenty-emails:lingui:compile

RUN npx nx run twenty-server:build

# Clean server build output (type declarations and compiled tests are not needed at runtime;
# source maps are kept because twenty-infra extracts them from the image for Sentry uploads)
RUN find /app/packages/twenty-server/dist -name '*.d.ts' -delete \
 && rm -rf /app/packages/twenty-server/dist/packages/twenty-server/test

RUN yarn workspaces focus --production twenty-emails twenty-shared twenty-client-sdk twenty-server


FROM front-deps AS twenty-front-build

COPY ./packages/twenty-front /app/packages/twenty-front
COPY ./packages/twenty-front-component-renderer /app/packages/twenty-front-component-renderer
COPY ./packages/twenty-ui /app/packages/twenty-ui
COPY ./packages/twenty-shared /app/packages/twenty-shared
COPY ./packages/twenty-sdk /app/packages/twenty-sdk
COPY ./packages/twenty-client-sdk /app/packages/twenty-client-sdk
RUN npx nx run twenty-front:lingui:extract && \
    npx nx run twenty-front:lingui:compile
# To skip the memory-intensive frontend build, pre-build on the host:
#   npx nx build twenty-front
# The check below will use packages/twenty-front/build/ if it already exists.
RUN if [ -d /app/packages/twenty-front/build ]; then \
      echo "Using pre-built frontend from host"; \
    else \
      NODE_OPTIONS="--max-old-space-size=8192" npx nx build twenty-front; \
    fi


# ===========================================================================
# Target: twenty-server (server only, no frontend)
#   docker build --target twenty-server -f packages/twenty-docker/twenty/Dockerfile .
# ===========================================================================

FROM node-base AS twenty-server

# Force the patched Alpine OpenSSL libs to the fixed release (3.5.8-r0 clears
# CVE-2026-14456/14457/18798/54874/63072/63075/63076). Node bundles its own
# OpenSSL, but psql/curl link these system libs, so the upgrade hardens
# runtime TLS and clears the scanner. libexpat 2.8.5-r0 clears CVE-2026-93990.
RUN apk add --no-cache \
    'curl>=8.22.0-r0' \
    'libexpat>=2.8.5-r0' \
    'nghttp2-libs>=1.69.0-r0' \
    'libcrypto3>=3.5.8-r0' \
    'libssl3>=3.5.8-r0' \
    'postgresql18-client>=18.5-r0' \
    'jq>=1.8.2-r0'

COPY ./packages/twenty-docker/twenty/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
WORKDIR /app/packages/twenty-server

ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production

# Workspace root config
COPY --chown=1000 --from=twenty-server-build /app/package.json /app/yarn.lock /app/.yarnrc.yml /app/
COPY --chown=1000 --from=twenty-server-build /app/tsconfig.base.json /app/nx.json /app/
COPY --chown=1000 --from=twenty-server-build /app/.yarn /app/.yarn
COPY --chown=1000 --from=twenty-server-build /app/node_modules /app/node_modules

# Server package (compiled dist + package.json only, no src/)
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-server/package.json /app/packages/twenty-server/
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-server/dist /app/packages/twenty-server/dist
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-server/patches /app/packages/twenty-server/patches
# Shell entrypoints referenced by package.json scripts (command:prod:background*)
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-server/scripts /app/packages/twenty-server/scripts
# COPY preserves the committed mode, but the scripts are also invoked directly
# and not only through yarn, so do not let a dropped exec bit reach the pod
RUN chmod +x /app/packages/twenty-server/scripts/command-background.sh

# Workspace packages (dist + package.json; node_modules symlinks resolve to these)
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-shared/package.json /app/packages/twenty-shared/
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-shared/dist /app/packages/twenty-shared/dist
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-emails/package.json /app/packages/twenty-emails/
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-emails/dist /app/packages/twenty-emails/dist
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-client-sdk/package.json /app/packages/twenty-client-sdk/
COPY --chown=1000 --from=twenty-server-build /app/packages/twenty-client-sdk/dist /app/packages/twenty-client-sdk/dist

LABEL org.opencontainers.image.source=https://github.com/twentyhq/twenty
LABEL org.opencontainers.image.description="Twenty server image (no frontend)."

# Remove unused, unpatchable components the scanner flags (none are executed at
# runtime, and none can be fixed by upgrading our deps or Node):
#  - the bundled npm CLI: the app uses yarn (see node-base) and never invokes npm,
#    and npm's bundled ip-address has no patched release;
#  - example/ apps vendored inside dependencies, e.g. passport-microsoft's
#    example/login ships a package-lock.json for an old Express demo
#    (body-parser, ejs, express, ...) that is never installed or run.
#  - the Node dev headers: only node-gyp needs them and native addons are
#    compiled in the build stages; their vendored openssl/opensslv.h is what
#    scanners fingerprint whenever OpenSSL patches ahead of Node releases.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/include/node && \
    find /app/node_modules -type d -name example -prune -exec rm -rf {} +

RUN mkdir -p /app/.local-storage /app/packages/twenty-server/.local-storage && \
    chown 1000:1000 /app/.local-storage /app/packages/twenty-server/.local-storage

USER 1000

CMD ["node", "dist/main"]
ENTRYPOINT ["/app/entrypoint.sh"]


# ===========================================================================
# Target: twenty-server-aws (server only + aws-cli, no frontend)
#   docker build --target twenty-server-aws -f packages/twenty-docker/twenty/Dockerfile .
# ===========================================================================

FROM twenty-server AS twenty-server-aws

USER root
RUN apk add --no-cache aws-cli
USER 1000


# ===========================================================================
# Target: twenty (server + frontend)
#   docker build --target twenty -f packages/twenty-docker/twenty/Dockerfile .
# ===========================================================================

FROM twenty-server AS twenty

COPY --chown=1000 --from=twenty-front-build /app/packages/twenty-front/build /app/packages/twenty-server/dist/front

LABEL org.opencontainers.image.description="Twenty image with backend and frontend."


