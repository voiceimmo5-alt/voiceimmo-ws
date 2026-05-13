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
const BASE44_API_KEY = process.env.BASE44_SERVICE_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMDg4NGYwOS00Njg2LTQwMDQtYmU2ZS00YjA2OThhMzFlYzMiLCJjbGllbnRfaWQiOiJmMDg4NGYwOS00Njg2LTQwMDQtYmU2ZS00YjA2OThhMzFlYzMiLCJhcHBfaWQiOiI2OWVkY2JmZjFjNTJmNmU4Mjc1OGVlMGMiLCJhdWQiOiJiYXNlNDRfYXBpIiwic2NvcGUiOiJhcHAuYWNjZXNzIiwiZXhwIjoxNzc4NjM2MzM3LCJpYXQiOjE3Nzg2MzI3Mzd9.jI5B36ujp340x-z-rFVZ2j3sAMXZPsBKGcJ2-1IKmSI';

// Limite d'appel en ms (2 minutes)
const CALL_MAX_MS = 2 * 60 * 1000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', version: "v5-fr-forced", service: 'VoiceImmo WS' }));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

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

// ─── Helpers Base44 ───────────────────────────────────────────────────────────
async function b44List(entity) {
  try {
    const r = await fetch(`https://fr-2758ee0c.base44.app/api/entities/${entity}`, {
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'Accept': 'application/json' }
    });
    const d = await r.json();
    return Array.isArray(d) ? d : (d.records || []);
  } catch(e) { console.error(`[B44] ${entity}:`, e.message); return []; }
}

