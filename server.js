'use strict';
const http      = require('http');
const express   = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const https_mod = require('https');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── Stripe Webhook — raw body AVANT express.json() ───────────────────────
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY     || '';

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  // ── Vérifier la signature Stripe ──────────────────────────────────────
  try {
    event = verifyStripeSignature(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[STRIPE] ❌ Signature invalide:', err.message);
    return res.status(400).send('Webhook signature invalide');
  }

  console.log('[STRIPE] Event reçu:', event.type);

  try {
    if (event.type === 'invoice.payment_succeeded') {
      await handlePaymentSucceeded(event.data.object);
    } else if (event.type === 'invoice.payment_failed') {
      await handlePaymentFailed(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object);
    }
  } catch (err) {
    console.error('[STRIPE] ❌ Erreur traitement event:', err.message);
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ─── Buffer de logs circulaire (100 dernières lignes) ────────────────────────
const LOG_BUFFER = [];
const MAX_LOGS = 100;
const origConsoleLog = console.log;
const origConsoleError = console.error;
function pushLog(level, args) {
  const line = { ts: Date.now(), level, msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') };
  LOG_BUFFER.push(line);
  if (LOG_BUFFER.length > MAX_LOGS) LOG_BUFFER.shift();
}
console.log   = (...a) => { origConsoleLog(...a);   pushLog('info',  a); };
console.error = (...a) => { origConsoleError(...a); pushLog('error', a); };

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || '';
const BASE44_SERVICE_TOKEN = process.env.BASE44_SERVICE_TOKEN || '';
const BASE44_API_URL     = process.env.BASE44_API_URL || 'https://fr-2758ee0c.base44.app';

// ─── Config Leone Immobilier (fallback hardcodé) ──────────────────────────
const DEF_CFG = {
  nom_agence: 'LEONE IMMOBILIER',
  client_db_id: '6a0cdf1388a8c7697ae8a452', // ID prod Leone Immobilier
  voix: 'coral',
  message_accueil: "Bonjour et bienvenue à l'agence Leone immobilier, comment puis-je vous aider ?",
  agents_arr: [
    { nom: 'Luca',  email: 'leone.immobilier@gmail.com',      zones: 'givors, irigny, st genis laval, corbas, oullins, pierre-benite' },
    { nom: 'Kenny', email: 'kenny.leoneimmobilier@gmail.com',  zones: 'villette de vienne, vienne, roussillon' },
    { nom: 'Jeff',  email: 'jeff.leoneimmobilier@gmail.com',   zones: 'villefontaine, nord rhone, beaujolais' }
  ],
  destinataires_email: 'leone.immobilier@gmail.com',
  numero_actuel: '+33939245959',
};

// ─── Raccrocher via Twilio REST API ──────────────────────────────────────────
async function hangupCall(callSid) {
  if (!callSid || callSid === 'unknown' || !TWILIO_ACCOUNT_SID) return;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = 'Status=completed';
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const https = require('https');
    await new Promise((resolve) => {
      const req = https.request(url, { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
    console.log('[TWILIO] Appel raccroché:', callSid);
  } catch(e) { console.error('[TWILIO] Erreur hangup:', e.message); }
}

// ─── Charger config client depuis Base44 ─────────────────────────────────
async function getConfig(numTwilio) {
  try {
    const filterStr = encodeURIComponent(JSON.stringify({numero_actuel: numTwilio}));
    const url = `${BASE44_API_URL}/api/entities/Client?filter=${filterStr}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}` }
    });
    if (!res.ok) throw new Error(`Base44 ${res.status}`);
    const data = await res.json();
    const client = Array.isArray(data) ? data[0] : (data.results?.[0] || null);
    if (!client) return DEF_CFG;

    let agents_arr = DEF_CFG.agents_arr;
    try {
      const arr = typeof client.agents === 'string' ? JSON.parse(client.agents) : client.agents;
      if (Array.isArray(arr) && arr.length > 0) agents_arr = arr;
    } catch(_) {}

    const VMAP = { coral:'coral', shimmer:'shimmer', alloy:'alloy', echo:'echo', verse:'verse', ash:'ash', sage:'sage', ballad:'ballad' };
    const voix = VMAP[(client.voix||'coral').toLowerCase()] || 'coral';

    return {
      nom_agence: client.nom_entreprise || DEF_CFG.nom_agence,
      client_db_id: client.id || DEF_CFG.client_db_id,
      voix,
      message_accueil: client.message_accueil || DEF_CFG.message_accueil,
      agents_arr,
      destinataires_email: client.destinataires_email || DEF_CFG.destinataires_email,
      numero_actuel: numTwilio,
    };
  } catch(e) {
    console.error('[CFG] Erreur chargement config:', e.message, '→ fallback');
    return DEF_CFG;
  }
}

// ─── Incrémenter compteur d'appels ────────────────────────────────────────
async function incrAppels(clientDbId) {
  try {
    const url = `${BASE44_API_URL}/api/entities/Client/${clientDbId}`;
    // D'abord récupérer la valeur actuelle
    const r1 = await fetch(url, { headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}` } });
    const cur = await r1.json();
    const nb = (cur.appels_mois || 0) + 1;
    await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appels_mois: nb, appels_total: (cur.appels_total||0)+1 })
    });
    console.log(`[CFG] Appels incrémentés → ${nb}`);
  } catch(e) { console.error('[CFG] incrAppels err:', e.message); }
}

// ─── Sauvegarder lead ─────────────────────────────────────────────────────
async function saveLead(lead, cfg, transcript) {
  console.log('[LEAD] Tentative sauvegarde:', JSON.stringify({nom:lead.nom, tel:lead.tel, besoin:lead.besoin}));
  try {
    const url = `${BASE44_API_URL}/api/entities/Lead`;
    const body = {
      nom: lead.nom || 'Inconnu',
      telephone: lead.tel || '',
      besoin: lead.besoin || '',
      agent_initiales: lead.agent || '',
      agent_nom: lead.agentNom || '',
      statut: 'nouveau',
      notes: `client_id:${(cfg.client_db_id||'').toLowerCase()}\nVille: ${lead.ville||''} | Prix: ${lead.prix||''} | Ref: ${lead.ref||''}\n---\n` +
             transcript.map(t => `${t.r==='a'?'Sophie':'Appelant'}: ${t.t}`).join('\n')
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) console.log('[LEAD] ✅ Lead sauvegardé');
    else console.error('[LEAD] Erreur save:', res.status, await res.text());
  } catch(e) { console.error('[LEAD] Exception:', e.message); }
}

// ─── Envoyer email via Base44 Gmail function ──────────────────────────────
async function sendEmail(lead, cfg) {
  try {
    const url = `${BASE44_API_URL}/functions/sendLeadEmail`;
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead, cfg })
    });
    console.log('[EMAIL] ✅ Email envoyé');
  } catch(e) { console.error('[EMAIL] err:', e.message); }
}

// ─── Endpoints HTTP ───────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', version: 'v26-ga-api', service: 'VoiceImmo WS' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  const hasKey = !!OPENAI_API_KEY;
  let oaiOk = false;
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    oaiOk = r.ok;
  } catch(_) {}
  res.json({ version: 'v26-ga-api', hasOAI: hasKey, oaiOk, node: process.version });
});

app.get('/logs', (req, res) => {
  const n = parseInt(req.query.n || '50');
  const since = parseInt(req.query.since || '0');
  const logs = LOG_BUFFER.filter(l => l.ts > since).slice(-n);
  res.json({ logs, serverTime: Date.now(), version: 'v26-ga-api' });
});

app.get('/stats', async (req, res) => {
  let oaiOk = false;
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    oaiOk = r.ok;
  } catch(_) {}
  res.json({
    ok: true,
    version: 'v26-ga-api',
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    oaiOk,
    node: process.version,
    serverTime: Date.now(),
    activeConnections: wss.clients.size,
  });
});

app.post('/twiml', (req, res) => {
  const caller = req.body.From || req.body.Caller || '';
  const to     = req.body.To   || req.body.Called || '';
  const sid    = req.body.CallSid || '';
  console.log(`[TWIML] From:${caller} To:${to} Sid:${sid}`);

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://voiceimmo-ws-production.up.railway.app">
      <Parameter name="caller" value="${caller}" />
      <Parameter name="to" value="${to}" />
      <Parameter name="sid" value="${sid}" />
    </Stream>
  </Connect>
</Response>`);
});

// ─── WebSocket Handler (Twilio Media Streams) ─────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] ✅ Connexion depuis', req.socket.remoteAddress);

  let streamSid = '';
  let oai       = null;
  let ready     = false;
  let queue     = [];
  let transcript = [];
  let curAss    = '';
  let lead      = { nom:'', tel:'', besoin:'', agent:'', agentNom:'', ville:'', prix:'', ref:'' };
  let cfg       = null;
  let saved     = false;
  let callTimer = null;
  let callSid = 'unknown';

  // ─── Raccrocher proprement ──────────────────────────────────────────────
  function hangup() {
    if (callTimer) { clearTimeout(callTimer); callTimer = null; }
    if (oai && oai.readyState === WebSocket.OPEN) oai.close();
  }

  // ─── Flush lead à la fin de l'appel ────────────────────────────────────
  async function flush() {
    if (saved) return; saved = true;
    hangup();
    if (cfg) { // on sauvegarde même sans numéro
      await saveLead(lead, cfg, transcript);
      await sendEmail(lead, cfg);
      await incrAppels(cfg.client_db_id);
    }
  }

  // ─── Connecter OpenAI Realtime ──────────────────────────────────────────
  function connectOAI(callerNum) {
    console.log('[OAI] Connexion OpenAI Realtime...');
    oai = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime',
      ['realtime'],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`,  } }
    );

    oai.on('open', () => {
      console.log('[OAI] Connecté → session.update');
      const accueil = cfg?.message_accueil || DEF_CFG.message_accueil;
      const voix    = cfg?.voix || 'coral';

      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: buildPrompt(cfg || DEF_CFG, callerNum),
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: voix
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

        // Drainer queue audio Twilio reçu avant que OAI soit prêt
        for (const c of queue) {
          oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: c }));
        }
        queue = [];

        // Forcer Sophie à parler en premier
        oai.send(JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `IMPORTANT: Prononce MAINTENANT ce message d'accueil en français, mot pour mot : "${accueil}"`,
          }
        }));
      }

      // Audio généré par OAI → renvoyer à Twilio
      if (m.type === 'response.audio.delta' && m.delta && streamSid) {
        if (ws.readyState === 1) { // 1 = OPEN
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: m.delta }
          }));
        }
      }

      // Transcription réponse Sophie
      if (m.type === 'response.audio_transcript.delta' && m.delta) curAss += m.delta;
      if (m.type === 'response.audio_transcript.done' && curAss) {
        transcript.push({ r: 'a', t: curAss });
        console.log(`[IA] "${curAss.slice(0, 100)}"`);
        // Raccrocher si Sophie dit "à très bientôt" (fin de conversation)
        if (/bient.t/i.test(curAss)) {
          console.log('[IA] Fin détectée → raccrocher dans 3s');
          setTimeout(() => { hangupCall(callSid); flush(); }, 3000);
        }
        curAss = '';
      }

      // Transcription appelant
      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        transcript.push({ r: 'u', t: m.transcript });
        console.log(`[USER] "${m.transcript.slice(0, 100)}"`);
        parseLeadInfo(m.transcript);
      }

      if (m.type === 'error') {
        console.error('[OAI] Erreur:', JSON.stringify(m.error));
      }
    });

    oai.on('error', (e) => console.error('[OAI] WS Error:', e.message));
    oai.on('close', (code) => console.log('[OAI] Fermé, code:', code));
  }

  // ─── Parser les infos du lead depuis la transcription ──────────────────
  function parseLeadInfo(text) {
    const t = text.toLowerCase();
    // Basique — le vrai parsing est fait par le LLM dans le transcript
    if (!lead.nom && /je m.appelle|c.est |mon nom est/i.test(t)) {
      const m = text.match(/(?:je m.appelle|c.est|mon nom est)\s+([A-ZÀ-Ý][a-zà-ý]+(?:\s+[A-ZÀ-Ý][a-zà-ý]+)*)/i);
      if (m) lead.nom = m[1];
    }
  }

  // ─── Prompt Sophie ────────────────────────────────────────────────────────
  function buildPrompt(c, callerNum) {
    const agentsStr = (c.agents_arr||[]).map(a => `• ${a.nom} → ${a.zones}`).join('\n');
    return `Tu es Sophie, assistante vocale de l'agence ${c.nom_agence}.
LANGUE : FRANÇAIS UNIQUEMENT. Jamais d'anglais.
RÈGLES ABSOLUES :
- Tu ne recommandes aucune autre plateforme (SeLoger, LeBonCoin, etc.)
- Tu ne donnes pas de conseils juridiques ou financiers
- Tu collectes les informations suivantes dans cet ordre :
  1. Ville / secteur du bien
  2. Budget
  3. Prénom et nom de l'appelant
  4. Confirmer le numéro (${callerNum})
- Après collecte : "Merci, un agent va vous rappeler rapidement. Au revoir !"

AGENTS ET ZONES :
${agentsStr}

Site web : ${c.site_internet || 'https://www.leone-immobilier.fr'}
Numéro de l'appelant : ${callerNum}`;
  }

  // ─── Handler messages Twilio ──────────────────────────────────────────────
  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch(_) { return; }

    if (m.event === 'connected') {
      console.log('[WS] Event: connected');
    }

    else if (m.event === 'start') {
      streamSid    = m.start?.streamSid || '';
      const params = m.start?.customParameters || {};
      // Récupérer caller depuis plusieurs sources possibles
      const caller = params.caller || params.From || m.start?.from || '';
      const to     = params.to     || params.To   || m.start?.to   || '';
      callSid      = params.sid    || m.start?.callSid || '';

      console.log(`[WS] START streamSid:${streamSid} caller=${caller} to=${to} params=${JSON.stringify(params)}`);

      // Format numéro appelant pour lecture
      lead.tel = caller ? caller.replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ').trim() : 'Inconnu';

      // Charger config client
      cfg = await getConfig(to || '');
      console.log(`[CFG] Config chargée: ${cfg.nom_agence}`);

      // Démarrer OAI
      connectOAI(lead.tel);

      // Timer 2 minutes max
      callTimer = setTimeout(() => {
        console.log('[TIMER] 2min écoulées → raccrocher');
        hangup();
      }, 120000);
    }

    else if (m.event === 'media' && m.media?.payload) {
      const b64 = m.media.payload;
      if (oai && oai.readyState === WebSocket.OPEN && ready) {
        oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
      } else if (oai) {
        queue.push(b64);
      }
    }

    else if (m.event === 'stop') {
      console.log(`[WS] STOP — ${transcript.length} échanges`);
      await flush();
    }
  });

  ws.on('close', async () => {
    console.log('[WS] Connexion fermée');
    await flush();
  });

  ws.on('error', (e) => console.error('[WS] Erreur:', e.message));
});


