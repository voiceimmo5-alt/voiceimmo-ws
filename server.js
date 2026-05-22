'use strict';
const http      = require('http');
const express   = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

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
const OAI_MODEL = process.env.OAI_MODEL || 'gpt-4o-realtime-preview';
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
app.get('/', (req, res) => res.json({ status: 'ok', version: 'v31-prod', service: 'VoiceImmo WS' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  const hasKey = !!OPENAI_API_KEY;
  let oaiOk = false;
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    oaiOk = r.ok;
  } catch(_) {}
  res.json({ version: 'v31-prod', hasOAI: hasKey, oaiOk, node: process.version });
});

app.get('/logs', (req, res) => {
  const n = parseInt(req.query.n || '50');
  const since = parseInt(req.query.since || '0');
  const logs = LOG_BUFFER.filter(l => l.ts > since).slice(-n);
  res.json({ logs, serverTime: Date.now(), version: 'v31-prod' });
});


app.get('/model-check', (req, res) => res.json({ 
  model: `wss://api.openai.com/v1/realtime?model=${OAI_MODEL}`,
  version: 'v31-prod',
  build: 'force-rebuild-001'
}));
app.get('/stats', async (req, res) => {
  let oaiOk = false;
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    oaiOk = r.ok;
  } catch(_) {}
  res.json({
    ok: true,
    version: 'v31-prod',
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
      `wss://api.openai.com/v1/realtime?model=${OAI_MODEL}`,
      ['realtime'],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    oai.on('open', () => {
      console.log('[OAI] Connecté → session.update');
      const accueil = cfg?.message_accueil || DEF_CFG.message_accueil;
      const voix    = cfg?.voix || 'coral';

      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: buildPrompt(cfg || DEF_CFG, callerNum),
          voice: voix,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1', language: 'fr' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 },
          temperature: 0.7,
          max_response_output_tokens: 200,
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
            modalities: ['text', 'audio'],
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

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v31-prod sur port ${PORT}`));