async function b44Create(entity, data) {
  try {
    const r = await fetch(`https://fr-2758ee0c.base44.app/api/entities/${entity}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const txt = await r.text();
    if (r.ok) { console.log(`[B44] ✅ ${entity} créé OK`); return JSON.parse(txt); }
    else { console.error(`[B44] create ${entity} ERREUR ${r.status}:`, txt.slice(0,200)); return null; }
  } catch(e) { console.error(`[B44] create ${entity}:`, e.message); return null; }
}

async function b44Update(entity, id, data) {
  try {
    const r = await fetch(`https://fr-2758ee0c.base44.app/api/entities/${entity}/${id}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const txt = await r.text();
    if (r.ok) { console.log(`[B44] ✅ ${entity}/${id} mis à jour`); return JSON.parse(txt); }
    else { console.error(`[B44] update ${entity} ERREUR ${r.status}:`, txt.slice(0,200)); return null; }
  } catch(e) { console.error(`[B44] update ${entity}:`, e.message); return null; }
}

async function gmailSend(toAddr, subject, body) {
  try {
    const tr = await fetch(`https://fr-2758ee0c.base44.app/api/connectors/gmail/token`, {
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}` }
    });
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
  const DEF = {
    nom_agence: 'LEONE IMMOBILIER',
    horaires: 'du lundi au samedi de 09h30 à 12h et de 14h à 19h',
    destinataires_email: process.env.NOTIFICATION_EMAIL || 'christophe.despretz@gmail.com',
    agents: 'Jeff PIGEAT : Villefranche-sur-Saône, Beaujolais, Nord Rhône\nKenny PIGEAT : Givors, Grigny, Vienne, Sud Rhône\nLuca CIMMARUSTI : Pierre-Bénite, Oullins, Lyon et tout autre secteur',
    annonces_cache: '', voix: 'shimmer',
    message_accueil: 'Leone Immobilier, bonjour !',
    scraping_format: '', site_internet: '',
  };

  if (!numeroTwilio) return DEF;

  try {
    const normNum = numeroTwilio.replace(/\s/g, '');
    console.log(`[CFG] Recherche client pour: "${normNum}"`);
    const clients = await b44List('Client');
    console.log(`[CFG] ${clients.length} clients en base`);
    const client = clients.find(c => c.numero_actuel && c.numero_actuel.replace(/\s/g,'') === normNum);

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
      client_id:           client.client_id || client.id,
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

ÉTAPE 3 — Secteur :
→ "Dans quel secteur ou quelle ville recherchez-vous ?"

ÉTAPE 4 — Budget :
→ "Quel est votre budget ?"

ÉTAPE 5 — Identité :
→ "Pouvez-vous me donner votre prénom et votre nom ?"

ÉTAPE 6 — Confirmation numéro :
→ "Je vois que vous appelez depuis le ${callerNum||'numéro non détecté'}, c'est bien votre numéro de rappel ?"

ÉTAPE 7 — CLÔTURE (mot pour mot, puis silence) :
"Merci pour votre appel, nous avons bien noté votre demande, l'agent commercial en charge de ce secteur va rapidement vous rappeler, merci d'avoir contacté l'agence Léone Immobilier et à très bientôt !"

━━ BIENS DISPONIBLES ━━
${annonces}

━━ AGENTS PAR SECTEUR ━━
${cfg.agents}

━━ RÈGLES ABSOLUES ━━
- LANGUE : français uniquement, sans exception
- DURÉE max : 2 minutes — sois efficace
- 1 question à la fois, max 2 phrases par réponse
- Ne jamais inventer de bien immobilier
- Après l'ÉTAPE 7 : ne réponds plus, silence total`;
}

// ─── µ-law codec ─────────────────────────────────────────────────────────────
const UDEC = new Int16Array(256);
for(let i=0;i<256;i++){let u=~i&0xFF;const s=u&0x80,e=(u>>4)&7,m=u&0xF;let v=((m<<3)+0x84)<<e;v-=0x84;UDEC[i]=s?-v:v;}
const u2p  = u=>{ const p=new Int16Array(u.length); for(let i=0;i<u.length;i++) p[i]=UDEC[u[i]]; return p; };
const r8_24= p=>{ const o=new Int16Array(p.length*3); for(let i=0;i<p.length;i++){const c=p[i],n=i+1<p.length?p[i+1]:c;o[i*3]=c;o[i*3+1]=Math.round(c*.667+n*.333);o[i*3+2]=Math.round(c*.333+n*.667);} return o; };
const r24_8= p=>{ const l=Math.floor(p.length/3),o=new Int16Array(l); for(let i=0;i<l;i++) o[i]=Math.round((p[i*3]+p[i*3+1]+p[i*3+2])/3); return o; };
const p2u  = s=>{ const B=0x84,M=32767;let v=Math.max(-M,Math.min(M,s));const sg=v<0?0x80:0;if(v<0)v=-v;v=Math.min(v+B,M);let e=7;for(let m=0x4000;(v&m)===0&&e>0;e--,m>>=1){}return ~(sg|(e<<4)|((v>>(e+3))&0xF))&0xFF; };
const pb2u = p=>{ const o=new Uint8Array(p.length); for(let i=0;i<p.length;i++) o[i]=p2u(p[i]); return o; };

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
    if (saved || !cfg) return; saved = true;
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
      ['realtime', `openai-insecure-api-key.${OPENAI_API_KEY}`, 'openai-beta.realtime-v1']
    );

    oai.on('open', async () => {
      if (!cfg) {
        console.log('[OAI] ⚠️ cfg null au open → chargement fallback');
        cfg = await getClientConfig(toRaw || undefined);
      }
      console.log(`[OAI] ✅ Connecté — voice:${cfg.voix} — accueil:"${cfg.message_accueil}"`);

      const forcedInstructions = `[SYSTEM OVERRIDE - MANDATORY]
YOU MUST SPEAK FRENCH ONLY. NEVER SPEAK ENGLISH. EVERY SINGLE WORD YOU SAY MUST BE IN FRENCH.
IF YOU SPEAK ENGLISH FOR ANY REASON, YOU FAIL YOUR TASK.

` + buildPrompt(cfg, callerNum);

      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: forcedInstructions,
          voice: cfg.voix || 'shimmer',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1', language: 'fr' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700
          },
          temperature: 0.4,
          max_response_output_tokens: 120,
        }
      }));
    });

    oai.on('message', data => {
      try {
        const m = JSON.parse(data);

        if ((m.type==='session.created' || m.type==='session.updated') && !ready) {
          ready = true;
          console.log('[OAI] Session prête → déclenchement réponse initiale');
          // Injecter le message d'accueil en français directement
          const accueilMsg = (cfg && cfg.message_accueil) ? cfg.message_accueil : 'Bonjour, agence Leone Immobilier, comment puis-je vous aider ?';
          oai.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '[DÉBUT APPEL - réponds UNIQUEMENT en FRANÇAIS avec exactement ce message d accueil: ' + accueilMsg + ']' }]
            }
          }));
          oai.send(JSON.stringify({ type: 'response.create' }));
          for (const c of queue) oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: c }));
          queue.length = 0;
        }

        if (m.type==='response.audio.delta' && m.delta && streamSid) {
          const raw  = Buffer.from(m.delta, 'base64');
          const pcm  = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
          const ulaw = pb2u(r24_8(pcm));
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ event:'media', streamSid, media:{ payload: Buffer.from(ulaw).toString('base64') } }));
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
        connectOAI(lead.tel);
        startCallTimer(); // ⏱️ Démarrer le timer 2 minutes
      }

      else if (m.event==='media' && m.media?.payload) {
        const ulaw = Buffer.from(m.media.payload, 'base64');
        const pcm  = u2p(new Uint8Array(ulaw));
        const up   = r8_24(pcm);
        const b64  = Buffer.from(new Int16Array(up).buffer).toString('base64');
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
server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v4 listening on port ${PORT}`));
