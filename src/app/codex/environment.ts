const SAFE_ENVIRONMENT_KEYS = new Set<string>([
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_COLLATE',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_PAPER',
  'LC_NAME',
  'LC_ADDRESS',
  'LC_TELEPHONE',
  'LC_MEASUREMENT',
  'LC_IDENTIFICATION',
  'TERM',
  'CODEX_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
]);
const PROXY_URL_KEYS = new Set<string>([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
]);
const SAFE_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks5:', 'socks5h:']);

/**
 * Builds the environment passed to Codex subprocesses from an explicit
 * allowlist. Bridge credentials and deployment policy must never cross the
 * subprocess boundary merely because they exist in the parent environment.
 */
export function buildCodexEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
): Readonly<NodeJS.ProcessEnv> {
  const codexEnvironment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (
      value !== undefined
      && isSafeEnvironmentKey(key)
      && isSafeEnvironmentValue(key, value)
    ) {
      codexEnvironment[key] = value;
    }
  }
  return Object.freeze(codexEnvironment);
}

function isSafeEnvironmentKey(key: string): boolean {
  return SAFE_ENVIRONMENT_KEYS.has(key);
}

function isSafeEnvironmentValue(key: string, value: string): boolean {
  if (!PROXY_URL_KEYS.has(key)) {
    return true;
  }
  try {
    const proxyUrl = new URL(value);
    return SAFE_PROXY_PROTOCOLS.has(proxyUrl.protocol)
      && proxyUrl.username === ''
      && proxyUrl.password === '';
  } catch {
    return false;
  }
}
