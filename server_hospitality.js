/**
 * server_hospitality.js — SVIA Hospitality Voxzen
 * Serveur WebSocket Twilio Media Streams + OpenAI Realtime
 * v1.0.0 — 2026-06-22
 *
 * Architecture identique au SVIA immo, adaptée pour les hôtels :
 *  - Détection contexte hôtel (chambre, restau, bar, spa, facturation, conciergerie...)
 *  - Instructions IA multi-services
 *  - saveAppel → hospitalityAuth (Base44)
 *  - Email alerte pour demandes urgentes
 */
'use strict';

// Voix valides OpenAI Realtime GA (camille/onyx/nova/etc → coral par défaut)
const VALID_OAI_VOICES = ['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'];
function resolveVoice(v) {
  if (v && VALID_OAI_VOICES.includes(v)) return v;
  return 'coral'; // fallback féminin
}


const { createPMSConnector, pmsQuery } = require('./pms_connector');
const http    = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Logs circulaires ───────────────────────────────────────────────────────
const LOG_BUFFER = [];
const origLog = console.log;
const origError = console.error;
function pushLog(level, args) {
  const line = { ts: Date.now(), level, msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') };
  LOG_BUFFER.push(line);
  if (LOG_BUFFER.length > 200) LOG_BUFFER.shift();
}
console.log   = (...a) => { origLog(...a);   pushLog('info',  a); };
console.error = (...a) => { origError(...a); pushLog('error', a); };

// ─── Variables d'environnement ──────────────────────────────────────────────
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY    || '';
const OAI_MODEL        = process.env.OAI_MODEL         || 'gpt-4o-realtime-preview';
const BASE44_HOSP_URL  = process.env.BASE44_HOSP_URL   || 'https://fr-2758ee0c.base44.app/functions/hospitalityAuth';
const SERVER_BASE_URL  = process.env.SERVER_BASE_URL   || 'https://hospitality-ws.voiceimmo.fr';
const PORT             = parseInt(process.env.PORT     || '3001', 10);

// ─── Cache config hôtels ────────────────────────────────────────────────────
const configCache = new Map(); // numero_voxzen → { config, ts }
const CONFIG_TTL  = 5 * 60 * 1000; // 5 min

async function fetchHotelConfig(numeroVoxzen) {
  const cached = configCache.get(numeroVoxzen);
  if (cached && Date.now() - cached.ts < CONFIG_TTL) return cached.config;

  try {
    const res = await fetch(BASE44_HOSP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'get_config', numero_voxzen: numeroVoxzen }),
      signal:  AbortSignal.timeout(8000)
    });
    const data = await res.json();
    if (data.success) {
      const cfg = data.config || data;
      // Instancier le connecteur PMS selon le pms_type de l'hôtel
      cfg._pms = createPMSConnector(cfg.pms_type, cfg.pms_config || {});
      console.log(`[CFG] PMS: ${cfg._pms?.name || 'aucun'}`);
      configCache.set(numeroVoxzen, { config: cfg, ts: Date.now() });
      console.log(`[CFG] ✅ Config chargée pour ${numeroVoxzen} → ${cfg.nom_hotel}`);
      return cfg;
    }
  } catch(e) {
    console.error('[CFG] ❌ Erreur fetch config:', e.message);
  }

  // Config par défaut si hôtel non trouvé
  return {
    hotel_id: '',
    nom_hotel: 'Hôtel Voxzen',
    langue: 'fr',
    voix: 'coral',
    instructions_ia: '',
    services_actifs: ['chambre', 'restau', 'accueil', 'service'],
    pms_type: '',
    destinataires_email: [],
  };
}

