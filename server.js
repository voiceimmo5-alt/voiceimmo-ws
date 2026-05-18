'use strict';
const http      = require('http');
const express   = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT            = process.env.PORT || 8080;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || '';
const BASE44_SERVICE_TOKEN = process.env.BASE44_SERVICE_TOKEN || '';
const BASE44_API_URL  = process.env.BASE44_API_URL || 'https://fr-2758ee0c.base44.app';
const SERVER_URL      = process.env.SERVER_URL || '';
const NODE_ENV        = process.env.NODE_ENV || 'production';
const VERSION         = 'v30-stable';

// ─── Logger circulaire ────────────────────────────────────────────────────
const LOG_BUFFER = [];
function pushLog(level, ...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  LOG_BUFFER.push({ ts: Date.now(), level, msg });
  if (LOG_BUFFER.length > 200) LOG_BUFFER.shift();
  console[level === 'error' ? 'error' : 'log'](msg);
}

// ─── Config fallback Leone Immobilier ────────────────────────────────────
const DEF_CFG = {
  nom_agence: 'LEONE IMMOBILIER',
  client_db_id: '6a03042d6c4e45eec21bedd5',
  voix: 'coral',
  message_accueil: "Bonjour et bienvenue à l'agence Leone immobilier, comment puis-je vous aider ?",
  agents_arr: [
    { nom: 'Luca',  email: 'leone.immobilier@gmail.com',     zones: 'givors, irigny, st genis laval, corbas, oullins, pierre-benite' },
    { nom: 'Kenny', email: 'kenny.leoneimmobilier@gmail.com', zones: 'villette de vienne, vienne, roussillon' },
    { nom: 'Jeff',  email: 'jeff.leoneimmobilier@gmail.com',  zones: 'villefontaine, nord rhone, beaujolais' }
  ],
  destinataires_email: 'leone.immobilier@gmail.com',
  numero_actuel: '+33939245959',
};

// ─── Construire le prompt système ────────────────────────────────────────
function buildPrompt(cfg, callerNum) {
  const agentsDesc = (cfg.agents_arr || [])
    .map(a => `- ${a.nom} (${a.zones || 'toutes zones'}) : ${a.email}`)
    .join('\n');

  return `Tu es Sophie, assistante virtuelle de ${cfg.nom_agence}. Tu réponds uniquement en français, de façon chaleureuse et professionnelle.

L'appelant téléphone depuis le numéro ${callerNum || 'inconnu'}.

Ton rôle :
1. Accueillir l'appelant chaleureusement
2. Comprendre son besoin (achat, vente, location, estimation, renseignements)
3. Collecter ses informations : nom complet, numéro de téléphone de rappel
4. Pour les biens : ville, prix approximatif, référence de l'annonce si disponible
5. Identifier l'agent responsable de sa zone géographique
6. Confirmer qu'un agent le rappellera très prochainement

Agents et leurs zones :
${agentsDesc}

Règles importantes :
- Parle de façon naturelle et conversationnelle, comme au téléphone
- Sois concise et claire
- Si tu ne connais pas la zone, oriente vers l'agence principale
- Ne prends pas de rendez-vous toi-même, dis qu'un agent rappellera
- Termine toujours par confirmer les informations recueillies

Message d'accueil : ${cfg.message_accueil}`;
}

// ─── Charger config client depuis Base44 ─────────────────────────────────
async function getConfig(numTwilio) {
  try {
    const url = `${BASE44_API_URL}/api/entities/Client?filter=${encodeURIComponent(JSON.stringify({ numero_actuel: numTwilio }))}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}` }
    });
    if (!res.ok) throw new Error(`Base44 ${res.status}`);
    const data = await res.json();
    const client = Array.isArray(data) ? data[0] : (data.results?.[0] || null);
    if (!client) {
      pushLog('info', `[CFG] Aucun client pour ${numTwilio} → fallback`);
      return DEF_CFG;
    }

    let agents_arr = DEF_CFG.agents_arr;
    try {
      const arr = typeof client.agents === 'string' ? JSON.parse(client.agents) : client.agents;
      if (Array.isArray(arr) && arr.length > 0) agents_arr = arr;
    } catch(_) {}

    const VMAP = { coral:'coral', shimmer:'shimmer', alloy:'alloy', echo:'echo', verse:'verse', ash:'ash', sage:'sage', ballad:'ballad' };
    const voix = VMAP[(client.voix||'coral').toLowerCase()] || 'coral';

    pushLog('info', `[CFG] Config chargée: ${client.nom_entreprise}`);
    return {
      nom_agence:         client.nom_entreprise || DEF_CFG.nom_agence,
      client_db_id:       client.id             || DEF_CFG.client_db_id,
      voix,
      message_accueil:    client.message_accueil || DEF_CFG.message_accueil,
      agents_arr,
      destinataires_email: client.destinataires_email || DEF_CFG.destinataires_email,
      numero_actuel:      numTwilio,
    };
  } catch(e) {
    pushLog('error', `[CFG] Erreur chargement config: ${e.message} → fallback`);
    return DEF_CFG;
  }
}

