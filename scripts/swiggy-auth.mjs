/**
 * Manual Swiggy MCP OAuth flow.
 *
 * Swiggy's MCP server omits the WWW-Authenticate header on 401s, so mcporter
 * never learns the OAuth endpoint and the browser never opens. And mcporter's
 * own OAuth provider always triggers proactive re-auth (it calls sdkAuth which
 * starts a new browser flow whenever there's no refresh_token). So instead of
 * using mcporter's OAuth vault, this script writes the token as a static
 * Authorization header to ~/.mcporter/mcporter.json after auth.
 *
 * Usage: node scripts/swiggy-auth.mjs
 */

import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME_CONFIG_PATH = path.join(os.homedir(), '.mcporter', 'mcporter.json');
const CLIENT_ID = 'swiggy-mcp';
const REDIRECT_PORT = 3333;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;
const TOKEN_ENDPOINT = 'https://mcp.swiggy.com/auth/token';
const AUTH_ENDPOINT = 'https://mcp.swiggy.com/auth/authorize';
const SCOPE = 'mcp:tools mcp:resources mcp:prompts';

// ── PKCE ─────────────────────────────────────────────────────────────────────

function generateVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Home config helpers ───────────────────────────────────────────────────────

async function readHomeConfig() {
  try {
    const raw = await fs.readFile(HOME_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* first run or parse error */ }
  return { mcpServers: {} };
}

async function writeServerConfig(accessToken) {
  const config = await readHomeConfig();
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers['swiggy-food'] = {
    baseUrl: 'https://mcp.swiggy.com/food',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  };
  await fs.mkdir(path.dirname(HOME_CONFIG_PATH), { recursive: true });
  await fs.writeFile(HOME_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  console.log(`\nServer config written to ${HOME_CONFIG_PATH}`);
}

// ── OAuth callback server ─────────────────────────────────────────────────────

function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Auth complete — you can close this tab.</h2></body></html>');
      server.close();
      if (error) reject(new Error(`OAuth error: ${error} — ${url.searchParams.get('error_description') ?? ''}`));
      else resolve(code);
    });
    server.listen(REDIRECT_PORT, 'localhost', () => {
      console.log(`Callback server listening on port ${REDIRECT_PORT}`);
    });
    server.on('error', reject);
  });
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

// ── Browser open ──────────────────────────────────────────────────────────────

function openBrowser(url) {
  const platform = process.platform;
  let cmd, args;
  if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/s', '/c', `start "" "${url}"`];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  const child = spawn(cmd, args, {
    stdio: 'ignore',
    detached: true,
    ...(platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
  });
  child.unref();
}

// ── Main ──────────────────────────────────────────────────────────────────────

const verifier = generateVerifier();
const challenge = generateChallenge(verifier);
const state = crypto.randomBytes(16).toString('hex');

const authUrl = new URL(AUTH_ENDPOINT);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('code_challenge', challenge);
authUrl.searchParams.set('code_challenge_method', 'S256');

console.log('\nOpening Swiggy login in your browser...');
console.log('If the browser does not open, paste this URL manually:\n');
console.log(authUrl.toString());
console.log();

const callbackPromise = waitForCallback();
openBrowser(authUrl.toString());

const code = await callbackPromise;
console.log('\nGot authorization code. Exchanging for tokens...');
const tokens = await exchangeCode(code, verifier);
console.log('Got tokens. access_token length:', tokens.access_token.length);

await writeServerConfig(tokens.access_token);
console.log('\nDone. Test with:');
console.log('  node skills/swiggy/swiggy-cli.js food addresses');
