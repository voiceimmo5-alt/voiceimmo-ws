// server.js — Tunnel launcher (cloudflared) + démarre server-core.js
const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');

const TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN;

async function downloadCloudflared() {
  const dest = '/tmp/cloudflared';
  if (fs.existsSync(dest)) {
    console.log('[TUNNEL] cloudflared déjà présent');
    return dest;
  }
  console.log('[TUNNEL] Téléchargement cloudflared...');
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const getFile = (url) => {
      https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          getFile(res.headers.location);
        } else if (res.statusCode === 200) {
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.chmodSync(dest, '755');
            console.log('[TUNNEL] cloudflared téléchargé ✅');
            resolve(dest);
          });
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      }).on('error', reject);
    };
    getFile('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
  });
}

async function main() {
  // Démarrer server-core.js immédiatement
  console.log('[LAUNCH] Démarrage server-core.js...');
  const nodeProc = spawn('node', ['server-core.js'], { stdio: 'inherit', env: process.env });
  nodeProc.on('exit', (code) => {
    console.log('[LAUNCH] server-core.js terminé, code:', code);
    process.exit(code || 0);
  });

  if (!TUNNEL_TOKEN) {
    console.log('[TUNNEL] Pas de CLOUDFLARE_TUNNEL_TOKEN — mode Railway direct');
    return;
  }

  // Attendre 4s que le serveur soit prêt
  await new Promise(r => setTimeout(r, 4000));

  try {
    const cfBin = await downloadCloudflared();
    console.log('[TUNNEL] Démarrage cloudflared...');
    
    const cfProc = spawn(cfBin, [
      'tunnel', '--no-autoupdate', 'run',
      '--token', TUNNEL_TOKEN
    ], { stdio: 'inherit' });
    
    cfProc.on('exit', (code) => {
      console.log('[TUNNEL] cloudflared exit, code:', code);
    });

    process.on('SIGTERM', () => {
      cfProc.kill('SIGTERM');
      nodeProc.kill('SIGTERM');
    });
    
  } catch(e) {
    console.error('[TUNNEL] Erreur:', e.message, '— on continue sans tunnel');
  }
}

main().catch(console.error);