// ─── Prompt système SVIA Hospitality ────────────────────────────────────────
function buildHospPrompt(cfg) {
  // Si instructions_ia personnalisées en base → les utiliser directement
  if (cfg.instructions_ia && cfg.instructions_ia.trim().length > 20) {
    // Remplacer les variables de template
    return cfg.instructions_ia
      .replace(/\(\$Nom de l'hôtel\)/g, cfg.nom_hotel || 'l\'hôtel')
      .replace(/\$nom_hotel/g, cfg.nom_hotel || 'l\'hôtel');
  }
  const services = cfg.services_actifs || [];
  const servicesList = services.map(s => {
    const labels = {
      chambre:       '- Réservation ou modification de chambre',
      confirmation:  '- Confirmation de réservation existante',
      restau:        '- Réservation restaurant ou room service',
      bar:           '- Commande bar ou boissons',
      accueil:       '- Questions générales, check-in/check-out',
      cles:          '- Accès chambre, clés, badges',
      spa:           '- Réservation spa, bien-être',
      housekeeping:  '- Service de ménage, linge, serviettes',
      transport:     '- Taxi, navette, voiturier',
      facturation:   '- Facture, paiement, questions tarifaires',
      conciergerie:  '- Conseils locaux, restaurants, activités',
      evenements:    '- Salles de réunion, séminaires, événements',
      service:       '- Service en chambre, demandes diverses',
    };
    return labels[s] || `- ${s}`;
  }).join('\n');

  const customInstr = cfg.instructions_ia?.trim()
    ? `\n\n📋 INSTRUCTIONS SPÉCIFIQUES DE L'HÔTEL :\n${cfg.instructions_ia}`
    : '';

  return `Tu es SOFIA, l'assistante vocale intelligente de ${cfg.nom_hotel}.
Tu réponds UNIQUEMENT en français, avec une voix chaleureuse, professionnelle et élégante.
Tu es disponible 24h/24, 7j/7.

🏨 TON RÔLE : Prendre en charge les demandes des clients de l'hôtel par téléphone.
Tu peux aider pour :
${servicesList}

📞 SCRIPT D'APPEL :
1. Accueille chaleureusement le client avec "Bonjour, ${cfg.nom_hotel}, Sofia à votre service."
2. Identifie son prénom et son numéro de chambre si pertinent.
3. Comprends précisément sa demande.
4. Traite la demande ou transmets-la au service approprié.
5. Confirme l'action prise et rassure le client.
6. Conclus avec "Je vous souhaite une excellente journée / soirée, au revoir."

📌 EXTRACTION AUTOMATIQUE :
À chaque appel, tu DOIS identifier et structurer ces informations dans le transcript :
HOSP_DATA: NOM=[Prénom Nom], CHAMBRE=[numéro], DEMANDE=[type: chambre/restau/bar/service/facturation/autre], DETAIL=[résumé en 1 phrase], ACTION=[ce que tu as fait]

⚠️ RÈGLES IMPORTANTES :
- Ne jamais promettre quelque chose que tu ne peux pas garantir.
- Pour les réservations de chambre : prendre nom, date d'arrivée, date de départ, nombre de personnes.
- Pour le restaurant : prendre nom, heure, nombre de couverts.
- Toujours rester courtois même face à une demande impossible.
- Maximum 2 minutes par appel.
- Si la demande dépasse tes capacités, proposer de transférer à la réception.${customInstr}`;
}

// ─── Extraction données SVIA ────────────────────────────────────────────────
function parseHospData(text, ctx) {
  // Format structuré HOSP_DATA
  const m = text.match(/HOSP_DATA:\s*NOM=\[([^\]]*)\].*?CHAMBRE=\[([^\]]*)\].*?DEMANDE=\[([^\]]*)\].*?DETAIL=\[([^\]]*)\].*?ACTION=\[([^\]]*)\]/is);
  if (m) {
    const [, nom, chambre, demande, detail, action] = m;
    if (nom && nom.toLowerCase() !== 'vide' && nom.trim()) ctx.nom_client = nom.trim();
    if (chambre && chambre.toLowerCase() !== 'vide' && chambre.trim()) ctx.numero_chambre = chambre.trim();
    if (demande && demande.toLowerCase() !== 'vide' && demande.trim()) ctx.type_demande = demande.trim().toLowerCase();
    if (detail && detail.toLowerCase() !== 'vide' && detail.trim()) ctx.demande = detail.trim();
    if (action && action.toLowerCase() !== 'vide' && action.trim()) ctx.action_effectuee = action.trim();
    console.log('[PARSE] ✅ HOSP_DATA → nom:', ctx.nom_client, '| chambre:', ctx.numero_chambre, '| type:', ctx.type_demande);
    return;
  }

  // Fallback : regex sur transcript libre
  if (!ctx.nom_client || ctx.nom_client === 'Inconnu') {
    const mNom = text.match(/(?:je m.appelle|mon nom est|je suis|c.est)\s+([A-ZÀ-Ÿa-zà-ÿ\-]+(?:\s+[A-ZÀ-Ÿa-zà-ÿ\-]+)+)/i);
    if (mNom) ctx.nom_client = mNom[1].trim();
  }
  if (!ctx.numero_chambre) {
    const mCh = text.match(/(?:chambre|room|suite)\s*(?:numéro|number|n°)?\s*(\d{1,4})/i);
    if (mCh) ctx.numero_chambre = mCh[1];
  }
  if (!ctx.type_demande) {
    if (/réserv|réserver|chambre|room/i.test(text)) ctx.type_demande = 'chambre';
    else if (/restaurant|room.?service|manger|dîner|déjeuner/i.test(text)) ctx.type_demande = 'restau';
    else if (/bar|boisson|boire|cocktail/i.test(text)) ctx.type_demande = 'bar';
    else if (/ménage|serviette|linge|housekeeping/i.test(text)) ctx.type_demande = 'service';
    else if (/facture|payer|montant|tarif|prix/i.test(text)) ctx.type_demande = 'facturation';
    else if (/taxi|voiture|navette|transport/i.test(text)) ctx.type_demande = 'transport';
    else if (/spa|massage|bien.être|sauna/i.test(text)) ctx.type_demande = 'spa';
    else if (/annuler|annulation/i.test(text)) ctx.type_demande = 'annulation';
    else ctx.type_demande = 'autre';
  }
}