// ══════════════════════════════════════════════════════════════════════════════
// ─── STRIPE — Fonctions utilitaires ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Vérification signature Stripe (sans SDK — crypto natif Node)
function verifyStripeSignature(payload, sigHeader, secret) {
  const crypto = require('crypto');
  if (!sigHeader || !secret) throw new Error('Signature ou secret manquant');
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) throw new Error('Format signature invalide');
  // Tolérance 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) throw new Error('Timestamp trop ancien');
  const signed = `${ts}.${payload.toString()}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  if (expected !== v1) throw new Error('Signature ne correspond pas');
  return JSON.parse(payload.toString());
}

// Appel API Stripe REST
async function stripeRequest(method, path, params) {
  return new Promise((resolve, reject) => {
    const body = params ? new URLSearchParams(params).toString() : '';
    const opts = {
      hostname: 'api.stripe.com',
      path: `/v1/${path}`,
      method,
      headers: {
        'Authorization': `Basic ${Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https_mod.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Trouver le client Voxzen par stripe_customer_id
async function findClientByStripeId(stripeCustomerId) {
  const r = await base44Request('filter', 'Client', { stripe_customer_id: stripeCustomerId });
  return r?.records?.[0] || null;
}

// Appel Base44 API
async function base44Request(action, entity, query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, entity, ...query });
    const opts = {
      hostname: BASE44_API_URL.replace('https://', '').replace('http://', '').split('/')[0],
      path: '/api/entities',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BASE44_SERVICE_TOKEN}`,
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https_mod.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Envoyer email via Resend
async function sendStripeEmail(to, subject, html) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
  return new Promise((resolve) => {
    const body = JSON.stringify({
      from: 'Voxzen <facturation@voxzen.io>',
      to: Array.isArray(to) ? to : [to],
      cc: ['voiceimmo5@gmail.com'],
      subject,
      html,
    });
    const opts = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https_mod.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { console.log('[EMAIL]', subject, '→', to); resolve(d); });
    });
    req.on('error', e => { console.error('[EMAIL] Erreur:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Suspendre/Réactiver le numéro Twilio d'un client
async function setTwilioNumberStatus(phoneNumber, suspended) {
  // Rediriger vers un TwiML de suspension ou restaurer le webhook normal
  const suspendUrl = 'https://voiceimmo-ws-staging.railway.app/twiml-suspended';
  const activeUrl  = 'https://voiceimmo-ws-staging.railway.app/twiml';
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json`;
  // Chercher le SID du numéro
  const listUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`;
  return new Promise((resolve) => {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const req = https_mod.request(listUrl, { method: 'GET', headers: { 'Authorization': `Basic ${auth}` } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', async () => {
        try {
          const data = JSON.parse(d);
          const num = data.incoming_phone_numbers?.[0];
          if (!num) { console.warn('[TWILIO] Numéro non trouvé:', phoneNumber); return resolve(false); }
          // Modifier le webhook voice
          const updateUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${num.sid}.json`;
          const body = `VoiceUrl=${encodeURIComponent(suspended ? suspendUrl : activeUrl)}`;
          const r2 = https_mod.request(updateUrl, {
            method: 'POST',
            headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
          }, (res2) => { res2.resume(); res2.on('end', () => resolve(true)); });
          r2.on('error', () => resolve(false));
          r2.write(body);
          r2.end();
        } catch(e) { console.error('[TWILIO] Erreur:', e.message); resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// ─── Handlers événements Stripe ───────────────────────────────────────────────

async function handlePaymentSucceeded(invoice) {
  console.log('[STRIPE] ✅ Paiement réussi — customer:', invoice.customer);
  const client = await findClientByStripeId(invoice.customer);
  if (!client) { console.warn('[STRIPE] Client non trouvé pour customer:', invoice.customer); return; }

  // Calculer nouvelle date de fin (+1 mois depuis aujourd'hui ou depuis date_fin actuelle)
  const base = client.date_fin_abonnement && new Date(client.date_fin_abonnement) > new Date()
    ? new Date(client.date_fin_abonnement) : new Date();
  base.setMonth(base.getMonth() + 1);
  const newEndDate = base.toISOString().slice(0, 10);

  // Mettre à jour en base
  await base44Request('update', 'Client', { id: client.id, data: {
    date_fin_abonnement: newEndDate,
    statut: 'Actif',
    date_suppression: null,
    stripe_payment_status: 'ok',
    stripe_last_payment: new Date().toISOString().slice(0, 10),
  }});

  // Réactiver Twilio si suspendu
  if (client.numero_actuel && client.statut !== 'Actif') {
    await setTwilioNumberStatus(client.numero_actuel, false);
  }

  // Email confirmation + facture
  const montant = (invoice.amount_paid / 100).toFixed(2).replace('.', ',');
  const nomClient = (client.prenom + ' ' + client.nom).trim() || client.nom_entreprise;
  await sendStripeEmail(
    client.email,
    `✅ Renouvellement confirmé — Voxzen ${client.plan}`,
    `<div style="font-family:sans-serif;max-width:600px;margin:auto">
      <h2 style="color:#6366f1">✅ Votre abonnement a été renouvelé</h2>
      <p>Bonjour ${nomClient},</p>
      <p>Votre abonnement <strong>Voxzen ${client.plan}</strong> a bien été renouvelé.</p>
      <table style="border-collapse:collapse;width:100%;margin:20px 0">
        <tr><td style="padding:8px;border:1px solid #e5e7eb;color:#6b7280">Montant prélevé</td><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold">${montant}€ TTC</td></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;color:#6b7280">Nouvelle date d'échéance</td><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold">${new Date(newEndDate).toLocaleDateString('fr-FR')}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;color:#6b7280">Facture</td><td style="padding:8px;border:1px solid #e5e7eb"><a href="${invoice.hosted_invoice_url || '#'}" style="color:#6366f1">Télécharger la facture</a></td></tr>
      </table>
      <p style="color:#6b7280;font-size:13px">Merci de votre confiance.<br>L'équipe Voxzen</p>
    </div>`
  );
  console.log('[STRIPE] ✅ Client mis à jour:', client.nom_entreprise, '→ fin:', newEndDate);
}

async function handlePaymentFailed(invoice) {
  console.log('[STRIPE] ❌ Paiement échoué — customer:', invoice.customer);
  const client = await findClientByStripeId(invoice.customer);
  if (!client) return;

  // Enregistrer l'échec
  await base44Request('update', 'Client', { id: client.id, data: {
    stripe_payment_status: 'failed',
    stripe_payment_failed_at: new Date().toISOString().slice(0, 10),
  }});

  const nomClient = (client.prenom + ' ' + client.nom).trim() || client.nom_entreprise;
  await sendStripeEmail(
    client.email,
    `⚠️ Échec de paiement — Voxzen ${client.plan}`,
    `<div style="font-family:sans-serif;max-width:600px;margin:auto">
      <h2 style="color:#f59e0b">⚠️ Problème de paiement</h2>
      <p>Bonjour ${nomClient},</p>
      <p>Le prélèvement automatique pour votre abonnement <strong>Voxzen ${client.plan}</strong> n'a pas pu être effectué.</p>
      <p><strong>Si le paiement n'est pas régularisé dans les 48h, votre service sera suspendu.</strong></p>
      <p>Pour mettre à jour votre moyen de paiement, contactez-nous à <a href="mailto:contact@voxzen.io">contact@voxzen.io</a>.</p>
      <p style="color:#6b7280;font-size:13px">L'équipe Voxzen</p>
    </div>`
  );
  console.log('[STRIPE] ⚠️ Email échec paiement envoyé à:', client.email);
}

async function handleSubscriptionDeleted(subscription) {
  console.log('[STRIPE] 🚫 Subscription supprimée — customer:', subscription.customer);
  const client = await findClientByStripeId(subscription.customer);
  if (!client) return;

  await base44Request('update', 'Client', { id: client.id, data: {
    statut: 'Résilié',
    date_fin_abonnement: new Date().toISOString().slice(0, 10),
    date_suppression: new Date().toISOString().slice(0, 10),
  }});

  if (client.numero_actuel) {
    await setTwilioNumberStatus(client.numero_actuel, true);
    console.log('[TWILIO] Numéro suspendu:', client.numero_actuel);
  }
}

// ─── TwiML de suspension (abonnement résilié) ─────────────────────────────────
app.post('/twiml-suspended', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-FR" voice="alice">Nous sommes désolés, ce service est actuellement suspendu. Veuillez contacter votre prestataire Voxzen pour régulariser votre abonnement.</Say>
  <Hangup/>
</Response>`);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v25-clean sur port ${PORT}`));
