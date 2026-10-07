# syntax=docker/dockerfile:1
#
# omp-web + the oh-my-pi (omp) coding agent, built from THIS repository's source.
#
# Modelled on hcdbp24c3/ompweb-docker, with one deliberate difference: that image
# installs the published `@kahme247/ompweb` npm package, so it always ships
# upstream's code. This one builds the checked-out tree, so the image matches the
# commit it was built from.
#
# Two stages: `builder` compiles with the full dev dependency tree, `runtime`
# installs production dependencies only and keeps the compiled `.next`.
#
# The runtime keeps a real `omp` on PATH. omp-web never bundles omp (it is
# Bun-only as an SDK), and every live-agent feature — sessions, providers,
# model config — goes through that binary. Session browsing degrades without it;
# nothing else does.

# --- Stage 1: build ----------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# `lib/omp/agents-service.ts` unpacks bundled archives and `bin/` reads version
# metadata at build time, so git and ca-certificates are build-time requirements,
# not runtime ones. build-essential and python3 are node-gyp's toolchain: `node-pty`
# is a native module (libuv) and its published tarball carries prebuilds for darwin
# and win32 only — nothing for linux — so `npm ci` below compiles it from source on
# whichever architecture this image is built for. Hence build-only here, absent from
# the runtime stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first: this layer only rebuilds when the lockfile changes, so the
# ~3min `next build` below stays cached across source-only edits.
COPY package.json package-lock.json ./
RUN npm ci

# node-pty must be compiled against this image's own Node headers and architecture,
# which `npm ci` above already did on linux (there is no linux prebuild to fall back
# on). Build it again explicitly so the `.node` that ships can never come from a
# bundled prebuild meant for a different platform, on any architecture. This must
# stay in the builder stage: it runs after the full install but before
# `npm prune --omit=dev`, so the compiled module is what gets pruned to.
RUN npm rebuild node-pty --build-from-source

# `next.config.ts` reads package.json, and the webpack config reads `components/`
# paths for trace-ignore patterns, so the full source tree has to be present.
COPY . .
RUN npm run build

# Prune to production dependencies for the runtime stage. Done here (not with a
# second `npm ci --omit=dev`) so the runtime layer needs no registry access.
RUN npm prune --omit=dev

# --- Stage 2: runtime --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# git: omp shells out to git for worktrees and branch state.
# ca-certificates + curl: omp's installer, and the HTTPS model endpoints.
# python3: omp's python execution tool.
# gh: the GitHub CLI, from cli.github.com's own apt repository so it tracks
#   upstream rather than Debian's older snapshot. It is here ONLY so that `gh`
#   commands an agent chooses to run can authenticate — omp-web itself never
#   invokes gh. lib/github-repo.ts emulates gh's remote-priority logic in pure
#   Node instead, and every git operation goes through git. The token reaches it
#   the same way every other credential does: resolved per repository by
#   lib/gh-env.ts and handed to the child that asked for it.
#
# The repository is signed, so its archive keyring is fetched first and the
# sources line names it. An unsigned or keyring-less apt source is how a supply
# chain gets into an image that also holds credential material.
#
# There is deliberately NO git-credential helper script here. A stored git
# credential (Settings → Extensions & Tools → Git Credentials) reaches git as
# `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` carrying
# `http.<host>.extraheader`, which is environment only — no helper binary, no
# extra file to bake in, and nothing added to the remote URL. See
# lib/git-credential-resolve.ts; the store it reads lives under /root/.omp.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        python3 \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Pin with --ref v<version> for a reproducible omp; default tracks omp's latest.
# The installer writes to $HOME/.local/bin, which the node image does not put on
# PATH, so add it first — otherwise the `omp --version` check below and any child
# process that shells out to `omp` fail. (omp-web's own resolveOmpBin() probes
# ~/.local/bin regardless, which is why the app would still start without this.)
ENV PATH="/root/.local/bin:${PATH}"
ARG OMP_VERSION=latest
# omp-install-cache-bust
#
# `curl | sh` with a fixed instruction is a CACHEABLE layer: Docker (and the GHA
# cache the workflow imports) reuses it forever, so an `OMP_VERSION=latest`
# image kept shipping whatever omp happened to be installed the first time this
# line was ever built. The label above is what `no-cache-filter` matches on, so
# ONLY this RUN re-executes on every build and every other layer stays cached.
# Nothing else in the file may contain this string.
RUN if [ "${OMP_VERSION}" != "latest" ]; then \
        curl -fsSL https://omp.sh/install | sh -s -- --binary --ref "v${OMP_VERSION}"; \
    else \
        curl -fsSL https://omp.sh/install | sh; \
    fi \
    && omp --version

WORKDIR /app

# Exactly the `files` list from package.json — the same set the published npm
# package carries — plus production node_modules. `bin/omp-web.js` resolves
# `next/dist/bin/next` out of node_modules and spawns it, so the full production
# tree is required; Next's `output: "standalone"` cannot be used here without
# changing next.config.ts, which would also change the published package.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts

# omp reads agent state, sessions, credentials and models.yml from /root/.omp.
#
# There is deliberately NO `VOLUME ["/root/.omp"]` here any more. A declared
# VOLUME turns the path into an anonymous volume mount, and that silently
# breaks the common deployment: mounting a volume at /root (to keep cloned
# repositories) leaves /root/.omp as a *separate* anonymous volume sitting on
# top of the real one. Every `docker rm` + run — which is what an `omp update`
# does — allocates a fresh EMPTY anonymous volume and masks the host's
# /root/.omp. The repositories under /root survive; every session, credential
# and models.yml silently disappears, with no error anywhere.
#
# Mount the path yourself and make it explicit:
#   volumes: ["./omp-data:/root/.omp"]      # or a named volume
# Unmounted, state lives in the container layer and is lost on recreate — which
# is now visible rather than implied.

ENV NODE_ENV=production \
    OMP_WEB_HOSTNAME=0.0.0.0 \
    OMP_WEB_NO_OPEN=1
EXPOSE 30177

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD curl -fsS http://localhost:30177/ >/dev/null 2>&1 || exit 1

# `--no-open` matters in a container: there is no browser to open, and the
# reference image sets the same flag.
CMD ["node", "bin/omp-web.js", "--hostname", "0.0.0.0", "--no-open"]