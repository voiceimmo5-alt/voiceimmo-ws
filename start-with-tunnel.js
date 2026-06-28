// start-with-tunnel.js — Lance cloudflared + node server.js en parallèle
const { spawn, execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN;
const USE_TUNNEL = !!TUNNEL_TOKEN;

async function downloadCloudflared() {
  const dest = '/tmp/cloudflared';
  if (fs.existsSync(dest)) return dest;
  
  console.log('[TUNNEL] Téléchargement cloudflared...');
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, (res2) => {
          res2.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      } else {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }
    }).on('error', reject);
  });
  
  fs.chmodSync(dest, '755');
  console.log('[TUNNEL] cloudflared téléchargé ✅');
  return dest;
}

async function main() {
  // Toujours démarrer node server.js
  console.log('[START] Démarrage node server.js...');
  const nodeProc = spawn('node', ['server.js'], { stdio: 'inherit', env: process.env });
  nodeProc.on('exit', (code) => {
    console.log('[START] server.js terminé, code:', code);
    process.exit(code || 0);
  });

  if (!USE_TUNNEL) {
    console.log('[TUNNEL] Pas de CLOUDFLARE_TUNNEL_TOKEN — mode direct Railway');
    return;
  }

  // Attendre 3s que le serveur démarre
  await new Promise(r => setTimeout(r, 3000));

  try {
    const cfBin = await downloadCloudflared();
    console.log('[TUNNEL] Démarrage cloudflared tunnel...');
    
    const cfProc = spawn(cfBin, [
      'tunnel', '--no-autoupdate', 'run',
      '--token', TUNNEL_TOKEN
    ], { stdio: 'inherit' });
    
    cfProc.on('exit', (code) => {
      console.log('[TUNNEL] cloudflared terminé, code:', code);
    });
    
    process.on('SIGTERM', () => {
      cfProc.kill('SIGTERM');
      nodeProc.kill('SIGTERM');
    });
  } catch(e) {
    console.error('[TUNNEL] Erreur démarrage tunnel:', e.message);
    console.log('[TUNNEL] Continuons sans tunnel...');
  }
}

main().catch(console.error);
