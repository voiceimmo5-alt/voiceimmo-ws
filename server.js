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
const VERSION         = 'v33-stable';

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

  return `Tu es Sophie, assistante vocale de ${cfg.nom_agence}. Tu parles uniquement en français, de façon chaleureuse, naturelle et TRÈS concise — comme une vraie secrétaire au téléphone.

IMPORTANT : L'appelant téléphone depuis le numéro ${callerNum || 'inconnu'}. Tu connais DÉJÀ son numéro, ne le demande JAMAIS. Utilise ce numéro comme numéro de rappel par défaut.

Ta mission en 4 étapes maximum :
1. Accueillir et demander le prénom et nom de l'appelant
2. Demander son besoin (achat, vente, location, estimation)
3. Si besoin d'un bien : demander la ville et le prix approximatif (une seule question)
4. Confirmer : "Parfait [Prénom], j'ai bien noté votre demande. Un agent vous rappellera très prochainement sur le ${callerNum || 'votre numéro'}. Bonne journée !"

Agents et leurs zones :
${agentsDesc}

Règles ABSOLUES :
- Maximum 3-4 échanges, sois directe et efficace
- Ne demande JAMAIS le numéro de téléphone (tu l'as déjà)
- Une seule question à la fois
- Réponses courtes (1-2 phrases max)
- Si l'appelant dit au revoir, conclus immédiatement
- Ne propose pas de rendez-vous, dis qu'un agent rappellera`;
}

// ─── Charger config client depuis Base44 ─────────────────────────────────
async function getConfig(numTwilio) {
  try {
    // Utiliser la fonction saveLead (accès interne aux entités, pas de token expirant)
    const res = await fetch(FUNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Voxzen-Secret': FUNC_SECRET },
      body: JSON.stringify({ action: 'getClient', data: { numero: numTwilio } })
    });
    if (!res.ok) throw new Error(`saveLead/getClient ${res.status}`);
    const json = await res.json();
    const client = json.client || null;
    if (!client) { pushLog('info', `[CFG] Aucun client pour ${numTwilio} → fallback`); return DEF_CFG; }

    let agents_arr = DEF_CFG.agents_arr;
    try {
      const arr = typeof client.agents === 'string' ? JSON.parse(client.agents) : client.agents;
      if (Array.isArray(arr) && arr.length > 0) agents_arr = arr;
    } catch(_) {}

    const VMAP = { coral:'coral', shimmer:'shimmer', alloy:'alloy', echo:'echo', verse:'verse', ash:'ash', sage:'sage', ballad:'ballad' };
    const voix = VMAP[(client.voix||'coral').toLowerCase()] || 'coral';

    pushLog('info', `[CFG] Config chargée: ${client.nom_entreprise}`);
    return {
      nom_agence:          client.nom_entreprise   || DEF_CFG.nom_agence,
      client_db_id:        client.id               || DEF_CFG.client_db_id,
      client_id:           client.client_id        || '',
      voix,
      message_accueil:     client.message_accueil  || DEF_CFG.message_accueil,
      instructions_ia:     client.instructions_ia  || '',
      agents_arr,
      destinataires_email: client.destinataires_email || DEF_CFG.destinataires_email,
      numero_actuel:       numTwilio,
    };
  } catch(e) {
    pushLog('error', `[CFG] Erreur chargement config: ${e.message} → fallback`);
    return DEF_CFG;
  }
}

// ─── Incrémenter compteur d'appels ───────────────────────────────────────
const FUNC_URL = 'https://fr-2758ee0c.base44.app/functions/saveLead';
const FUNC_SECRET = 'voxzen-railway-2026';

async function callFunc(action, data, id) {
  const res = await fetch(FUNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Voxzen-Secret': FUNC_SECRET },
    body: JSON.stringify({ action, data, id })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`[${action}] ${res.status}: ${json.error||'?'}`);
  return json;
}

