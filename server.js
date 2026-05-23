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
const GMAIL_CLIENT_ID    = process.env.GMAIL_CLIENT_ID    || '';
const GMAIL_CLIENT_SECRET= process.env.GMAIL_CLIENT_SECRET|| '';
const GMAIL_REFRESH_TOKEN= process.env.GMAIL_REFRESH_TOKEN|| '';
const GMAIL_FROM         = process.env.GMAIL_FROM         || 'voiceimmo5@gmail.com';

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
async function getGmailAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Gmail token error: ' + JSON.stringify(data));
  return data.access_token;
}

// ─── Envoyer email via Gmail API ─────────────────────────────────────────────
async function sendEmail(lead, cfg, transcript) {
  if (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN) {
    console.log('[EMAIL] Credentials Gmail absents → email ignoré');
    return;
  }
  try {
    const accessToken = await getGmailAccessToken();

    const transcriptHtml = transcript.map(t =>
      `<tr>
        <td style="color:${t.r==='a'?'#7c3aed':'#1d4ed8'};padding:4px 12px;font-weight:bold;white-space:nowrap">${t.r==='a'?'🤖 Sophie':'👤 Appelant'}</td>
        <td style="padding:4px 12px">${t.t}</td>
      </tr>`
    ).join('');

    const to = Array.isArray(cfg.destinataires_email) ? cfg.destinataires_email : [cfg.destinataires_email];

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#7c3aed;border-bottom:2px solid #7c3aed;padding-bottom:8px">
          🏠 Nouveau lead VoiceImmo
        </h2>
        <table border="0" cellpadding="6" style="width:100%;background:#f9fafb;border-radius:8px;margin-bottom:20px">
          <tr><td style="font-weight:bold;width:140px">👤 Nom</td><td>${lead.nom || 'Non renseigné'}</td></tr>
          <tr><td style="font-weight:bold">📞 Téléphone</td><td>${lead.tel || 'Non renseigné'}</td></tr>
          <tr><td style="font-weight:bold">🎯 Besoin</td><td>${lead.besoin || 'Non renseigné'}</td></tr>
          <tr><td style="font-weight:bold">📍 Ville</td><td>${lead.ville || 'Non renseignée'}</td></tr>
          <tr><td style="font-weight:bold">💰 Budget</td><td>${lead.prix || 'Non renseigné'}</td></tr>
          <tr><td style="font-weight:bold">🔖 Référence</td><td>${lead.ref || 'Non renseignée'}</td></tr>
          <tr><td style="font-weight:bold">🧑‍💼 Agent</td><td>${lead.agentNom || lead.agent || 'Non assigné'}</td></tr>
        </table>
        <h3 style="color:#374151">📝 Transcription de l'appel</h3>
        <table border="0" cellpadding="4" style="background:#f9fafb;border-radius:8px;width:100%">
          ${transcriptHtml || '<tr><td colspan="2" style="padding:12px;color:#9ca3af">Aucune transcription disponible</td></tr>'}
        </table>
        <p style="color:#9ca3af;font-size:11px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px">
          VoiceImmo — Système de réception d'appels IA • ${cfg.nom_agence}
        </p>
      </div>`;

    // Construire le message RFC 2822 encodé en base64
    const subject = `🏠 Nouveau lead — ${lead.nom || 'Inconnu'} — ${cfg.nom_agence}`;
    const toLine  = to.join(', ');
    const raw = [
      `From: VoiceImmo <${GMAIL_FROM}>`,
      `To: ${toLine}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      html
    ].join('\r\n');

    const encoded = Buffer.from(raw).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw: encoded })
    });

    if (res.ok) {
      console.log('[EMAIL] ✅ Email envoyé via Gmail API à:', toLine);
    } else {
      const err = await res.text();
      console.error('[EMAIL] ❌ Erreur Gmail API:', res.status, err);
    }
  } catch(e) {
    console.error('[EMAIL] Exception:', e.message);
  }
}

// ─── Endpoints HTTP ──────────────────────────────────────────────────────────
app.get('/',       (req, res) => res.json({ status: 'ok', version: 'v36-otp-fix', service: 'VoiceImmo WS' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  let oaiOk = false, gmailOk = false;
  try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }); oaiOk = r.ok; } catch(_) {}
  try { await getGmailAccessToken(); gmailOk = true; } catch(_) {}
  res.json({ version: 'v36-otp-fix', hasOAI: !!OPENAI_API_KEY, oaiOk, gmailOk, configs: Object.keys(CONFIGS) });
});

