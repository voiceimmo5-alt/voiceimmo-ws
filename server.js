/**
 * VoiceImmo WebSocket Server — Railway v4
 * Corrections v4 :
 *  1. Langue forcée FR (instruction renforcée + language hint)
 *  2. Voix modifiable depuis le dashboard (VMAP étendu, insensible à la casse)
 *  3. Limite 2 minutes (timer automatique → clôture + flush)
 *  4. Scénario strict (prompt restructuré, max_tokens réduit, temp abaissée)
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

// ─── Gestionnaires crash globaux ──────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('[CRASH] uncaughtException:', e.message, e.stack));
process.on('unhandledRejection', e => console.error('[CRASH] unhandledRejection:', e));

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/' });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const APP_ID         = '69edcbff1c52f6e82758ee0c';
const BASE44_API_KEY = process.env.BASE44_SERVICE_TOKEN || '';

// Limite d'appel en ms (2 minutes)
const CALL_MAX_MS = 2 * 60 * 1000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', version: 'v23-testcall', service: 'VoiceImmo WS' }));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Debug endpoint
app.get('/debug', async (req, res) => {
  const hasOAI = !!process.env.OPENAI_API_KEY;
  const hasB44 = !!process.env.BASE44_SERVICE_TOKEN;
  let b44Ok = false, oaiOk = false;
  try {
    const r = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Voxzen-Secret': BRIDGE_SECRET },
      body: JSON.stringify({ action: 'getClient', data: { numero: 'test' } })
    });
    const d = await r.json();
    b44Ok = r.ok && d.success !== undefined;
  } catch(e) {}
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    oaiOk = r.ok;
  } catch(e) {}
  res.json({ hasOAI, hasB44, b44Ok, oaiOk, node: process.version });
});

// ─── Endpoint diagnostic WebSocket OAI ──────────────────────────────────────
app.get('/test-oai', async (req, res) => {
  const result = { step: 'init', error: null };
  try {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) { res.json({ ok: false, error: 'No OPENAI_API_KEY' }); return; }
    
    result.step = 'connecting';
    const ws = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime'],
      { headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' } }
    );
    
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { ws.close(); reject(new Error('timeout 8s')); }, 8000);
      ws.on('open', () => { result.step = 'open'; });
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(data);
          result.step = m.type;
          if (m.type === 'session.created') {
            clearTimeout(t);
            ws.close();
            resolve();
          }
          if (m.type === 'error') { clearTimeout(t); reject(new Error(JSON.stringify(m.error))); }
        } catch(e) {}
      });
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    
    res.json({ ok: true, step: result.step });
  } catch(e) {
    res.json({ ok: false, step: result.step, error: e.message });
  }
});

// ─── Endpoint test appel complet ─────────────────────────────────────────────
app.get('/test-call', async (req, res) => {
  const events = [];
  const apiKey = process.env.OPENAI_API_KEY || '';
  try {
    const oaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime'],
      { headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' } }
    );
    
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { oaiWs.close(); resolve(); }, 20000);
      let audioChunks = 0;
      
      oaiWs.on('open', () => {
        events.push('oai:open');
        // session.update
        oaiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text','audio'],
            instructions: 'Dis bonjour en français.',
            voice: 'coral',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            turn_detection: { type:'server_vad', threshold:0.5, silence_duration_ms:700 },
            temperature: 0.7
          }
        }));
        events.push('session.update:sent');
      });
      
      oaiWs.on('message', (data) => {
        const m = JSON.parse(data);
        events.push(m.type);
        
        if (m.type === 'session.updated') {
          // response.create
          oaiWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities:['text','audio'], instructions:'Dis: "Bonjour et bienvenue à l agence Leone Immobilier"' }
          }));
          events.push('response.create:sent');
        }
        if (m.type === 'response.audio.delta') {
          audioChunks++;
          if (audioChunks === 1) events.push('AUDIO_FIRST_CHUNK');
        }
        if (m.type === 'response.done') {
          events.push(`audio_total:${audioChunks}`);
          clearTimeout(t);
          oaiWs.close();
          resolve();
        }
        if (m.type === 'error') {
          events.push('ERROR:' + JSON.stringify(m.error));
          clearTimeout(t);
          oaiWs.close();
          resolve();
        }
      });
      oaiWs.on('error', (e) => { events.push('WS_ERROR:'+e.message); resolve(); });
    });
    
    const hasAudio = events.includes('AUDIO_FIRST_CHUNK');
    res.json({ ok: hasAudio, events });
  } catch(e) {
    res.json({ ok: false, error: e.message, events });
  }
});

// ─── TwiML endpoint ───────────────────────────────────────────────────────────
app.post('/twiml', (req, res) => {
  const caller = req.body.From    || req.body.Caller || '';
  const to     = req.body.To      || req.body.Called || '';
  const sid    = req.body.CallSid || '';

  console.log(`[TWIML v4] From:${caller} To:${to} Sid:${sid}`);

  const wsUrl = `wss://voiceimmo-ws-production.up.railway.app`;

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${caller}" />
      <Parameter name="to" value="${to}" />
      <Parameter name="sid" value="${sid}" />
    </Stream>
  </Connect>
</Response>`);
});

// ─── Helpers Base44 (via Bridge vapiWebhook) ─────────────────────────────────
// Railway ne peut pas accéder directement à l'API Base44 → on passe par la fonction bridge
const BRIDGE_URL = 'https://fr-2758ee0c.base44.app/functions/vapiWebhook';
const BRIDGE_SECRET = 'voxzen-railway-2026';

async function bridgeCall(action, data, id) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Voxzen-Secret': BRIDGE_SECRET },
      body: JSON.stringify({ action, data, id }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!r.ok) {
      const txt = await r.text().catch(()=>'');
      console.error(`[BRIDGE] ${action} HTTP:${r.status}`, txt.slice(0,200));
      return null;
    }
    return await r.json();
  } catch(e) { console.error(`[BRIDGE] ${action}:`, e.message); return null; }
}

async function b44List(entity) {
  // Pour la liste, on utilise getClient si c'est Client, sinon retour vide (pas nécessaire)
  if (entity === 'Client') {
    console.error('[B44] b44List(Client) via bridge non supporté — utiliser getClientConfig directement');
    return [];
  }
  return [];
}

async function b44Create(entity, data) {
  if (entity === 'Lead') {
    const res = await bridgeCall('createLead', data);
    if (res && res.success) {
      console.log(`[BRIDGE] ✅ Lead créé id:${res.id}`);
      return { id: res.id };
    }
  }
  return null;
}

async function b44Update(entity, id, data) {
  if (entity === 'Client') {
    const res = await bridgeCall('updateClient', data, id);
    if (res && res.success) console.log(`[BRIDGE] ✅ Client màj:${id}`);
  }
}

async function gmailSend(toAddr, subject, body) {
  try {
    const tr = await fetch(`https://fr-2758ee0c.base44.app/api/connectors/gmail/token`, {
      headers: { Authorization: `Bearer ${BASE44_API_KEY}` }
    });
    if (!tr.ok) { console.error(`[EMAIL] Token error HTTP:${tr.status}`); return; }
    const { access_token } = await tr.json();
    const msg = [
      `From: Voxzen VoiceImmo <contact@voxzen.io>`,
      `Cc: voiceimmo5@gmail.com`,
      `To: ${toAddr}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from(body).toString('base64'),
    ].join('\r\n');
    const raw = Buffer.from(msg).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const gr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw })
    });
    const gd = await gr.json();
    if (gr.ok) console.log('[EMAIL] ✅', gd.id);
    else console.error('[EMAIL] ❌', JSON.stringify(gd));
  } catch(e) { console.error('[EMAIL]', e.message); }
}

// ─── Config client ────────────────────────────────────────────────────────────
async function getClientConfig(numeroTwilio) {
  // Config hardcodée Leone Immobilier (fallback si Base44 inaccessible)
  const DEF = {
    nom_agence: 'LEONE IMMOBILIER',
    client_id: 'VX-0001',
    client_db_id: '6a03042d6c4e45eec21bedd5',
    horaires: 'du lundi au samedi de 09h30 à 12h et de 14h à 19h',
    destinataires_email: 'leone.immobilier@gmail.com',
    agents: 'Luca : givors, montany, pont eveque, tassin, st genis laval, charly, irigny, corbas\nkenny : villette de vienne\nJeff : villefontaine',
    agents_arr: [{"nom": "Luca", "email": "leone.immobilier@gmail.com", "zones": "givors, montany, pont eveque, tassin, st genis laval, charly, irigny, corbas"}, {"nom": "kenny", "email": "kenny.leoneimmobilier@gmail.com", "zones": "villette de vienne"}, {"nom": "Jeff", "email": "jeff.leoneimmobilier@gmail.com", "zones": "villefontaine"}],
    annonces_cache: '',
    voix: 'coral',
    message_accueil: "Bonjour et bienvenue à l'agence Leone immobilier, comment puis-je vous aider ?",
    scraping_format: `SCRIPT VOICEBOT — LEONE IMMOBILIER

1. ACCUEIL
Dire exactement : "Bonjour et bienvenue à l'agence Leone immobilier, comment puis-je vous aider ?"

2. COLLECTER (dans l'ordre, UNE seule question à la fois)
   a. Ville / secteur du bien recherché
   b. Budget maximum
   c. Prénom et nom de l'appelant
   d. Confirmer le numéro : "Je rappelle que votre numéro est le [NUMÉRO], c'est bien ça ?"

3. CLÔTURE
Dire exactement : "Merci pour votre appel, nous avons bien noté votre demande, l'agent commercial va rapidement vous rappeler, merci d'avoir contacté l'agence Léone Immobilier et à très bientôt !"
Puis raccrocher.`,
    site_internet: 'https://www.leone-immobilier.fr',
    regles_dispatch: 'LC/LCC→Luca CIMMARUSTI, JP→Jeff PIGEAT, kp→Kenny PIGEAT',
    numero_actuel: '+33939245959',
    appels_mois: 0,
  };

  if (!numeroTwilio) return DEF;

  try {
    const normNum = numeroTwilio.replace(/\s/g, '');
    console.log(`[CFG] Recherche client pour: "${normNum}" via bridge`);
    const bridgeRes = await bridgeCall('getClient', { numero: normNum });
    const client = bridgeRes && bridgeRes.success ? bridgeRes.client : null;
    console.log(`[CFG] Bridge réponse:`, client ? `${client.nom_entreprise}` : 'null');

    if (!client) {
      console.log(`[CFG] ⚠️ Pas de client pour ${normNum} — utilisation config par défaut`);
      return DEF;
    }
    console.log(`[CFG] ✅ Match: ${client.nom_entreprise} (${client.client_id})`);

    let agentsStr = DEF.agents;
    if (client.agents) {
      try {
        const arr = typeof client.agents === 'string' ? JSON.parse(client.agents) : client.agents;
        if (Array.isArray(arr)) agentsStr = arr.map(a => `${a.nom} : ${a.zones||'—'}`).join('\n');
        else agentsStr = String(client.agents);
      } catch { agentsStr = String(client.agents)||DEF.agents; }
    }

    // VMAP insensible à la casse — supporte tous les noms du dashboard
    const VMAP = {
      sophie:'shimmer', claire:'nova', isabelle:'alloy', emma:'echo', thomas:'fable', nicolas:'onyx',
      shimmer:'shimmer', nova:'nova', alloy:'alloy', echo:'echo', fable:'fable', onyx:'onyx',
      // variantes avec majuscule ou accents
      jade:'shimmer', // fallback si ElevenLabs non dispo
    };

    const voixRaw = (client.voix||'shimmer').toLowerCase().trim();
    const voix    = VMAP[voixRaw] || 'shimmer';

    const cfg = {
      ...DEF,
      nom_agence:          client.nom_entreprise || DEF.nom_agence,
      destinataires_email: client.destinataires_email || DEF.destinataires_email,
      voix,
      message_accueil:     (client.message_accueil||'').trim() || `${client.nom_entreprise||DEF.nom_agence}, bonjour !`,
      horaires:            client.horaires || DEF.horaires,
      agents:              agentsStr,
      site_internet:       client.site_internet || '',
      scraping_format:     client.scraping_format || '',
      id:                  client.id,
      client_id:           client.client_id || client.id,
      appels_total:        client.appels_total || 0,
      appels_mois:         client.appels_mois  || 0,
      annonces_cache:      '',
    };

    // Annonces depuis AgenceConfig
    try {
      const acList = await b44List('AgenceConfig');
      const agCfg  = acList.find(a => a.numero_twilio?.replace(/\s/g,'') === normNum) || acList[0];
      if (agCfg?.annonces_cache) cfg.annonces_cache = agCfg.annonces_cache;
    } catch(_) {}

    console.log(`[CFG] accueil="${cfg.message_accueil}" voix=${cfg.voix}`);
    return cfg;
  } catch(e) { console.error('[CFG] Erreur:', e.message); return DEF; }
}

// ─── Prompt système ───────────────────────────────────────────────────────────
function buildPrompt(cfg, callerNum) {
  const accueil  = (cfg.message_accueil||'').trim() || `${cfg.nom_agence}, bonjour !`;
  const annonces = cfg.annonces_cache
    ? `BIENS DISPONIBLES EN CE MOMENT :\n${cfg.annonces_cache}`
    : '(Aucune annonce en base pour l\'instant — un agent rappellera avec des biens adaptés)';

  // Si le client a défini un script personnalisé, on l'utilise EN PRIORITÉ ABSOLUE
  if (cfg.scraping_format && cfg.scraping_format.trim().length > 50) {
    return `LANGUE : Tu parles EXCLUSIVEMENT en français. Jamais en anglais. Si l'appelant parle anglais, réponds en français.

IDENTITÉ : Tu es l'assistante vocale de ${cfg.nom_agence}. Ton rôle est UNIQUEMENT de suivre le script ci-dessous.

${cfg.scraping_format.trim()}

━━ BIENS DISPONIBLES ━━
${annonces}

━━ AGENTS PAR SECTEUR ━━
${cfg.agents}

━━ RÈGLES TECHNIQUES ABSOLUES ━━
- LANGUE : uniquement le FRANÇAIS, aucune exception
- DURÉE : l'appel ne doit pas dépasser 2 minutes — va à l'essentiel
- UNE seule question par prise de parole
- MAX 2 phrases par réponse
- Ne JAMAIS improviser ou sortir du script
- Ne JAMAIS inventer un bien immobilier
- Après la clôture : silence total, ne réponds plus`;
  }

  // Script par défaut si pas de script personnalisé
  return `LANGUE : Tu parles EXCLUSIVEMENT en français. Jamais en anglais. Si l'appelant parle anglais, réponds-lui en français.

IDENTITÉ : Tu es l'assistante vocale de ${cfg.nom_agence}. Tu es chaleureuse, naturelle et efficace.

━━ SCRIPT OBLIGATOIRE (respecte cet ordre STRICTEMENT) ━━

ÉTAPE 1 — ACCUEIL (première phrase, mot pour mot) :
"${accueil}"

ÉTAPE 2 — UN SEUL besoin à la fois :
→ "Vous recherchez à acheter, vendre ou simplement vous renseigner ?"

ÉTAPE 3 — Secteur / ville :
→ "Dans quel secteur ou quelle ville cherchez-vous ?"

ÉTAPE 4 — Identité :
→ "Pouvez-vous me donner votre prénom et votre nom ?"

⚠️ NE PAS chercher les caractéristiques précises du bien (surface, pièces, étage, budget...)
⚠️ Ton rôle : UNIQUEMENT collecter prénom, nom, ville, besoin, numéro → transmettre à l'agent.

ÉTAPE 5 — Confirmation numéro :
→ "Je vois que vous appelez depuis le ${callerNum||'numéro non détecté'}, c'est bien votre numéro de rappel ?"

ÉTAPE 6 — CLÔTURE (mot pour mot, puis silence) :
"Merci pour votre appel, nous avons bien noté votre demande, l'agent commercial en charge de ce secteur va rapidement vous rappeler, merci d'avoir contacté l'agence Léone Immobilier et à très bientôt !"

━━ BIENS DISPONIBLES ━━
${annonces}

━━ AGENTS PAR SECTEUR ━━
${cfg.agents}

━━ RÈGLES ABSOLUES ━━
- LANGUE : FRANÇAIS UNIQUEMENT. Jamais un mot en anglais, même si l'appelant parle anglais
- Ne JAMAIS chercher les caractéristiques du bien (surface, pièces, étage, budget...)
- Ne JAMAIS proposer ou commenter des annonces pendant l'appel
- Ton SEUL rôle : collecter prénom, nom, ville, besoin, numéro → transmettre à l'agent
- 1 question à la fois, max 2 phrases courtes par réponse
- Après l'ÉTAPE 6 : silence total, ne réponds plus jamais`;
}

// ─── µ-law codec ─────────────────────────────────────────────────────────────
const UDEC = new Int16Array(256);
for(let i=0;i<256;i++){let u=~i&0xFF;const s=u&0x80,e=(u>>4)&7,m=u&0xF;let v=((m<<3)+0x84)<<e;v-=0x84;UDEC[i]=s?-v:v;}
const u2p  = u=>{ const p=new Int16Array(u.length); for(let i=0;i<u.length;i++) p[i]=UDEC[u[i]]; return p; };
const r8_24= p=>{ const o=new Int16Array(p.length*3); for(let i=0;i<p.length;i++){const c=p[i],n=i+1<p.length?p[i+1]:c;o[i*3]=c;o[i*3+1]=Math.round(c*.667+n*.333);o[i*3+2]=Math.round(c*.333+n*.667);} return o; };
const r24_8= p=>{ const l=Math.floor(p.length/3),o=new Int16Array(l); for(let i=0;i<l;i++) o[i]=Math.round((p[i*3]+p[i*3+1]+p[i*3+2])/3); return o; };
const p2u  = s=>{ const B=0x84,M=32767;let v=Math.max(-M,Math.min(M,s));const sg=v<0?0x80:0;if(v<0)v=-v;v=Math.min(v+B,M);let e=7;for(let m=0x4000;(v&m)===0&&e>0;e--,m>>=1){}return ~(sg|(e<<4)|((v>>(e+3))&0xF))&0xFF; };
const pb2u = p=>{ const o=new Uint8Array(p.length); for(let i=0;i<p.length;i++) o[i]=p2u(p[i]); return o; };

// ─── Config par défaut module-level ──────────────────────────────────────────
let DEF_CFG = null; // sera initialisé au premier appel

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', async (ws, req) => {
  console.log(`[WS] Nouvelle connexion depuis ${req.socket.remoteAddress}`);

  let callerRaw = '', toRaw = '', callSid = 'unknown';
  let streamSid = '', ready = false;
  let oai = null;
  const queue = [], transcript = [];
  let curAss = '';
  let lead   = { nom:'', tel:'', besoin:'', agent:'', ville:'', prix:'', ref:'' };
  let saved  = false;
  let cfg    = null;
  let callTimer = null;  // Timer 2 minutes

  // ─── Sauvegarder le lead et envoyer l'email ───────────────────────────────
  function flush() {
    if (saved) return; saved = true;
    if (!cfg) cfg = DEF_CFG;
    if (callTimer) { clearTimeout(callTimer); callTimer = null; }

    const tx  = transcript.map(m=>`${m.r==='a'?'IA':'Client'}: ${m.t}`).join('\n');
    const ag  = lead.agent || 'Luca CIMMARUSTI';
    const now = new Date().toLocaleString('fr-FR',{timeZone:'Europe/Paris'});
    const tel = lead.tel || callerRaw;
    const clientId   = cfg.client_id || 'VX-0001';
    const discussion = transcript.map(m=>`${m.r==='a'?'Sophie':'Client'}: ${m.t}`).join('\n');

    b44Create('Lead', {
      nom:             lead.nom||'Inconnu',
      telephone:       tel,
      besoin:          lead.besoin||'Appel entrant',
      agent_nom:       ag,
      agent_initiales: ag.includes('Luca')?'LC':ag.includes('Jeff')?'JP':ag.includes('Kenny')?'KP':'',
      statut:          'Nouveau',
      notes:           `client_id:${clientId}|CallSid:${callSid}|Ville:${lead.ville||'?'}|Prix:${lead.prix||'?'}|Réf:${lead.ref||'?'}|Horodatage:${now}|Discussion:${discussion}`
    });
    console.log('[LEAD] ✅', lead.nom||'Inconnu', tel, '→', ag);

    // Incrémenter le compteur d'appels du client
    if (cfg && cfg.id) {
      const newTotal = (cfg.appels_total || 0) + 1;
      const newMois  = (cfg.appels_mois  || 0) + 1;
      b44Update('Client', cfg.id, { appels_total: newTotal, appels_mois: newMois });
      console.log(`[COUNTER] appels_total:${newTotal} appels_mois:${newMois}`);
    }

    gmailSend(
      cfg.destinataires_email,
      `🏠 Lead → ${ag} | ${tel} | ${lead.besoin||'?'} | ${lead.ville||'?'}`,
      `🏠 NOUVEAU LEAD — ${cfg.nom_agence}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nNom       : ${lead.nom||'Inconnu'}\nTéléphone : ${tel}\nBesoin    : ${lead.besoin||'?'}\nVille     : ${lead.ville||'Non précisé'}\nPrix      : ${lead.prix||'Non précisé'}\nRéférence : ${lead.ref||'Non précisé'}\nAgent     : ${ag}\nDate      : ${now}\nCallSid   : ${callSid}\n\n━━ CONVERSATION ━━\n${tx}`
    );
  }

  // ─── Raccrocher proprement via message Twilio ─────────────────────────────
  function hangup() {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
      }
    } catch(_) {}
    flush();
    setTimeout(() => {
      if (oai) try { oai.close(); } catch(_) {}
      if (ws.readyState === WebSocket.OPEN) try { ws.close(); } catch(_) {}
    }, 1500);
  }

  // ─── Timer 2 minutes ──────────────────────────────────────────────────────
  function startCallTimer() {
    callTimer = setTimeout(() => {
      console.log('[TIMER] ⏱️ 2 minutes écoulées — clôture forcée');
      // Demander à l'IA de raccrocher proprement
      if (oai && oai.readyState === WebSocket.OPEN) {
        oai.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '[SYSTÈME] Temps écoulé. Dis exactement la phrase de clôture et arrête-toi.' }]
          }
        }));
        oai.send(JSON.stringify({ type: 'response.create' }));
        // Raccrocher après que l'IA ait eu le temps de parler (5s)
        setTimeout(() => hangup(), 5000);
      } else {
        hangup();
      }
    }, CALL_MAX_MS);
  }

  // ─── Connexion OpenAI Realtime ────────────────────────────────────────────
  function connectOAI(callerNum) {
    oai = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime'],
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    oai.on('open', async () => {
      if (!cfg) {
        console.log('[OAI] ⚠️ cfg null au open → chargement fallback');
        cfg = await getClientConfig(toRaw || undefined);
      }
      console.log(`[OAI] ✅ Connecté — voice:${cfg.voix} — accueil:"${cfg.message_accueil}"`);

      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: buildPrompt(cfg, callerNum),
          voice: (['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'].includes(cfg.voix) ? cfg.voix : 'coral'),
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1', language: 'fr' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700
          },
          temperature: 0.2,            // ultra-strict
          max_response_output_tokens: 120, // ↓ réponses plus courtes
        }
      }));
    });

    oai.on('message', data => {
      try {
        const m = JSON.parse(data);

        if (m.type==='session.updated' && !ready) {
          ready = true;
          const accueilMsg = (cfg && cfg.message_accueil) ? cfg.message_accueil : 'Bonjour, comment puis-je vous aider ?';
          console.log('[OAI] Session prête → accueil:', accueilMsg.slice(0,60));

          // Forcer Sophie à prononcer le message d'accueil immédiatement
          oai.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: `Tu es Sophie. Dis UNIQUEMENT et EXACTEMENT ce message d'accueil en français, rien d'autre : "${accueilMsg}"`,
            }
          }));

          // Drainer la queue audio Twilio reçue avant que OAI soit prêt
          for (const c of queue) oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: c }));
          queue.length = 0;
        }

        if (m.type==='response.audio.delta' && m.delta && streamSid) {
          // OpenAI envoie déjà du g711_ulaw → envoi direct à Twilio sans conversion
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ event:'media', streamSid, media:{ payload: m.delta } }));
        }

        if (m.type==='response.audio_transcript.delta' && m.delta) curAss += m.delta;

        if (m.type==='response.audio_transcript.done' && curAss) {
          transcript.push({ r:'a', t:curAss });
          console.log(`[IA] "${curAss.slice(0,120)}"`);
          curAss = '';
        }

        if (m.type==='conversation.item.input_audio_transcription.completed' && m.transcript) {
          const t = m.transcript.trim();
          if (t) {
            transcript.push({ r:'u', t });
            console.log(`[Client] "${t}"`);
            const tl = t.toLowerCase();

            if (!lead.besoin) {
              if (tl.match(/achat|acheter|recherche/)) lead.besoin = 'Achat';
              else if (tl.match(/vente|vendre/))       lead.besoin = 'Vente';
              else if (tl.match(/location|louer/))     lead.besoin = 'Location';
            }
            const vm = t.match(/\b(montagny|givors|grigny|oullins|lyon|villefranche|vienne|irigny|feyzin|brignais|pierre.b[eé]nite|tassin|mornant|corbas|saint[\s-]genis|charly|pontev[eê]que)\b/i);
            if (vm && !lead.ville) lead.ville = vm[0].trim();

            const pm = t.match(/(\d[\d\s]{1,8}(?:€|euros?|k€|000))/i);
            if (pm && !lead.prix) lead.prix = pm[0].trim();

            if (!lead.nom) {
              const nm = t.match(/\b([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ][a-zàâéèêëîïôùûüç]+)\s+([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ][a-zàâéèêëîïôùûüç]+)\b/);
              if (nm) lead.nom = `${nm[1]} ${nm[2]}`;
            }
            const tm2 = t.match(/\b(0[67]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2})\b/);
            if (tm2) lead.tel = tm2[0].replace(/\s/g,'');
          }
        }

        if (m.type==='response.done') {
          const lastIA = transcript.filter(x=>x.r==='a').slice(-1)[0]?.t?.toLowerCase()||'';
          const allIA  = transcript.filter(x=>x.r==='a').map(x=>x.t).join(' ').toLowerCase();

          if (!lead.agent) {
            const am = allIA.match(/\b(luca|jeff|kenny)\b/i);
            if (am) lead.agent = am[1].toLowerCase()==='luca'?'Luca CIMMARUSTI':am[1].toLowerCase()==='jeff'?'Jeff PIGEAT':'Kenny PIGEAT';
          }

          // Clôture naturelle détectée → raccrocher
          const isClosure = lastIA.includes('très bientôt') || lastIA.includes('au revoir') || lastIA.includes('bonne journée') || lastIA.includes('à bientôt');
          if (isClosure && (lead.tel || callerRaw)) {
            console.log('[CLÔTURE] Fin détectée → raccrocher dans 2s');
            setTimeout(() => hangup(), 2000);
          }

          // Sauvegarde de sécurité si conversation longue
          if (!saved && transcript.length >= 14 && (lead.tel || callerRaw)) flush();
        }

      } catch(e) { console.error('[OAI parse]', e.message); }
    });

    oai.on('error', e => console.error('[OAI err]', e.message));
    oai.on('close', code => console.log('[OAI closed]', code));
  }

  // ─── Messages Twilio ──────────────────────────────────────────────────────
  ws.on('message', async data => {
    try {
      const m = JSON.parse(data);

      if (m.event==='connected') {
        console.log('[WS] Event: connected');
      }

      if (m.event==='start') {
        streamSid = m.start?.streamSid || '';
        const params = m.start?.customParameters || {};
        callerRaw = params.caller || callerRaw || '';
        toRaw     = params.to     || toRaw     || '';
        callSid   = params.sid    || m.start?.callSid || callSid;

        console.log(`[WS] START streamSid:${streamSid} caller:"${callerRaw}" to:"${toRaw}" sid:${callSid}`);
        console.log(`[WS] CustomParams:`, JSON.stringify(params));

        lead.tel = callerRaw.replace(/\s/g,'').replace(/^\+33/,'0').replace(/(\d{2})(?=\d)/g,'$1 ').trim();

        const numToLoad = toRaw || '';
        console.log(`[CFG] Chargement config pour: "${numToLoad}"`);
        cfg = await getClientConfig(numToLoad || undefined);
        if (!DEF_CFG) DEF_CFG = cfg; // Sauvegarder pour flush() si cfg devient null
        connectOAI(lead.tel);
        startCallTimer(); // ⏱️ Démarrer le timer 2 minutes
      }

      else if (m.event==='media' && m.media?.payload) {
        // Twilio envoie du g711_ulaw → envoi direct à OAI sans conversion
        const b64 = m.media.payload;
        if (oai && oai.readyState === WebSocket.OPEN && ready)
          oai.send(JSON.stringify({ type:'input_audio_buffer.append', audio:b64 }));
        else if (oai) queue.push(b64);
      }

      else if (m.event==='stop') {
        console.log(`[WS] STOP — ${transcript.length} échanges`);
        flush();
        if (oai) try { oai.close(); } catch(_) {}
      }

    } catch(e) { console.error('[WS parse]', e.message); }
  });

  ws.on('close', () => {
    console.log('[WS] Connexion fermée');
    flush();
    if (oai) try { oai.close(); } catch(_) {}
  });
  ws.on('error', e => console.error('[WS err]', e.message));
});

const PORT = process.env.PORT || 80;
server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v22 listening on port ${PORT}`));