async function incrAppels(clientDbId) {
  if (!clientDbId) { pushLog('error', '[INCR] Pas de client_db_id'); return; }
  try {
    await callFunc('incrAppels', { clientId: clientDbId });
    pushLog('info', '[INCR] ✅ Compteur incrémenté');
  } catch(e) { pushLog('error', '[INCR]:', e.message); }
}

// ─── Sauvegarder lead ─────────────────────────────────────────────────────
async function saveLead(lead, cfg, transcript) {
  try {
    const agent = (cfg.agents_arr || []).find(a =>
      (a.zones||'').toLowerCase().split(',').some(z =>
        z.trim() && (lead.ville||'').toLowerCase().includes(z.trim())
      )
    ) || cfg.agents_arr?.[0] || { nom: 'Agence', email: cfg.destinataires_email };

    const result = await callFunc('createLead', {
      nom:             lead.nom    || 'Inconnu',
      telephone:       lead.tel    || '',
      besoin:          lead.besoin || '',
      ville:           lead.ville  || '',
      prix:            lead.prix   || '',
      reference:       lead.ref    || '',
      agent_initiales: agent.nom?.substring(0,2).toUpperCase() || 'AG',
      agent_nom:       agent.nom   || 'Agence',
      transcript
    });
    pushLog('info', `[LEAD] ✅ Sauvegardé id:${result.id}`);
    return { agent, leadId: result.id };
  } catch(e) { pushLog('error', '[LEAD]:', e.message); return null; }
}

// ─── Envoyer email ────────────────────────────────────────────────────────
async function sendEmail(leadResult, cfg, transcript) {
  if (!leadResult) { pushLog('error', '[EMAIL] Pas de lead result'); return; }
  const { agent, leadId } = leadResult;
  if (!agent) { pushLog('error', '[EMAIL] Pas d\'agent'); return; }
  try {
    // Reconstruire les données lead pour l'email
    // (lead est l'objet local {nom, tel, besoin, ville, prix, ref})
    await callFunc('sendLeadEmail', {
      lead: leadResult.leadData || {},
      cfg,
      agent,
      leadId
    });
    pushLog('info', `[EMAIL] ✅ Envoyé`);
  } catch(e) { pushLog('error', '[EMAIL]:', e.message); }
}

// ─── Routes HTTP ─────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', version: VERSION }));
app.get('/version', (req, res) => res.json({ version: VERSION, serverUrl: SERVER_URL, env: NODE_ENV }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  let oaiOk = false;
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    oaiOk = r.ok;
  } catch(_) {}
  res.json({ version: VERSION, hasOAI: !!OPENAI_API_KEY, oaiOk, node: process.version });
});

app.get('/logs', (req, res) => {
  const n = parseInt(req.query.n || '50');
  const since = parseInt(req.query.since || '0');
  res.json({ logs: LOG_BUFFER.filter(l => l.ts > since).slice(-n), serverTime: Date.now(), version: VERSION });
});