app.get('/logs', (req, res) => {
  const n     = parseInt(req.query.n    || '50');
  const since = parseInt(req.query.since|| '0');
  res.json({ logs: LOG_BUFFER.filter(l => l.ts > since).slice(-n), serverTime: Date.now(), version: 'v36-otp-fix' });
});

app.get('/stats', async (req, res) => {
  let oaiOk = false, gmailOk = false;
  try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }); oaiOk = r.ok; } catch(_) {}
  try { await getGmailAccessToken(); gmailOk = true; } catch(_) {}
  res.json({ ok: true, version: 'v36-otp-fix', uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed/1024/1024), oaiOk, gmailOk, node: process.version, serverTime: Date.now(), activeConnections: wss.clients.size, configs: Object.keys(CONFIGS) });
});

app.post('/twiml', (req, res) => {
  const caller = req.body.From   || req.body.Caller || '';
  const to     = req.body.To     || req.body.Called || '';
  const sid    = req.body.CallSid|| '';
  console.log(`[TWIML] From:${caller} To:${to} Sid:${sid}`);
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://ws.voiceimmo.fr">
      <Parameter name="caller" value="${caller}" />
      <Parameter name="to" value="${to}" />
      <Parameter name="sid" value="${sid}" />
    </Stream>
  </Connect>
</Response>`);
});

// ─── Prompt Sophie ────────────────────────────────────────────────────────────
function buildPrompt(c, callerNum) {
  const agentsStr = (c.agents_arr || []).map(a => `• ${a.nom} → ${a.zones}`).join('\n');
  return `Tu es Sophie, assistante vocale de l'agence ${c.nom_agence}.
LANGUE : FRANÇAIS UNIQUEMENT. Jamais d'anglais.

RÈGLES ABSOLUES :
- Tu ne recommandes aucune autre plateforme (SeLoger, LeBonCoin, etc.)
- Tu ne donnes pas de conseils juridiques ou financiers
- Tu collectes les informations dans cet ordre :
  1. Prénom et nom de l'appelant
  2. Nature du besoin (achat, vente, location, estimation)
  3. Ville / secteur du bien
  4. Budget approximatif
  5. Référence du bien si disponible
  6. Confirmer le numéro détecté : "${callerNum}"
- Après collecte complète : "Merci [Prénom], un agent va vous rappeler très rapidement. Au revoir !"

AGENTS ET ZONES :
${agentsStr}

Site web : ${c.site_internet || 'https://www.leone-immobilier.fr'}
Numéro détecté : ${callerNum}`;
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] ✅ Connexion depuis', req.socket.remoteAddress);

  let streamSid  = '';
  let oai        = null;
  let ready      = false;
  let queue      = [];
  let transcript = [];
  let curAss     = '';
  let lead       = { nom:'', tel:'', besoin:'', agent:'', agentNom:'', ville:'', prix:'', ref:'' };
  let cfg        = DEF_CFG;
  let saved      = false;
  let callTimer  = null;

  function hangup() {
    if (callTimer) { clearTimeout(callTimer); callTimer = null; }
    if (oai && oai.readyState === WebSocket.OPEN) oai.close();
  }

  async function flush() {
    if (saved) return; saved = true;
    hangup();
    await sendEmail(lead, cfg, transcript);
  }

  function connectOAI(callerNum) {
    console.log('[OAI] Connexion OpenAI Realtime...');
    oai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OAI_MODEL}`,
      ['realtime'],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    oai.on('open', () => {
      console.log('[OAI] Connecté → session.update');
      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: buildPrompt(cfg || DEF_CFG, callerNum),
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'whisper-1', language: 'fr' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: cfg?.voix || 'coral'
            }
          }
        }
      }));
    });

    oai.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch(_) { return; }

      if (m.type === 'session.updated' && !ready) {
        ready = true;
        const accueil = cfg?.message_accueil || DEF_CFG.message_accueil;
        console.log('[OAI] Session prête → accueil:', accueil.slice(0, 60));
        for (const c of queue) {
          oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: c }));
        }
        queue = [];
        oai.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: `IMPORTANT: Prononce MAINTENANT ce message d'accueil en français, mot pour mot : "${accueil}"` }
        }));
      }

      if (m.type === 'response.output_audio.delta' && m.delta && streamSid) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: m.delta } }));
        }
      }

      if (m.type === 'response.audio_transcript.delta' && m.delta) curAss += m.delta;
      if (m.type === 'response.audio_transcript.done' && curAss) {
        transcript.push({ r: 'a', t: curAss });
        console.log(`[IA] "${curAss.slice(0, 100)}"`);
        curAss = '';
      }

      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        transcript.push({ r: 'u', t: m.transcript });
        console.log(`[USER] "${m.transcript.slice(0, 100)}"`);
        parseLeadInfo(m.transcript);
      }

      if (m.type === 'error') console.error('[OAI] Erreur:', JSON.stringify(m.error));
    });

    oai.on('error', (e) => console.error('[OAI] WS Error:', e.message));
    oai.on('close', (code) => console.log('[OAI] Fermé, code:', code));
  }

  function parseLeadInfo(text) {
    if (!lead.nom && /je m.appelle|c.est |mon nom est/i.test(text)) {
      const m = text.match(/(?:je m.appelle|c.est|mon nom est)\s+([A-ZÀ-Ý][a-zà-ý]+(?:\s+[A-ZÀ-Ý][a-zà-ý]+)*)/i);
      if (m) lead.nom = m[1];
    }
    if (!lead.besoin && /acheter|achat|vendre|vente|louer|location|estim/i.test(text)) {
      const m = text.match(/(acheter|achat|vendre|vente|louer|location|estimation)/i);
      if (m) lead.besoin = m[1];
    }
    if (!lead.ville) {
      const m = text.match(/(?:à|sur|secteur|ville de|commune de)\s+([A-ZÀ-Ý][a-zà-ý\-]+(?:\s+[A-ZÀ-Ý][a-zà-ý\-]+)*)/i);
      if (m) lead.ville = m[1];
    }
    if (!lead.prix) {
      const m = text.match(/(\d[\d\s]*(?:euros?|€|k€|000))/i);
      if (m) lead.prix = m[1];
    }
  }

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch(_) { return; }

    if (m.event === 'start') {
      streamSid    = m.start?.streamSid || '';
      const params = m.start?.customParameters || {};
      const caller = params.caller || params.From || m.start?.from || '';
      const to     = params.to     || params.To   || m.start?.to   || '';
      console.log(`[WS] START streamSid:${streamSid} caller=${caller} to=${to}`);
      lead.tel = caller ? caller.replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ').trim() : 'Inconnu';
      cfg = getConfig(to || '');
      connectOAI(lead.tel);
      callTimer = setTimeout(() => { console.log('[TIMER] 2min → raccrocher'); hangup(); }, 120000);
    }
    else if (m.event === 'media' && m.media?.payload) {
      if (oai && oai.readyState === WebSocket.OPEN && ready) {
        oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
      } else if (oai) {
        queue.push(m.media.payload);
      }
    }
    else if (m.event === 'stop') {
      console.log(`[WS] STOP — ${transcript.length} échanges`);
      await flush();
    }
  });

  ws.on('close', async () => { console.log('[WS] Connexion fermée'); await flush(); });
  ws.on('error', (e) => console.error('[WS] Erreur:', e.message));
});

