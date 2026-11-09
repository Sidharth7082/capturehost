import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Suggest a Dockerfile for a repository that does not have one.
 *
 * This is deliberately a *lookup table over the repository's own manifest files*,
 * not a model call: the output is reviewable, repeatable and cannot be influenced
 * by text inside the repository. It reads nothing but file names and a handful of
 * manifests, and it always binds to the project's container port so a suggested
 * Dockerfile deploys without further edits.
 *
 * It is a starting point, not an oracle: `notes` says what it guessed and what to
 * change, and `confidence` says how much of the guess is observable in the repo.
 */

export interface Fingerprint {
  /** Relative paths, up to two levels deep, ignoring vendor/dependency directories. */
  files: string[];
  /** Contents of the manifests that were found, keyed by relative path (truncated). */
  manifests: Record<string, string>;
  containerPort: number;
  projectName: string;
}

export interface Suggestion {
  stack: string;
  dockerfile: string;
  notes: string[];
  confidence: 'high' | 'medium' | 'low';
}

const IGNORED = new Set([
  'node_modules', '.git', 'vendor', 'venv', '.venv', '__pycache__', 'dist', 'build',
  '.next', 'target', 'coverage', '.idea', '.vscode',
]);

const MANIFESTS = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Procfile',
  'go.mod', 'composer.json', 'Gemfile', 'Cargo.toml', 'Pipfile.lock',
  'next.config.js', 'next.config.mjs', 'next.config.ts', 'manage.py',
];

export function readFingerprint(root: string, options: { containerPort: number; projectName: string }): Fingerprint {
  const files: string[] = [];
  const manifests: Record<string, string> = {};

  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry) || entry.startsWith('.') && entry !== '.dockerignore') continue;
      const absolute = join(dir, entry);
      const relativePath = relative(root, absolute).split(sep).join('/');

      let isDirectory = false;
      try {
        isDirectory = statSync(absolute).isDirectory();
      } catch {
        continue;
      }

      files.push(isDirectory ? `${relativePath}/` : relativePath);

      if (isDirectory) {
        if (depth > 0) walk(absolute, depth - 1);
        continue;
      }

      if (MANIFESTS.includes(entry) || files.length < 400) {
        if (MANIFESTS.includes(entry)) {
          try {
            manifests[relativePath] = readFileSync(absolute, 'utf8').slice(0, 8_000);
          } catch {
            /* unreadable manifest is the same as a missing one */
          }
        }
      }
    }
  };

  walk(root, 1);
  return { files, manifests, containerPort: options.containerPort, projectName: options.projectName };
}

const has = (fingerprint: Fingerprint, suffix: string): boolean =>
  fingerprint.files.some((file) => file === suffix || file.endsWith(`/${suffix}`));

const manifest = (fingerprint: Fingerprint, name: string): string | null => {
  if (fingerprint.manifests[name] !== undefined) return fingerprint.manifests[name] as string;
  const key = Object.keys(fingerprint.manifests).find((path) => path.endsWith(`/${name}`));
  return key ? (fingerprint.manifests[key] as string) : null;
};

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A python module import path, from the file it lives in. */
function pythonModule(fingerprint: Fingerprint): { module: string; callable: string } {
  if (has(fingerprint, 'manage.py')) return { module: 'wsgi', callable: 'application' };
  if (has(fingerprint, 'wsgi.py')) return { module: 'wsgi', callable: 'application' };
  if (has(fingerprint, 'main.py')) return { module: 'main', callable: 'app' };
  if (has(fingerprint, 'server.py')) return { module: 'server', callable: 'app' };
  if (has(fingerprint, 'app.py')) return { module: 'app', callable: 'app' };
  return { module: 'app', callable: 'app' };
}