// ─── Sauvegarde appel en base ────────────────────────────────────────────────
async function saveAppel({ hotelId, hotelNumero, callSid, ctx, transcript, dureeAppel }) {
  try {
    const payload = {
      action:          'save_appel',
      numero_voxzen:   hotelNumero,
      call_sid:        callSid || '',
      type_demande:    ctx.type_demande || 'autre',
      nom_client:      ctx.nom_client || 'Inconnu',
      telephone:       ctx.telephone || '',
      numero_chambre:  ctx.numero_chambre || '',
      demande:         ctx.demande || '',
      resume_ia:       transcript.slice(-4).map(e => (e.r === 'a' ? 'Sofia: ' : 'Client: ') + e.t).join(' | '),
      action_effectuee: ctx.action_effectuee || '',
      langue_detectee:  ctx.langue || 'fr',
      duree_appel:      dureeAppel || 0,
    };

    const res = await fetch(BASE44_HOSP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (data.success) {
      console.log('[APPEL] ✅ Appel sauvegardé, id:', data.appel_id);
    } else {
      console.warn('[APPEL] ⚠️ Erreur save_appel:', JSON.stringify(data));
    }
  } catch(e) {
    console.warn('[APPEL] ⚠️ Exception save_appel:', e.message);
  }
}

// ─── TwiML Webhook ───────────────────────────────────────────────────────────
app.post('/twiml', (req, res) => {
  const to     = req.body.To     || req.query.To     || '';
  const from   = req.body.From   || req.query.From   || '';
  const callSid = req.body.CallSid || req.query.CallSid || '';

  console.log(`[TWIML] Appel entrant → To:${to} From:${from} CallSid:${callSid}`);

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/ws">
      <Parameter name="to" value="${to}" />
      <Parameter name="caller" value="${from}" />
      <Parameter name="sid" value="${callSid}" />
    </Stream>
  </Connect>
</Response>`);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SVIA Hospitality Voxzen',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    connections_actives: wss.clients.size,
    config_cached: configCache.size,
  });
});

// ─── Logs ──────────────────────────────────────────────────────────────────────
app.get('/logs', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ logs: LOG_BUFFER.slice(-100).reverse() });
});

// ─── Reload config (flush cache) ──────────────────────────────────────────────
app.post('/reload-config', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { numero_voxzen } = req.body || {};
  if (numero_voxzen) {
    configCache.delete(numero_voxzen);
    console.log('[CFG] 🔄 Cache supprimé pour', numero_voxzen);
  } else {
    configCache.clear();
    console.log('[CFG] 🔄 Tout le cache config supprimé');
  }
  res.json({ ok: true });
});

// ─── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] ✅ Nouvelle connexion depuis', req.socket.remoteAddress);

  let streamSid   = '';
  let callSid     = '';
  let oai         = null;
  let ready       = false;
  let queue       = [];
  let transcript  = [];
  let curAss      = '';
  let botInterrupted = false; // Flag barge-in : bloque l'envoi d'audio vers Twilio
  let cfg         = null;
  let hotelNumero = '';
  let saved       = false;
  let accueilDone = false;
  let callTimer   = null;
  let hangingUp   = false;
  let callStart   = Date.now();

  let ctx = {
    nom_client:      'Inconnu',
    telephone:       '',
    numero_chambre:  '',
    type_demande:    '',
    demande:         '',
    action_effectuee:'',
    langue:          'fr',
  };

  // ── Raccrochage Twilio ──
  async function hangupTwilio(sid) {
    if (!sid || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;
    try {
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${sid}.json`,
        { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Status=completed' }
      );
      console.log(`[HANGUP] REST Twilio → HTTP ${r.status}`);
    } catch(e) {
      console.warn('[HANGUP] REST error:', e.message);
    }
  }

  function hangup() {
    if (callTimer) { clearTimeout(callTimer); callTimer = null; }
    if (oai && oai.readyState === WebSocket.OPEN) oai.close();
    try { if (ws.readyState === ws.OPEN) ws.close(); } catch(_) {}
  }

  async function flush() {
    if (saved) return; saved = true;
    hangup();
    const duree = Math.floor((Date.now() - callStart) / 1000);
    await saveAppel({ hotelNumero, callSid, ctx, transcript, dureeAppel: duree });
  }

  function connectOAI(callerNum) {
    console.log('[OAI] Connexion OpenAI Realtime...');
    oai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OAI_MODEL}`,
      ['realtime'],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    oai.on('open', () => {
      const instructions = buildHospPrompt(cfg);
      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions,
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'gpt-4o-transcribe', language: 'fr' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: resolveVoice(cfg?.voix)
            }
          }
        }
      }));
    });

    oai.on('message', async (data) => {
      let m;
      try { m = JSON.parse(data); } catch(_) { return; }

      // Session prête → accueil
      if (m.type === 'session.updated' && !ready) {
        ready = true;
        for (const c of queue) {
          oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: c }));
        }
        queue = [];
        const nomHotel = cfg?.nom_hotel || 'l\'hôtel';
        const accueil = `Bienvenue à l'Hôtel ${nomHotel}, je suis Sofia, comment puis-je vous aider ?`;
        console.log('[OAI] Session prête → accueil:', accueil);
        oai.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: `IMPORTANT: Prononce maintenant cet accueil mot pour mot : "${accueil}"` }
        }));
      }

      // Reset barge-in quand une nouvelle réponse commence
      if (m.type === 'response.created') {
        botInterrupted = false;
      }

      // Audio vers Twilio
      if (m.type === 'response.output_audio.delta' && m.delta && streamSid) {
        if (botInterrupted) return; // 🛑 Barge-in : ne pas envoyer d'audio pendant interruption
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: m.delta } }));
        }
      }

      // ─── Barge-in / Interruption ───────────────────────────────────────
      if (m.type === 'response.output_audio.cancelled' && streamSid) {
        botInterrupted = true;
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
          console.log('[INTERRUPT] 🛑 output_audio.cancelled → clear + bloque deltas');
        }
      }

      if (m.type === 'input_audio_buffer.speech_started' && streamSid) {
        botInterrupted = true;
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
          console.log('[INTERRUPT] 🛑 Speech started → clear + bloque deltas');
        }
        if (oai && oai.readyState === WebSocket.OPEN) {
          oai.send(JSON.stringify({ type: 'response.cancel' }));
          console.log('[INTERRUPT] 🛑 response.cancel envoyé à OpenAI');
        }
      }

      if (m.type === 'response.audio_transcript.delta' && m.delta) curAss += m.delta;

      async function handleSofiaTranscript(text) {
        if (!text?.trim()) return;
        const t = text.trim();
        if (transcript.some(e => e.r === 'a' && e.t === t)) return;
        transcript.push({ r: 'a', t });
        console.log(`[SOFIA] "${t.slice(0, 100)}"`);

        // Détection fin d'appel
        const finPhrases = /au revoir|à bientôt|bonne journée|bonne soirée|excellente journée|excellente soirée|excellente nuit/i;
        if (finPhrases.test(t) && !hangingUp) {
          hangingUp = true;
          console.log('[FIN] ✅ Phrase de fin → raccrochage dans 2s');
          setTimeout(async () => {
            await hangupTwilio(callSid);
            hangup();
            await flush();
          }, 2000);
        }
      }

      if (m.type === 'response.audio_transcript.done' && curAss) {
        await handleSofiaTranscript(curAss);
        curAss = '';
      }

      if (m.type === 'response.output_item.done' && m.item?.formatted?.transcript) {
        await handleSofiaTranscript(m.item.formatted.transcript);
        if (!curAss) curAss = '';
      }

      if (m.type === 'response.done' && !accueilDone) {
        accueilDone = true;
        oai.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: 'Enchaîne immédiatement : demande le prénom du client et son numéro de chambre.' }
        }));
      }

      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        transcript.push({ r: 'u', t: m.transcript });
        console.log(`[USER] "${m.transcript.slice(0, 100)}"`);
        // PMS Query automatique si demande de réservation / disponibilité détectée
        if (cfg?._pms) {
          const t = m.transcript.toLowerCase();
          if (t.includes('disponib') || t.includes('libre') || t.includes('chambre')) {
            pmsQuery(cfg._pms, 'check_availability', {
              dateArrivee: new Date().toISOString().slice(0,10),
              dateDepart: new Date(Date.now()+86400000).toISOString().slice(0,10),
              nbPersonnes: 1
            }).then(res => {
              if (res.success && oai.readyState === 1) {
                oai.send(JSON.stringify({ type: 'conversation.item.create', item: {
                  type: 'message', role: 'system',
                  content: [{ type: 'input_text', text: `[PMS] ${res.message_fr}` }]
                }}));
              }
            }).catch(() => {});
          }
        }
        parseHospData(m.transcript, ctx);
      }

      if (m.type === 'error') console.error('[OAI] Erreur:', JSON.stringify(m.error));
    });

    oai.on('error', (e) => console.error('[OAI] WS Error:', e.message));
    oai.on('close', (code) => console.log('[OAI] Fermé, code:', code));
  }

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch(_) { return; }

    if (m.event === 'start') {
      streamSid   = m.start?.streamSid || '';
      const params = m.start?.customParameters || {};
      callSid     = params.sid    || params.CallSid || m.start?.callSid || '';
      const caller = params.caller || params.From   || m.start?.from   || '';
      const to     = params.to    || params.To      || m.start?.to     || '';

      console.log(`[WS] START streamSid:${streamSid} | caller:${caller} | to:${to}`);

      ctx.telephone = caller ? caller.replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ').trim() : 'Inconnu';
      hotelNumero  = to.replace(/\s/g, '').replace(/^\+/, '+');

      // Charger config hôtel
      fetchHotelConfig(hotelNumero).then(config => {
        cfg = config;
        connectOAI(ctx.telephone);
      });

      // Timeout 2 min
      callTimer = setTimeout(async () => {
        console.log('[TIMER] 5min → raccrochage automatique');
        hangingUp = true;
        await hangupTwilio(callSid);
        hangup();
        await flush();
      }, 300000);
    }

    if (m.event === 'media' && m.media?.payload) {
      if (!ready) {
        queue.push(m.media.payload);
      } else if (oai && oai.readyState === WebSocket.OPEN) {
        oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
      }
    }

    if (m.event === 'stop') {
      console.log('[WS] STOP reçu');
      if (!saved) await flush();
    }
  });

  ws.on('close', async () => {
    console.log('[WS] Connexion fermée');
    if (!saved) await flush();
  });

  ws.on('error', (e) => console.error('[WS] Erreur:', e.message));
});

// ─── Démarrage ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🏨 SVIA Hospitality Voxzen — Port ${PORT}`);
  console.log(`   WebSocket: wss://[host]/ws`);
  console.log(`   TwiML:     POST /twiml`);
  console.log(`   Base44:    ${BASE44_HOSP_URL}`);
});