const PORT = process.env.PORT || 8080;

// ─── Route OTP Admin ────────────────────────────────────────────────────────
app.post('/send-otp', express.json(), async (req, res) => {
  const { to, code, expiry } = req.body;
  if (!to || !code) return res.status(400).json({ error: 'Paramètres manquants' });
  log('INFO', `[OTP] Envoi code ${code} vers ${to}`);
  try {
    const accessToken = await getGmailAccessToken();
    const html = `<div style="font-family:sans-serif;max-width:400px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;">
      <h2 style="color:#4f46e5;">⚡ Voxzen Admin</h2>
      <p>Votre code de connexion :</p>
      <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#111;text-align:center;padding:16px;background:#f3f4f6;border-radius:8px;">${code}</div>
      <p style="color:#6b7280;font-size:13px;">Valide jusqu'à ${expiry} — Ne partagez pas ce code.</p>
    </div>`;
    const raw = [
      `From: Voxzen Admin <${GMAIL_FROM}>`,
      `To: ${to}`,
      `Subject: Code OTP Voxzen Admin — ${code}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      html
    ].join('\r\n');
    const encoded = Buffer.from(raw).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded })
    });
    if (gmailRes.ok) {
      log('INFO', `[OTP] ✅ Code envoyé à ${to}`);
      res.json({ ok: true });
    } else {
      const err = await gmailRes.text();
      log('ERROR', `[OTP] Gmail error: ${err}`);
      res.status(500).json({ error: err });
    }
  } catch(e) {
    log('ERROR', `[OTP] Échec: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v36-otp-fix sur port ${PORT}`));