// ─── Incrémenter compteur d'appels ───────────────────────────────────────
async function incrAppels(clientDbId) {
  try {
    const url = `${BASE44_API_URL}/api/entities/Client/${clientDbId}`;
    const r1  = await fetch(url, { headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}` } });
    const cur = await r1.json();
    const nb  = (cur.appels_mois || 0) + 1;
    await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appels_mois: nb, appels_total: (cur.appels_total || 0) + 1 })
    });
  } catch(e) { pushLog('error', '[CFG] incrAppels err:', e.message); }
}

// ─── Sauvegarder lead en base ─────────────────────────────────────────────
async function saveLead(lead, cfg, transcript) {
  try {
    const agent = (cfg.agents_arr || []).find(a =>
      (a.zones || '').toLowerCase().split(',').some(z =>
        z.trim() && (lead.ville || '').toLowerCase().includes(z.trim())
      )
    ) || cfg.agents_arr?.[0] || { nom: 'Agence', email: cfg.destinataires_email };

    const url = `${BASE44_API_URL}/api/entities/Lead`;
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nom:             lead.nom      || 'Inconnu',
        telephone:       lead.tel      || '',
        besoin:          lead.besoin   || '',
        ville:           lead.ville    || '',
        prix:            lead.prix     || '',
        reference:       lead.ref      || '',
        agent_initiales: agent.nom?.substring(0,2).toUpperCase() || 'AG',
        agent_nom:       agent.nom     || 'Agence',
        statut:          'nouveau',
        notes:           transcript.map(t => `${t.r==='u'?'Appelant':'Sophie'}: ${t.t}`).join('\n')
      })
    });
    pushLog('info', '[LEAD] Sauvegardé');
    return agent;
  } catch(e) { pushLog('error', '[LEAD] Exception:', e.message); return null; }
}

// ─── Envoyer email de notification ───────────────────────────────────────
async function sendEmail(lead, cfg, agent) {
  try {
    const url = `${BASE44_API_URL}/functions/sendLeadEmail`;
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BASE44_SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead, cfg, agent })
    });
    pushLog('info', '[EMAIL] Envoyé');
  } catch(e) { pushLog('error', '[EMAIL] err:', e.message); }
}

// ─── Routes HTTP ─────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', version: VERSION, service: 'VoiceImmo WS' }));

app.get('/version', (req, res) => res.json({ version: VERSION, serverUrl: SERVER_URL, env: NODE_ENV }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  const hasKey = !!OPENAI_API_KEY;
  let oaiOk = false;
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    oaiOk = r.ok;
  } catch(_) {}
  res.json({ version: VERSION, hasOAI: hasKey, oaiOk, node: process.version });
});

app.get('/logs', (req, res) => {
  const n = parseInt(req.query.n || '50');
  const since = parseInt(req.query.since || '0');
  const logs = LOG_BUFFER.filter(l => l.ts > since).slice(-n);
  res.json({ logs, serverTime: Date.now(), version: VERSION });
});

// ─── TwiML — génère le flux WebSocket ────────────────────────────────────
app.post('/twiml', (req, res) => {
  const to     = (req.body?.To || req.query?.To || '').replace(/\s/g,'');
  const from   = (req.body?.From || req.query?.From || '');
  const callSid = req.body?.CallSid || '';
  const wsUrl  = SERVER_URL ? `wss://${SERVER_URL}` : `wss://${req.headers.host}`;

  pushLog('info', `[TWIML] Appel entrant: ${from} → ${to} | wsUrl: ${wsUrl}`);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${from}" />
      <Parameter name="to" value="${to}" />
      <Parameter name="sid" value="${callSid}" />
    </Stream>
  </Connect>
</Response>`);
});

// ─── WebSocket Handler ────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  pushLog('info', '[WS] Nouvelle connexion');

  let streamSid = '';
  let callSid   = '';
  let oai       = null;
  let ready     = false;
  let queue     = [];
  let cfg       = DEF_CFG;
  let callTimer = null;
  let lead      = { nom: '', tel: '', besoin: '', ville: '', prix: '', ref: '' };
  let transcript = [];

  function hangup() {
    pushLog('info', '[WS] Hangup');
    try { ws.close(); } catch(_) {}
    try { oai?.close(); } catch(_) {}
    if (callTimer) clearTimeout(callTimer);
  }

  async function flush() {
    if (!oai || oai.readyState !== WebSocket.OPEN) return;
    while (queue.length) {
      oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: queue.shift() }));
    }
  }

  function connectOAI(callerNum) {
    pushLog('info', '[OAI] Connexion OpenAI Realtime...');
    oai = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      [],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    oai.on('open', () => {
      pushLog('info', '[OAI] Connecté → session.update');
      const prompt = buildPrompt(cfg, callerNum);
      const voix   = cfg?.voix || 'coral';

      // Format OpenAI Realtime API GA (correct)
      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          voice: voix,
          instructions: prompt,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800
          },
          max_response_output_tokens: 300
        }
      }));

      // Déclencher le message d'accueil
      const accueil = cfg?.message_accueil || DEF_CFG.message_accueil;
      oai.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Commence par dire exactement : "${accueil}"` }]
        }
      }));
      oai.send(JSON.stringify({ type: 'response.create' }));
    });

    oai.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch(_) { return; }

      const t = m.type || '';

      if (t === 'session.created' || t === 'session.updated') {
        pushLog('info', `[OAI] ${t}`);
        ready = true;
        flush();
      }

      // Audio vers Twilio
      if (t === 'response.audio.delta' && m.delta && streamSid) {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: m.delta }
        }));
      }

      // Transcription appelant
      if (t === 'conversation.item.input_audio_transcription.completed') {
        const txt = m.transcript?.trim();
        if (txt) {
          pushLog('info', `[USR] ${txt}`);
          transcript.push({ r: 'u', t: txt });
          const lo = txt.toLowerCase();

          // Extraire infos lead
          const nomM = lo.match(/(?:je m'appelle|je suis|c'est|mon nom est)\s+([a-zéèêëàâùûîïôœçæ\- ]{2,30})/i);
          if (nomM) lead.nom = nomM[1].trim();

          const telM = txt.match(/(?:0|\+33)[1-9][\s.]?(?:\d[\s.]?){8}/);
          if (telM) lead.tel = telM[0].replace(/[\s.]/g,'');

          const villeM = lo.match(/(?:à|sur|dans|secteur|quartier|commune de)\s+([a-zéèêëàâùûîïôœçæ\- ]{2,25})/i);
          if (villeM) lead.ville = villeM[1].trim();

          const prixM = txt.match(/(\d[\d\s]*(?:000|k|K|€))/);
          if (prixM) lead.prix = prixM[1].trim();

          const refM = txt.match(/(?:référence|ref|réf)[:\s#]+([A-Za-z0-9\-]+)/i);
          if (refM) lead.ref = refM[1].trim();
        }
      }

      // Transcription assistant
      if (t === 'response.audio_transcript.delta') {
        const txt = m.delta?.trim();
        if (txt) transcript.push({ r: 'a', t: txt });
      }

      // Fin de réponse
      if (t === 'response.done') {
        pushLog('info', '[OAI] Réponse terminée');
        // Vérifier si l'appelant a raccroché
        const lastAssistant = transcript.filter(t => t.r === 'a').pop();
        if (lastAssistant && /au revoir|bonne journée|bonne soirée|à bientôt/i.test(lastAssistant.t)) {
          setTimeout(hangup, 3000);
        }
      }

      if (t === 'error') {
        pushLog('error', '[OAI] Erreur:', JSON.stringify(m.error));
      }
    });

    oai.on('error', (e) => {
      pushLog('error', '[OAI] WS error:', e.message);
    });

    oai.on('close', (code, reason) => {
      pushLog('info', `[OAI] Fermé: ${code}`);
      ready = false;
      if (code !== 1000 && code !== 1001) {
        pushLog('error', '[OAI] Fermeture inattendue → hangup');
        hangup();
      }
    });
  }

  // ─── Handler messages Twilio ────────────────────────────────────────────
  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch(_) { return; }

    try {
      if (m.event === 'connected') {
        pushLog('info', '[WS] Event: connected');
      }

      else if (m.event === 'start') {
        streamSid = m.start?.streamSid || '';
        const params = m.start?.customParameters || {};
        const caller = params.caller || '';
        const to     = params.to     || '';
        callSid      = params.sid    || m.start?.callSid || '';

        pushLog('info', `[WS] START streamSid:${streamSid} caller:${caller} to:${to}`);

        // Formater le numéro pour lecture
        lead.tel = caller.replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ').trim();

        // Charger config client
        cfg = await getConfig(to || '');

        // Démarrer OAI
        connectOAI(lead.tel);

        // Timer 2 minutes max
        callTimer = setTimeout(() => {
          pushLog('info', '[TIMER] 2min → raccrocher');
          hangup();
        }, 120000);
      }

      else if (m.event === 'media' && m.media?.payload) {
        if (oai && oai.readyState === WebSocket.OPEN && ready) {
          oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
        } else {
          queue.push(m.media.payload);
        }
      }

      else if (m.event === 'stop') {
        pushLog('info', '[WS] STOP reçu');
        if (lead.nom || lead.tel) {
          const agent = await saveLead(lead, cfg, transcript);
          await sendEmail(lead, cfg, agent);
          if (cfg.client_db_id) await incrAppels(cfg.client_db_id);
        }
        hangup();
      }
    } catch(err) {
      pushLog('error', '[WS] Handler error:', err.message, err.stack?.split('\n')[1]);
    }
  });

  ws.on('close', () => {
    pushLog('info', '[WS] Client déconnecté');
    if (callTimer) clearTimeout(callTimer);
    try { oai?.close(); } catch(_) {}
  });

  ws.on('error', (e) => pushLog('error', '[WS] Erreur:', e.message));
});

// ─── Démarrage ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  pushLog('info', `[START] VoiceImmo WS ${VERSION} sur port ${PORT} (env:${NODE_ENV})`);
});
