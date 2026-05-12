/**
 * VoiceImmo WebSocket Server — Railway v2
 * - GET / → health check
 * - POST /twiml → retourne le TwiML pour Twilio
 * - WSS / → Media Stream handler
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/' });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const APP_ID         = '69edcbff1c52f6e82758ee0c';
const BASE44_API_KEY = process.env.BASE44_SERVICE_TOKEN || '';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', version: 'v2-railway', service: 'VoiceImmo WS' }));

// ─── TwiML endpoint (appelé par Twilio) ──────────────────────────────────────
app.post('/twiml', (req, res) => {
  const caller = req.body.From || req.body.Caller || '';
  const to     = req.body.To   || req.body.Called  || '';
  const sid    = req.body.CallSid || '';
  const host   = req.headers.host || 'voiceimmo-ws-production.up.railway.app';

  console.log(`[TWIML] From:${caller} To:${to} Sid:${sid}`);

  const wsUrl = `wss://${host}?caller=${encodeURIComponent(caller)}&to=${encodeURIComponent(to)}&sid=${encodeURIComponent(sid)}`;

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
});

// ─── Helpers Base44 ───────────────────────────────────────────────────────────
async function b44List(entity) {
  try {
    const r = await fetch(`https://api.base44.com/api/apps/${APP_ID}/entities/${entity}/`, {
      headers: { 'x-api-key': BASE44_API_KEY, Accept: 'application/json' }
    });
    const d = await r.json();
    return Array.isArray(d) ? d : (d.records || []);
  } catch(e) { console.error(`[B44] ${entity}:`, e.message); return []; }
}

async function b44Create(entity, data) {
  try {
    await fetch(`https://api.base44.com/api/apps/${APP_ID}/entities/${entity}/`, {
      method: 'POST',
      headers: { 'x-api-key': BASE44_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch(e) { console.error(`[B44] create ${entity}:`, e.message); }
}

async function gmailSend(to, subject, body) {
  try {
    const tr = await fetch(`https://api.base44.com/api/apps/${APP_ID}/connectors/gmail/token`, {
      headers: { 'x-api-key': BASE44_API_KEY }
    });
    const { access_token } = await tr.json();

    const msg = [
      `From: Voxzen VoiceImmo <contact@voxzen.io>`,
      `Cc: voiceimmo5@gmail.com`,
      `To: ${to}`,
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
    const clients = await b44List('Client');
    const client  = clients.find(c => c.numero_actuel && c.numero_actuel.replace(/\s/g,'') === normNum);

    if (!client) { console.log(`[CFG] ⚠️ Pas de client pour ${normNum}`); return DEF; }
    console.log(`[CFG] ✅ ${client.nom_entreprise} (${client.client_id})`);

    let agentsStr = DEF.agents;
    if (client.agents) {
      try {
        const arr = typeof client.agents === 'string' ? JSON.parse(client.agents) : client.agents;
        if (Array.isArray(arr)) agentsStr = arr.map(a => `${a.nom} : ${a.zones||'—'}`).join('\n');
        else agentsStr = String(client.agents);
      } catch { agentsStr = String(client.agents)||DEF.agents; }
    }

    const VMAP = { Sophie:'shimmer',Claire:'nova',Isabelle:'alloy',Emma:'echo',Thomas:'fable',Nicolas:'onyx',shimmer:'shimmer',nova:'nova',alloy:'alloy',echo:'echo',fable:'fable',onyx:'onyx' };
    const cfg = {
      ...DEF,
      nom_agence:          client.nom_entreprise || DEF.nom_agence,
      destinataires_email: client.destinataires_email || DEF.destinataires_email,
      voix:                VMAP[client.voix] || 'shimmer',
      message_accueil:     (client.message_accueil||'').trim() || `${client.nom_entreprise||DEF.nom_agence}, bonjour !`,
      horaires:            client.horaires || DEF.horaires,
      agents:              agentsStr,
      site_internet:       client.site_internet || '',
      scraping_format:     client.scraping_format || '',
      client_id:           client.client_id || client.id,
      annonces_cache:      '',
    };

    // Annonces depuis AgenceConfig
    const acList = await b44List('AgenceConfig');
    const agCfg  = acList.find(a => a.numero_twilio?.replace(/\s/g,'') === normNum) || acList[0];
    if (agCfg?.annonces_cache) cfg.annonces_cache = agCfg.annonces_cache;

    console.log(`[CFG] accueil="${cfg.message_accueil}" voix=${cfg.voix}`);
    return cfg;
  } catch(e) { console.error('[CFG]', e.message); return DEF; }
}

function buildPrompt(cfg, callerNum) {
  const accueil  = (cfg.message_accueil||'').trim() || `${cfg.nom_agence}, bonjour !`;
  const annonces = cfg.annonces_cache ? `\nBIENS DISPONIBLES :\n${cfg.annonces_cache}` : '\n(Aucune annonce disponible pour l\'instant)';
  const scenario = cfg.scraping_format?.trim() ? `\n━━ INSTRUCTIONS CLIENT (PRIORITAIRES) ━━\n${cfg.scraping_format.trim()}\n━━━━━━━━━━━━━━━━━━━━━━━━` : '';

  return `Tu es l'assistante téléphonique de ${cfg.nom_agence}. Tu parles uniquement français. Tu es chaleureuse, concise et naturelle.

━━ ACCUEIL OBLIGATOIRE ━━
Ta toute première phrase doit être EXACTEMENT : "${accueil}"
Rien d'autre avant. Pas de prénom. Pas de présentation.

━━ FLUX DE L'APPEL ━━
Pose UNE seule question à la fois, dans cet ordre :
ÉTAPE 1 — BESOIN : "Vous recherchez plutôt un achat ou une vente ?"
ÉTAPE 2 — VILLE : "Dans quelle ville ou quel secteur ?"
ÉTAPE 3 — BUDGET : "Quel est votre budget ?" (si pas déjà mentionné)
ÉTAPE 4 — NOM : "Votre prénom et nom ?"
ÉTAPE 5 — CONFIRMATION NUMÉRO : "Je vois que vous appelez depuis le ${callerNum||'numéro non détecté'}, c'est bien votre numéro de rappel ?"
ÉTAPE 6 — CLÔTURE : "Merci pour votre appel, à très bientôt !" puis raccrocher.

━━ RÈGLES ━━
- JAMAIS enchaîner deux étapes dans la même réponse
- JAMAIS raccrocher avant d'avoir le nom ET la confirmation du numéro
- Réponses courtes, max 2 phrases par tour
- Toujours attendre la réponse avant de passer à l'étape suivante
${scenario}

Agents par secteur :
${cfg.agents}

Horaires : ${cfg.horaires}
Numéro appelant détecté : ${callerNum || 'non détecté'}
${annonces}`;
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
  const uparams   = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const callerRaw = uparams.get('caller') || '';
  const toRaw     = uparams.get('to')     || '';
  const callSid   = uparams.get('sid')    || 'unknown';

  console.log(`[WS] ✅ caller:"${callerRaw}" to:"${toRaw}" sid:${callSid}`);

  const cfg       = await getClientConfig(toRaw || undefined);
  const callerNum = callerRaw.replace(/\s/g,'').replace(/^\+33/,'0').replace(/(\d{2})(?=\d)/g,'$1 ').trim();
  const voice     = cfg.voix || 'shimmer';

  let oai = null, streamSid = '', ready = false;
  const queue = [], transcript = [];
  let curAss = '';
  let lead   = { nom:'', tel:callerNum, besoin:'', agent:'', ville:'', prix:'', ref:'' };
  let saved  = false;

  function flush() {
    if (saved) return; saved = true;
    const tx  = transcript.map(m=>`${m.r==='a'?'IA':'Client'}: ${m.t}`).join('\n');
    const ag  = lead.agent || 'Luca CIMMARUSTI';
    const now = new Date().toLocaleString('fr-FR',{timeZone:'Europe/Paris'});
    b44Create('Lead', { nom:lead.nom||'Inconnu', telephone:lead.tel||callerNum, besoin:lead.besoin||'Appel entrant', agent_nom:ag, statut:'Nouveau', notes:`CallSid:${callSid}|Ville:${lead.ville||'?'}|Prix:${lead.prix||'?'}|Réf:${lead.ref||'?'}` });
    console.log('[LEAD] ✅', lead.nom||'Inconnu', lead.tel||callerNum, '→', ag);
    gmailSend(cfg.destinataires_email,
      `🏠 Lead → ${ag} | ${lead.tel||callerNum} | ${lead.besoin||'?'} | ${lead.ville||'?'}`,
      `🏠 NOUVEAU LEAD — ${cfg.nom_agence}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nNom       : ${lead.nom||'Inconnu'}\nTéléphone : ${lead.tel||callerNum}\nBesoin    : ${lead.besoin||'?'}\nVille     : ${lead.ville||'Non précisé'}\nPrix      : ${lead.prix||'Non précisé'}\nRéférence : ${lead.ref||'Non précisé'}\nAgent     : ${ag}\nDate      : ${now}\nCallSid   : ${callSid}\n\n━━ CONVERSATION ━━\n${tx}`
    );
  }

  function connectOAI() {
    oai = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime', `openai-insecure-api-key.${OPENAI_API_KEY}`, 'openai-beta.realtime-v1']
    );
    oai.on('open', () => {
      console.log(`[OAI] connecté voice:${voice}`);
      oai.send(JSON.stringify({ type:'session.update', session:{
        modalities:['text','audio'], instructions:buildPrompt(cfg,callerNum), voice,
        input_audio_format:'pcm16', output_audio_format:'pcm16',
        input_audio_transcription:{ model:'whisper-1' },
        turn_detection:{ type:'server_vad', threshold:0.5, prefix_padding_ms:300, silence_duration_ms:700 },
        temperature:0.6, max_response_output_tokens:150,
      }}));
    });
    oai.on('message', data => {
      try {
        const m = JSON.parse(data);
        if ((m.type==='session.created'||m.type==='session.updated') && !ready) {
          ready = true;
          oai.send(JSON.stringify({ type:'response.create' }));
          for(const c of queue) oai.send(JSON.stringify({ type:'input_audio_buffer.append', audio:c }));
          queue.length = 0;
        }
        if (m.type==='response.audio.delta' && m.delta && streamSid) {
          const raw  = Buffer.from(m.delta,'base64');
          const pcm  = new Int16Array(raw.buffer, raw.byteOffset, raw.length/2);
          const ulaw = pb2u(r24_8(pcm));
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ event:'media', streamSid, media:{ payload: Buffer.from(ulaw).toString('base64') } }));
        }
        if (m.type==='response.audio_transcript.delta' && m.delta) curAss += m.delta;
        if (m.type==='response.audio_transcript.done' && curAss) {
          transcript.push({r:'a',t:curAss});
          console.log(`[IA] "${curAss.slice(0,100)}"`);
          curAss = '';
        }
        if (m.type==='conversation.item.input_audio_transcription.completed' && m.transcript) {
          const t = m.transcript.trim();
          if (t) {
            transcript.push({r:'u',t});
            console.log(`[Client] "${t}"`);
            const tl = t.toLowerCase();
            if (!lead.besoin) {
              if (tl.match(/achat|acheter|recherche/)) lead.besoin = 'Achat';
              else if (tl.match(/vente|vendre/))       lead.besoin = 'Vente';
              else if (tl.match(/location|louer/))     lead.besoin = 'Location';
            }
            const vm = t.match(/\b(montagny|givors|grigny|oullins|lyon|villefranche|vienne|irigny|feyzin|brignais|pierre.b[eé]nite|tassin|mornant|corbas)\b/i);
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
          const allIA  = transcript.filter(x=>x.r==='a').map(x=>x.t).join(' ').toLowerCase();
          const lastIA = transcript.filter(x=>x.r==='a').slice(-1)[0]?.t?.toLowerCase()||'';
          if (!lead.agent) {
            const am = allIA.match(/\b(luca|jeff|kenny)\b/i);
            if (am) lead.agent = am[1].toLowerCase()==='luca'?'Luca CIMMARUSTI':am[1].toLowerCase()==='jeff'?'Jeff PIGEAT':'Kenny PIGEAT';
          }
          if (!saved && (lastIA.includes('très bientôt')||lastIA.includes('au revoir')) && lead.tel) flush();
          if (!saved && transcript.length >= 10 && lead.tel) flush();
        }
      } catch(e) { console.error('[OAI]',e.message); }
    });
    oai.on('error', e => console.error('[OAI err]',e.message));
    oai.on('close', code => console.log('[OAI closed]',code));
  }

  connectOAI();

  ws.on('message', data => {
    try {
      const m = JSON.parse(data);
      if (m.event==='start') {
        streamSid = m.start?.streamSid || '';
        console.log('[WS] streamSid:', streamSid);
      } else if (m.event==='media' && m.media?.payload) {
        const ulaw = Buffer.from(m.media.payload,'base64');
        const pcm  = u2p(new Uint8Array(ulaw));
        const up   = r8_24(pcm);
        const b64  = Buffer.from(new Int16Array(up).buffer).toString('base64');
        if (oai && oai.readyState===WebSocket.OPEN && ready)
          oai.send(JSON.stringify({ type:'input_audio_buffer.append', audio:b64 }));
        else queue.push(b64);
      } else if (m.event==='stop') {
        console.log('[WS] stop', transcript.length,'échanges');
        flush();
        if (oai) try{oai.close();}catch(_){}
      }
    } catch(e) { console.error('[WS parse]',e.message); }
  });

  ws.on('close', ()=>{ console.log('[WS] fermé'); flush(); if(oai) try{oai.close();}catch(_){} });
  ws.on('error', e=>console.error('[WS err]',e.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 VoiceImmo v2 démarré port ${PORT}`));
