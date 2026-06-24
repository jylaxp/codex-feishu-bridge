import * as Lark from '@larksuiteoapi/node-sdk';
import * as qrcode from 'qrcode-terminal';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { envPath } from '../config';

export let larkClient: Lark.Client;

// --- Feishu Token Cache ---
let cachedToken = "";
let tokenExpiresAt = 0;
let tokenFetchPromise: Promise<string> | null = null;

export async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }
  if (tokenFetchPromise) {
    return tokenFetchPromise;
  }

  tokenFetchPromise = (async () => {
    try {
      const appId = process.env.LARK_APP_ID || process.env.APP_ID;
      const appSecret = process.env.LARK_APP_SECRET || process.env.APP_SECRET;
      console.log(`[DEBUG] getTenantAccessToken using APP_ID: ${appId}`);
      if (!appId || !appSecret) {
        throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET");
      }

      const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret })
      });
      const data: any = await res.json();
      if (data.code !== 0) {
        throw new Error(`Failed to get Feishu token: ${data.msg}`);
      }
      cachedToken = data.tenant_access_token;
      tokenExpiresAt = Date.now() + (data.expire || 7200) * 1000;
      return cachedToken;
    } finally {
      tokenFetchPromise = null;
    }
  })();

  return tokenFetchPromise;
}

export function updateEnvFile(appId: string, appSecret: string) {
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  const setEnvVar = (content: string, key: string, value: string): string => {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      return content.replace(regex, `${key}=${value}`);
    } else {
      return content + (content.endsWith('\n') || content === '' ? '' : '\n') + `${key}=${value}\n`;
    }
  };

  envContent = setEnvVar(envContent, 'LARK_APP_ID', appId);
  envContent = setEnvVar(envContent, 'LARK_APP_SECRET', appSecret);

  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log(`💾 Saved credentials to ${envPath}`);
}

export async function ensureCredentials(): Promise<{ appId: string; appSecret: string }> {
  const rawAppId = process.env.LARK_APP_ID || process.env.APP_ID || '';
  const rawAppSecret = process.env.LARK_APP_SECRET || process.env.APP_SECRET || '';

  const curAppId = rawAppId.trim();
  const curAppSecret = rawAppSecret.trim();

  if (
    curAppId && 
    curAppSecret && 
    curAppId !== 'YOUR_FEISHU_APP_ID' && 
    curAppSecret !== 'YOUR_FEISHU_APP_SECRET'
  ) {
    return { appId: curAppId, appSecret: curAppSecret };
  }

  delete process.env.LARK_APP_ID;
  delete process.env.APP_ID;
  delete process.env.LARK_APP_SECRET;
  delete process.env.APP_SECRET;

  console.log('\n==================================================================');
  console.log('⚠️  LARK_APP_ID and LARK_APP_SECRET are not configured.');
  console.log('Starting automatic Feishu Bot creation and registration flow...');
  console.log('==================================================================\n');

  try {
    const result = await Lark.registerApp({
      onQRCodeReady(info) {
        console.log('👉 Please open the following URL in your browser to authorize:');
        console.log(`🔗 URL: ${info.url}`);
        console.log('\n👉 Or scan the QR code below with your Feishu app:');
        qrcode.generate(info.url, { small: true });
        console.log(`(This QR code expires in ${info.expireIn} seconds)\n`);
      },
      onStatusChange(info) {
        console.log(`[Status Update] Registration status: ${info.status}`);
      },
      appPreset: {
        name: 'Codex Control Bot ({user})',
        desc: 'Codex Desktop remote control bot for {user}.',
      }
    });

    const newAppId = result.client_id;
    const newAppSecret = result.client_secret;

    console.log('\n==================================================================');
    console.log('🎉 Feishu Bot created and registered successfully!');
    console.log(`App ID: ${newAppId}`);
    console.log('==================================================================\n');

    updateEnvFile(newAppId, newAppSecret);

    process.env.LARK_APP_ID = newAppId;
    process.env.LARK_APP_SECRET = newAppSecret;

    return { appId: newAppId, appSecret: newAppSecret };
  } catch (e: any) {
    console.error('❌ Failed to automatically register Feishu Bot:', e.description || e.message || e);
    process.exit(1);
  }
}

export async function initLarkClient(): Promise<{ appId: string; appSecret: string }> {
  const creds = await ensureCredentials();
  larkClient = new Lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
  });
  return creds;
}