/** Which module Django needs, from `DJANGO_SETTINGS_MODULE` or a project directory. */
function djangoModule(fingerprint: Fingerprint): string {
  const settings = fingerprint.files.find((file) => file.endsWith('/settings.py') || file === 'settings.py');
  if (!settings) return 'wsgi';
  const directory = settings.replace(/\/?settings\.py$/, '');
  return directory === '' ? 'wsgi' : `${directory}.wsgi`;
}

export function suggestDockerfile(fingerprint: Fingerprint): Suggestion | null {
  const port = fingerprint.containerPort;
  // Ports below 1024 need root inside the container. CaptureHost grants
  // NET_BIND_SERVICE and does not force a user, so the generated file simply says so
  // rather than producing an image that cannot bind on start.
  const lowPort = port < 1024;
  const unprivileged = lowPort
    ? 'USER root  # the container port is below 1024; prefer 8000+ and a non-root user'
    : 'RUN useradd --create-home --uid 10001 app && chown -R app:app /app\nUSER app';
  const notes: string[] = [
    `The app is expected to listen on 0.0.0.0:${port} — that is the project's container port. Change both digits if you pick another.`,
  ];

  if (lowPort) {
    notes.push(
      `The container port is ${port}, which needs root inside the container to bind. Set the project's container port to 8000 in Settings for an unprivileged image.`,
    );
  }

  // ---------------------------------------------------------------- node ----
  const packageJson = parseJson(manifest(fingerprint, 'package.json'));
  if (packageJson) {
    const scripts = (packageJson.scripts as Record<string, string> | undefined) ?? {};
    const deps = {
      ...((packageJson.dependencies as Record<string, string> | undefined) ?? {}),
      ...((packageJson.devDependencies as Record<string, string> | undefined) ?? {}),
    };
    const isNext = has(fingerprint, 'next.config.js') || has(fingerprint, 'next.config.mjs') || 'next' in deps;
    const lock = has(fingerprint, 'pnpm-lock.yaml') ? 'pnpm' : has(fingerprint, 'yarn.lock') ? 'yarn' : 'npm';
    const install =
      lock === 'pnpm'
        ? 'RUN corepack enable && pnpm install --frozen-lockfile'
        : lock === 'yarn'
          ? 'RUN corepack enable && yarn install --immutable'
          : 'RUN npm ci';
    const start = scripts.start ? (isNext ? 'CMD ["npm", "start"]' : 'CMD ["npm", "start"]') : null;

    if (scripts.build && start) {
      notes.push(
        isNext
          ? 'Next.js detected: the build runs at image build time, so rebuild after changing content that is baked in.'
          : 'A build script was found, so the build runs once at image build time.',
      );
      return {
        stack: isNext ? 'node:next' : 'node:build',
        confidence: 'high',
        notes,
        dockerfile: `# Generated by CaptureHost from package.json — review before relying on it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ${lock === 'pnpm' ? 'pnpm-lock.yaml ' : lock === 'yarn' ? 'yarn.lock ' : ''}./
${install}
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=${port}
WORKDIR /app
COPY --from=build /app ./
USER node
EXPOSE ${port}
CMD ["npm", "start"]
`,
      };
    }

    if (start) {
      return {
        stack: 'node',
        confidence: 'high',
        notes,
        dockerfile: `# Generated by CaptureHost from package.json — review before relying on it.
FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=${port}
WORKDIR /app
COPY package*.json ${lock === 'pnpm' ? 'pnpm-lock.yaml ' : lock === 'yarn' ? 'yarn.lock ' : ''}./
${install}
COPY . .
USER node
EXPOSE ${port}
CMD ["npm", "start"]
`,
      };
    }

    // No start script: assume a static build served by nginx.
    const output = has(fingerprint, 'dist/') ? 'dist' : has(fingerprint, 'build/') ? 'build' : '.';
    notes.push(`No "start" script, so the result is served as static files from /${output} by nginx.`);
    return {
      stack: 'static',
      confidence: output === '.' ? 'low' : 'medium',
      notes,
      dockerfile: `# Generated by CaptureHost from package.json — review before relying on it.
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
${install}
${scripts.build ? 'RUN npm run build' : 'RUN echo "no build script"'}
FROM nginx:alpine
COPY --from=build /app/${output} /usr/share/nginx/html
RUN printf 'server {\\n  listen ${port};\\n  root /usr/share/nginx/html;\\n  index index.html;\\n  location / { try_files $uri $uri/ /index.html; }\\n}\\n' > /etc/nginx/conf.d/default.conf
EXPOSE ${port}
`,
    };
  }

  // -------------------------------------------------------------- python ----
  const requirements = manifest(fingerprint, 'requirements.txt');
  const pyproject = manifest(fingerprint, 'pyproject.toml');
  if (requirements !== null || pyproject !== null) {
    const requirementsText = (requirements ?? '').toLowerCase();
    const pyprojectText = (pyproject ?? '').toLowerCase();
    const deps = `${requirementsText}\n${pyprojectText}`;
    const procfile = manifest(fingerprint, 'Procfile') ?? '';
    const isDjango = deps.includes('django') || has(fingerprint, 'manage.py');
    const isFastApi = deps.includes('fastapi') || deps.includes('uvicorn');
    const module = pythonModule(fingerprint);
    const install =
      requirements !== null
        ? 'COPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt'
        : 'COPY pyproject.toml ./\nRUN pip install --no-cache-dir .';

    const systemDeps: string[] = [];
    // lxml, cffi, psycopg2 and friends need a compiler when no wheel exists.
    if (/lxml|psycopg2|cryptography|cffi|pillow/.test(deps)) {
      systemDeps.push('RUN apt-get update && apt-get install -y --no-install-recommends build-essential libxml2-dev libxslt1-dev \\\n && rm -rf /var/lib/apt/lists/*');
      notes.push('A dependency usually needs a compiler (lxml/psycopg2/cryptography), so build tools are installed in the image.');
    }

    if (isDjango) {
      const wsgi = djangoModule(fingerprint);
      notes.push(`Django: gunicorn is pointed at ${wsgi}:application. Adjust if the settings package is named differently.`);
      return {
        stack: 'python:django',
        confidence: 'medium',
        notes,
        dockerfile: `# Generated by CaptureHost from the python manifests — review before relying on it.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PORT=${port}
WORKDIR /app
${systemDeps.join('\n')}
${install}
COPY . .
${unprivileged}
EXPOSE ${port}
CMD ["gunicorn", "--bind", "0.0.0.0:${port}", "--workers", "2", "${wsgi}:application"]
`,
      };
    }

    if (isFastApi) {
      notes.push(`FastAPI: uvicorn is pointed at ${module.module}:${module.callable}.`);
      return {
        stack: 'python:fastapi',
        confidence: 'high',
        notes,
        dockerfile: `# Generated by CaptureHost from the python manifests — review before relying on it.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PORT=${port}
WORKDIR /app
${systemDeps.join('\n')}
${install}
COPY . .
${unprivileged}
EXPOSE ${port}
CMD ["uvicorn", "${module.module}:${module.callable}", "--host", "0.0.0.0", "--port", "${port}"]
`,
      };
    }

    const runner = /gunicorn/.test(`${deps}${procfile.toLowerCase()}`) ? 'gunicorn' : 'flask run';
    notes.push(
      runner === 'gunicorn'
        ? `gunicorn found: it serves ${module.module}:${module.callable} on port ${port}.`
        : `No gunicorn in the dependencies, so this uses "flask run". Add gunicorn for anything real.`,
    );
    if (procfile.includes('web:')) notes.push(`Procfile says: ${procfile.split('\n').find((line) => line.startsWith('web:'))?.trim()}`);

    return {
      stack: 'python:flask',
      confidence: module.module === 'app' && has(fingerprint, 'app.py') ? 'high' : 'medium',
      notes,
      dockerfile: `# Generated by CaptureHost from the python manifests — review before relying on it.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PORT=${port} \\
    FLASK_APP=${module.module}.py
WORKDIR /app
${systemDeps.join('\n')}
${install}
COPY . .
${unprivileged}
EXPOSE ${port}
${runner === 'gunicorn'
        ? `CMD ["gunicorn", "--bind", "0.0.0.0:${port}", "--workers", "2", "--timeout", "120", "${module.module}:${module.callable}"]`
        : `CMD ["flask", "run", "--host", "0.0.0.0", "--port", "${port}"]`}
`,
    };
  }

  // ------------------------------------------------------------------ go ----
  if (has(fingerprint, 'go.mod') && has(fingerprint, 'main.go')) {
    notes.push('Built as a static binary; the runtime image is distroless-free (alpine) for a shell when debugging.');
    return {
      stack: 'go',
      confidence: 'high',
      notes,
      dockerfile: `# Generated by CaptureHost from go.mod — review before relying on it.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app .

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/app /app/app
ENV PORT=${port}
EXPOSE ${port}
CMD ["/app/app"]
`,
    };
  }

  // ----------------------------------------------------------------- php ----
  if (has(fingerprint, 'composer.json')) {
    notes.push('Assumes a PHP application with a web root of the repository root; adjust DocumentRoot if it is public/.');
    return {
      stack: 'php',
      confidence: 'medium',
      notes,
      dockerfile: `# Generated by CaptureHost from composer.json — review before relying on it.
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock* ./
RUN composer install --no-dev --no-interaction --no-scripts --prefer-dist

FROM php:8.3-apache
WORKDIR /var/www/html
COPY --from=vendor /app/vendor ./vendor
COPY . .
RUN sed -ri 's/Listen 80/Listen ${port}/; s/:80>/:${port}>/' /etc/apache2/ports.conf \\
 && sed -ri 's/<VirtualHost \\*:80>/<VirtualHost *:${port}>/' /etc/apache2/sites-available/000-default.conf
EXPOSE ${port}
`,
    };
  }

  // ---------------------------------------------------------------- ruby ----
  if (has(fingerprint, 'Gemfile')) {
    notes.push('Assumes a Rack application in config.ru; change the CMD for Rails (bundle exec rails server).');
    return {
      stack: 'ruby',
      confidence: 'medium',
      notes,
      dockerfile: `# Generated by CaptureHost from Gemfile — review before relying on it.
FROM ruby:3.3-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev \\
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock* ./
RUN bundle install
COPY . .
RUN useradd --create-home --uid 10001 app && chown -R app:app /app
USER app
ENV PORT=${port}
EXPOSE ${port}
CMD ["bundle", "exec", "rackup", "-o", "0.0.0.0", "-p", "${port}"]
`,
    };
  }

  // ---------------------------------------------------------------- rust ----
  if (has(fingerprint, 'Cargo.toml')) {
    notes.push('Built in release mode; adjust the binary name if Cargo.toml names it differently.');
    return {
      stack: 'rust',
      confidence: 'medium',
      notes,
      dockerfile: `# Generated by CaptureHost from Cargo.toml — review before relying on it.
FROM rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=build /src/target/release/ /app/bin/
ENV PORT=${port}
USER app
EXPOSE ${port}
CMD ["/app/bin/${fingerprint.projectName}"]
`,
    };
  }

  // -------------------------------------------------------------- static ----
  if (has(fingerprint, 'index.html')) {
    notes.push('Plain static site: nginx serves the repository as-is. No build step.');
    return {
      stack: 'static',
      confidence: 'high',
      notes,
      dockerfile: `# Generated by CaptureHost from index.html — review before relying on it.
FROM nginx:alpine
COPY . /usr/share/nginx/html
RUN printf 'server {\\n  listen ${port};\\n  root /usr/share/nginx/html;\\n  index index.html;\\n}\\n' > /etc/nginx/conf.d/default.conf
EXPOSE ${port}
`,
    };
  }

  return null;
}