app.post('/twiml', (req, res) => {
  const to     = (req.body?.To || req.query?.To || '').replace(/\s/g,'');
  const from   = (req.body?.From || req.query?.From || '');
  const callSid = req.body?.CallSid || '';
  const wsUrl  = SERVER_URL ? `wss://${SERVER_URL}` : `wss://${req.headers.host}`;
  pushLog('info', `[TWIML] ${from} → ${to} | ws:${wsUrl}`);
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
  let oai       = null;
  let ready     = false;
  let queue     = [];
  let cfg       = DEF_CFG;
  let callTimer = null;
  let lead      = { nom:'', tel:'', besoin:'', ville:'', prix:'', ref:'' };
  let transcript = [];
  let currentAssistantText = '';
  let incrDone = false; // anti-double-comptage

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
    pushLog('info', '[OAI] Connexion gpt-realtime...');
    oai = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime',
      [],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    oai.on('open', () => {
      pushLog('info', '[OAI] Connecté → session.update');
      // Utiliser le prompt personnalisé du client si défini, sinon le prompt générique
      const prompt = (cfg.instructions_ia && cfg.instructions_ia.trim())
        ? cfg.instructions_ia
            .replace(/\{\{CALLER\}\}/g, callerNum || 'inconnu')
            .replace(/\{\{AGENCE\}\}/g, cfg.nom_agence || '')
        : buildPrompt(cfg, callerNum);
      const voix   = cfg?.voix || 'coral';
      const accueil = cfg?.message_accueil || DEF_CFG.message_accueil;

      // Format API gpt-realtime (nouveau schéma 2025)
      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: prompt,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 800
              },
              transcription: { model: 'whisper-1' }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: voix
            }
          },
          max_output_tokens: 300
        }
      }));
    });

    oai.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch(_) { return; }
      const t = m.type || '';

      if (t === 'session.updated') {
        pushLog('info', '[OAI] session.updated → déclenchement accueil');
        ready = true;
        flush();

        // Déclencher message d'accueil
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
      }

      // Audio vers Twilio — nouveau event gpt-realtime
      if (t === 'response.output_audio.delta' && m.delta && streamSid) {
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
          transcript.push({ r:'u', t:txt });
          const lo = txt.toLowerCase();

          // Extraction contextuelle : regarder la dernière question de Sophie
          const lastSophie = transcript.filter(x => x.r === 'a').pop()?.t?.toLowerCase() || '';
          const demandaitNom  = /votre nom|vous appelez|c'est de la part/i.test(lastSophie);
          const demandaitTel  = /num.ro|rappeler|téléphone|coordonnée/i.test(lastSophie);
          const demandaitVille = /quelle ville|quel secteur|quelle zone|où|quelle commune/i.test(lastSophie);
          const demandaitPrix  = /budget|prix|combien|fourchette/i.test(lastSophie);
          const demandaitRef   = /référence|numéro d.annonce|ref/i.test(lastSophie);

          // Nom : via formule OU via contexte (réponse courte après question sur le nom)
          const nomFormule = txt.match(/(?:je m'appelle|je suis|c'est|mon nom est|prénom est)\s+([A-ZÀ-Ÿa-zéèêëàâùûîïôœçæ\- ]{2,30})/i);
          if (nomFormule) {
            lead.nom = nomFormule[1].trim();
          } else if (demandaitNom && txt.length < 40 && /^[A-ZÀ-Ÿa-zéèêëàâùûîïôœçæ\- ]+$/.test(txt.trim())) {
            // Réponse courte sans ponctuation = probablement un nom
            lead.nom = txt.trim();
          }

          // Téléphone
          const telM = txt.match(/(?:0|\+33)[1-9][\s.]?(?:\d[\s.]?){8}/);
          if (telM) lead.tel = telM[0].replace(/[\s.]/g,'');

          // Ville : via préposition OU via contexte
          const villeFormule = lo.match(/(?:à|sur|dans|secteur|quartier|commune de|côté de|près de)\s+([a-zéèêëàâùûîïôœçæ\- ]{2,25})/i);
          if (villeFormule) {
            lead.ville = villeFormule[1].trim();
          } else if (demandaitVille && txt.length < 30) {
            lead.ville = txt.trim();
          }

          // Prix : montant numérique
          const prixM = txt.match(/(\d[\d\s]*(?:\.\d+)?\s*(?:000|k|K|€|euros?|millions?)?)/i);
          if (prixM && (demandaitPrix || /\d{3}/.test(txt))) lead.prix = prixM[1].trim();

          // Référence annonce
          const refM = txt.match(/(?:référence|ref|réf)[:\s#]+([A-Za-z0-9\-]+)/i);
          if (refM) lead.ref = refM[1].trim();
          else if (demandaitRef && txt.length < 20) lead.ref = txt.trim();
        }
      }

      // Transcription assistant — accumulation par réponse complète
      if (t === 'response.output_audio_transcript.delta') {
        if (!currentAssistantText) currentAssistantText = '';
        currentAssistantText += (m.delta || '');
      }

      if (t === 'response.output_audio_transcript.done') {
        const full = (m.transcript || currentAssistantText || '').trim();
        if (full) transcript.push({ r:'a', t:full });
        currentAssistantText = '';
      }

      if (t === 'response.done') {
        pushLog('info', '[OAI] Réponse terminée');
        if (currentAssistantText) {
          const full = currentAssistantText.trim();
          if (full) transcript.push({ r:'a', t:full });
          currentAssistantText = '';
        }
        const lastA = transcript.filter(x => x.r === 'a').pop();
        if (lastA && /au revoir|bonne journée|bonne soirée|à bientôt/i.test(lastA.t)) {
          // Attendre que l'audio soit entièrement joué côté Twilio avant de raccrocher
          // On estime ~100ms par mot + 2s de marge
          const wordCount = (lastA.t.match(/\S+/g) || []).length;
          const delay = Math.max(5000, wordCount * 120 + 2000);
          pushLog('info', `[HANGUP] Fin détectée, raccrochage dans ${delay}ms`);
          setTimeout(hangup, delay);
        }
      }

      if (t === 'error') {
        pushLog('error', '[OAI] Erreur:', JSON.stringify(m.error));
      }
    });

    oai.on('error', (e) => pushLog('error', '[OAI] WS error:', e.message));

    oai.on('close', (code) => {
      pushLog('info', `[OAI] Fermé: ${code}`);
      ready = false;
      if (code !== 1000 && code !== 1001) { pushLog('error', '[OAI] Fermeture inattendue'); hangup(); }
    });
  }

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch(_) { return; }

    try {
      if (m.event === 'connected') {
        pushLog('info', '[WS] connected');
      }
      else if (m.event === 'start') {
        streamSid     = m.start?.streamSid || '';
        const params  = m.start?.customParameters || {};
        const caller  = params.caller || '';
        const to      = params.to     || '';
        pushLog('info', `[WS] START sid:${streamSid} caller:${caller} to:${to}`);
        lead.tel = caller.replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ').trim();
        cfg = await getConfig(to || '');
        connectOAI(lead.tel);
        callTimer = setTimeout(() => { pushLog('info', '[TIMER] 2min'); hangup(); }, 120000);
      }
      else if (m.event === 'media' && m.media?.payload) {
        if (oai && oai.readyState === WebSocket.OPEN && ready) {
          oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
        } else {
          queue.push(m.media.payload);
        }
      }
      else if (m.event === 'stop') {
        pushLog('info', '[WS] STOP');
        if (lead.nom || lead.tel) {
          const result = await saveLead(lead, cfg, transcript);
          if (result) {
            // Passer les données du lead pour l'email
            result.leadData = {
              nom:       lead.nom,
              telephone: lead.tel,
              besoin:    lead.besoin,
              ville:     lead.ville,
              prix:      lead.prix,
              reference: lead.ref,
              notes:     transcript.map(t => `${t.r==='u'?'👤 Appelant':'🤖 Sophie'}: ${t.t}`).join('\n')
            };
            await sendEmail(result, cfg, transcript);
          }
          if (cfg.client_db_id && !incrDone) {
            incrDone = true;
            await incrAppels(cfg.client_db_id);
          }
        }
        hangup();
      }
    } catch(err) {
      pushLog('error', '[WS] Handler error:', err.message);
    }
  });

  ws.on('close', async () => {
    pushLog('info', '[WS] Client déconnecté');
    if (callTimer) clearTimeout(callTimer);
    try { oai?.close(); } catch(_) {}
    // Comptage si raccrochage brutal (pas de stop reçu)
    if (!incrDone && cfg && cfg.client_db_id) {
      incrDone = true;
      try { await incrAppels(cfg.client_db_id); pushLog('info', '[INCR] Comptage raccrochage brutal'); } catch(_) {}
    }
  });

  ws.on('error', (e) => pushLog('error', '[WS] Erreur:', e.message));
});

server.listen(PORT, () => {
  pushLog('info', `[START] VoiceImmo WS ${VERSION} sur port ${PORT} (env:${NODE_ENV})`);
});
