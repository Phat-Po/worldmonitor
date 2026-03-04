import { execSync, spawn } from 'node:child_process';

function parseScutilKey(output, key) {
  const match = output.match(new RegExp(`\\b${key}\\s*:\\s*([^\\n]+)`));
  return match?.[1]?.trim() ?? '';
}

function detectMacSystemProxy() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync('scutil --proxy', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const httpsEnabled = parseScutilKey(out, 'HTTPSEnable') === '1';
    const httpsHost = parseScutilKey(out, 'HTTPSProxy');
    const httpsPort = parseScutilKey(out, 'HTTPSPort');
    if (httpsEnabled && httpsHost && httpsPort) return `http://${httpsHost}:${httpsPort}`;

    const httpEnabled = parseScutilKey(out, 'HTTPEnable') === '1';
    const httpHost = parseScutilKey(out, 'HTTPProxy');
    const httpPort = parseScutilKey(out, 'HTTPPort');
    if (httpEnabled && httpHost && httpPort) return `http://${httpHost}:${httpPort}`;
  } catch {
    return null;
  }
  return null;
}

function mergeNoProxy(existing) {
  const base = (existing || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = new Set(base);
  ['127.0.0.1', 'localhost', '::1'].forEach((h) => merged.add(h));
  return Array.from(merged).join(',');
}

const env = { ...process.env };
env.NODE_USE_ENV_PROXY = env.NODE_USE_ENV_PROXY || '1';
env.NO_PROXY = mergeNoProxy(env.NO_PROXY || env.no_proxy);

const configuredProxy =
  env.HTTPS_PROXY ||
  env.HTTP_PROXY ||
  env.https_proxy ||
  env.http_proxy ||
  detectMacSystemProxy();

if (configuredProxy) {
  env.HTTPS_PROXY = env.HTTPS_PROXY || configuredProxy;
  env.HTTP_PROXY = env.HTTP_PROXY || configuredProxy;
  env.https_proxy = env.https_proxy || env.HTTPS_PROXY;
  env.http_proxy = env.http_proxy || env.HTTP_PROXY;
  console.log(`[dev:vercel:proxy] proxy=${env.HTTPS_PROXY}`);
} else {
  console.log('[dev:vercel:proxy] no system proxy detected; starting without HTTP(S)_PROXY');
}

const args = ['--yes', 'vercel@latest', 'dev', ...process.argv.slice(2)];
console.log(`[dev:vercel:proxy] npx ${args.join(' ')}`);

const child = spawn('npx', args, {
  stdio: 'inherit',
  env,
});

child.on('error', (error) => {
  console.error('[dev:vercel:proxy] failed to start vercel dev:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
