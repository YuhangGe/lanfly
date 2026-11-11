import { stringify } from 'superjson';

export const browserMode = !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);
export const eventPath = `${browserMode ? '/api/v1/browser/events' : '/events'}?client=2`;

function stored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private browser storage may be unavailable. */
  }
}

let token = stored('lanfly.browser.token');
if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
  token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  remember('lanfly.browser.token', token);
}

export function browserName(): string {
  const ua = navigator.userAgent;
  const platform = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Macintosh/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '浏览器';
  return stored('lanfly.browser.name') || `${platform} 浏览器`;
}

export async function joinBrowser(name: string): Promise<void> {
  const response = await fetch('/api/v1/browser/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, name }),
    credentials: 'same-origin',
  });
  if (!response.ok)
    throw Object.assign(new Error('无法接入，请确认 lanfly 仍在运行'), { status: response.status });
  remember('lanfly.browser.name', name);
}

export async function renameBrowser(name: string): Promise<void> {
  const response = await fetch('/api/v1/browser/rpc/browserRename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stringify({ name }),
  });
  if (!response.ok) throw new Error('修改名称失败');
  remember('lanfly.browser.name', name);
}

/** Source address the gateway sees for this browser, used to de-mDNS desktop host candidates. */
export async function browserLocalAddress(): Promise<string> {
  try {
    const response = await fetch('/api/v1/browser/address', { cache: 'no-store' });
    if (!response.ok) return '';
    const value = (await response.json()) as { address?: unknown };
    return typeof value.address === 'string' ? value.address : '';
  } catch {
    return '';
  }
}
