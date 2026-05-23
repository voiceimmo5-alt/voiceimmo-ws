'use strict';
const http      = require('http');
const express   = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Buffer de logs circulaire ───────────────────────────────────────────────
const LOG_BUFFER = [];
const MAX_LOGS = 200;
const origLog   = console.log;
const origError = console.error;
function pushLog(level, args) {
  const line = { ts: Date.now(), level, msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') };
  LOG_BUFFER.push(line);
  if (LOG_BUFFER.length > MAX_LOGS) LOG_BUFFER.shift();
}
console.log   = (...a) => { origLog(...a);   pushLog('info',  a); };
console.error = (...a) => { origError(...a); pushLog('error', a); };

// ─── Variables d'environnement ───────────────────────────────────────────────
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || '';
const OAI_MODEL          = process.env.OAI_MODEL          || 'gpt-4o-realtime-preview';
const RESEND_API_KEY     = process.env.RESEND_API_KEY     || '';
const EMAIL_FROM         = process.env.EMAIL_FROM         || 'VoiceImmo <noreply@voiceimmo.fr>';

// ─── Config clients (autonome) ────────────────────────────────────────────────
const CONFIGS = {
  '+33939245959': {
    nom_agence:          'LEONE IMMOBILIER',
    client_db_id:        '6a0cdf1388a8c7697ae8a452',
    voix:                'coral',
    site_internet:       'https://www.leone-immobilier.fr',
    message_accueil:     "Bonjour et bienvenue chez Leone Immobilier, comment puis-je vous aider ?",
    agents_arr: [
      { nom: 'Luca',  email: 'leone.immobilier@gmail.com',      zones: 'givors, irigny, st genis laval, corbas, oullins, pierre-benite, charly' },
      { nom: 'Kenny', email: 'kenny.leoneimmobilier@gmail.com',  zones: 'villette de vienne, vienne, roussillon, grigny' },
      { nom: 'Jeff',  email: 'jeff.leoneimmobilier@gmail.com',   zones: 'villefontaine, nord rhone, beaujolais, villefranche' }
    ],
    destinataires_email: ['leone.immobilier@gmail.com', 'christophe.despretz@gmail.com'],
  },
  '+33939247019': {
    nom_agence:          'LEONE IMMOBILIER (STAGING)',
    client_db_id:        '6a057fa03ad6f7b2ebf4b79e',
    voix:                'coral',
    site_internet:       'https://www.leone-immobilier.fr',
    message_accueil:     "Bonjour, ceci est le serveur de test Leone Immobilier. Comment puis-je vous aider ?",
    agents_arr: [
      { nom: 'Luca',  email: 'leone.immobilier@gmail.com',      zones: 'givors, irigny, st genis laval, corbas, oullins, pierre-benite' },
      { nom: 'Kenny', email: 'kenny.leoneimmobilier@gmail.com',  zones: 'villette de vienne, vienne, roussillon' },
      { nom: 'Jeff',  email: 'jeff.leoneimmobilier@gmail.com',   zones: 'villefontaine, nord rhone, beaujolais' }
    ],
    destinataires_email: ['christophe.despretz@gmail.com'],
  }
};

const DEF_CFG = CONFIGS['+33939245959'];

function getConfig(numTwilio) {
  const key = numTwilio.startsWith('+') ? numTwilio : `+${numTwilio}`;
  const cfg = CONFIGS[key];
  if (cfg) { console.log(`[CFG] Config trouvée pour ${key}: ${cfg.nom_agence}`); return cfg; }
  console.log(`[CFG] Numéro ${key} inconnu → fallback Leone`);
  return DEF_CFG;
}

// ─── Gmail OAuth2 — obtenir un access token ───────────────────────────────────
// ─── Envoyer email via Resend ─────────────────────────────────────────────────
async function sendResend(to, subject, html) {
  if (!RESEND_API_KEY) { console.error('[EMAIL] RESEND_API_KEY manquante'); return false; }
  const toArr = Array.isArray(to) ? to : [to];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: toArr, subject, html })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Resend error: ' + err);
  }
  return true;
}

// ─── Email notification lead ──────────────────────────────────────────────────
async function sendEmail(lead, cfg, transcript) {
  try {
    const agentTrouve = (cfg.agents || []).find(a => (lead.agent_initiales||'').toLowerCase().split('/').map(s=>s.trim()).includes(a.nom.split(' ')[0].toLowerCase()) || a.zones.includes((lead.ville||'').toLowerCase()));
    const destAgent = agentTrouve ? agentTrouve.email : null;
    const destList = [...new Set([...(cfg.destinataires_email||[]), destAgent].filter(Boolean))];
    
    const agentLabel = agentTrouve ? agentTrouve.nom : (lead.agent_initiales || 'N/A');
    const html = '<div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">'
      + '<h2 style="color:#4f46e5">🏠 Nouveau lead VoiceImmo</h2>'
      + '<table style="width:100%;border-collapse:collapse">'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Nom</td><td style="padding:8px">' + (lead.nom||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Téléphone</td><td style="padding:8px">' + (lead.telephone||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Besoin</td><td style="padding:8px">' + (lead.besoin||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Ville</td><td style="padding:8px">' + (lead.ville||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Prix</td><td style="padding:8px">' + (lead.prix||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Référence</td><td style="padding:8px">' + (lead.reference||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Agent</td><td style="padding:8px">' + agentLabel + '</td></tr>'
      + '</table>'
      + (transcript ? '<h3>Transcription</h3><pre style="background:#f3f4f6;padding:12px;border-radius:8px;font-size:12px">' + transcript + '</pre>' : '')
      + '</div>';
    
    await sendResend(destList, 'Nouveau lead VoiceImmo — ' + (lead.nom||'Inconnu'), html);
    console.log('[EMAIL] ✅ Email envoyé via Resend à:', destList.join(', '));
    return true;
  } catch(e) {
    console.error('[EMAIL] ❌ Erreur Resend:', e.message);
    return false;
  }
}

// ─── Email OTP Admin ──────────────────────────────────────────────────────────
async function sendOtpEmail(to, code, expiry) {
  const html = '<div style="font-family:sans-serif;max-width:400px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">'
    + '<h2 style="color:#4f46e5">&#9889; Voxzen Admin</h2>'
    + '<p>Votre code de connexion :</p>'
    + '<div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#111;text-align:center;padding:16px;background:#f3f4f6;border-radius:8px">' + code + '</div>'
    + '<p style="color:#6b7280;font-size:13px">Valide jusqu&apos;a ' + expiry + ' &mdash; Ne partagez pas ce code.</p>'
    + '</div>';
  await sendResend(to, 'Code OTP Voxzen Admin — ' + code, html);
  return true;
}


app.post('/send-otp', express.json(), (req, res) => {
  const body = req.body || {};
  const to = body.to;
  const code = body.code;
  const expiry = body.expiry || '10 min';
  if (!to || !code) return res.status(400).json({ error: 'Paramètres manquants' });
  console.log('[OTP] Requête reçue pour ' + to + ' code=' + code);
  // Répondre immédiatement pour éviter le timeout Railway
  res.json({ ok: true, queued: true });
  // Envoyer l'email en arrière-plan
  sendOtpEmail(to, code, expiry)
    .then(() => console.log('[OTP] ✅ Email OTP envoyé à ' + to))
    .catch(e => console.error('[OTP] Echec envoi email: ' + e.message));
});

server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v41-resend sur port ${PORT}`));
