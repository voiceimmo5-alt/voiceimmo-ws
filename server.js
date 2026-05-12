/**
 * VoiceImmo WebSocket Server — Railway v3
 * Fix: paramètres via <Parameter> Twilio + gestion robuste WS
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
app.get('/', (req, res) => res.json({ status: 'ok', version: 'v3-railway', service: 'VoiceImmo WS' }));

// ─── TwiML endpoint ───────────────────────────────────────────────────────────
app.post('/twiml', (req, res) => {
  const caller = req.body.From    || req.body.Caller || '';
  const to     = req.body.To      || req.body.Called || '';
  const sid    = req.body.CallSid || '';

  console.log(`[TWIML v3] From:${caller} To:${to} Sid:${sid}`);

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
    const r = await fetch(`https://fr-2758ee0c.base44.app/api/entities/${entity}/`, {
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, Accept: 'application/json' }
    });
    const d = await r.json();
    return Array.isArray(d) ? d : (d.records || []);
  } catch(e) { console.error(`[B44] ${entity}:`, e.message); return []; }
}

async function b44Create(entity, data) {
  try {
    const r = await fetch(`https://fr-2758ee0c.base44.app/api/entities/${entity}/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error(`[B44] create ${entity} ERREUR ${r.status}:`, txt);
    } else {
      console.log(`[B44] ✅ ${entity} créé — status ${r.status}`);
    }
    return r.ok ? JSON.parse(txt) : null;
  } catch(e) { console.error(`[B44] create ${entity} EXCEPTION:`, e.message); return null; }
}

async function b44Update(entity, id, data) {
  try {
    const r = await fetch(`https://fr-2758ee0c.base44.app/api/entities/${entity}/${id}/`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!r.ok) console.error(`[B44] update ${entity}/${id} ERREUR ${r.status}`);
    else console.log(`[B44] ✅ ${entity}/${id} mis à jour`);
  } catch(e) { console.error(`[B44] update ${entity}:`, e.message); }
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
    if (gr.ok) {
      console.log(`[EMAIL] ✅ Envoyé | id:${gd.id} | to:${toAddr} | subject:${subject}`);
      console.log(`[EMAIL] 📝 Contenu: ${body.slice(0,300).replace(/\n/g,' ')}`);
    } else {
      console.error(`[EMAIL] ❌ Échec | to:${toAddr} | err:${JSON.stringify(gd)}`);
    }
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
    console.log(`[CFG] Recherche client pour: "${normNum}" (original: "${numeroTwilio}")`);
    const clients = await b44List('Client');
    console.log(`[CFG] ${clients.length} clients en base`);
    const client = clients.find(c => {
      if (!c.numero_actuel) return false;
      const cn = c.numero_actuel.replace(/\s/g,'');
      return cn === normNum || cn === normNum.replace(/^\+33/,'0') || ('0'+normNum.replace(/^\+33/,'')) === cn;
    });

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

    const VMAP = { Sophie:'shimmer',Claire:'nova',Isabelle:'alloy',Emma:'echo',Thomas:'fable',Nicolas:'onyx',
                   shimmer:'shimmer',nova:'nova',alloy:'alloy',echo:'echo',fable:'fable',onyx:'onyx' };

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
    try {
      const acList = await b44List('AgenceConfig');
      const agCfg  = acList.find(a => a.numero_twilio?.replace(/\s/g,'') === normNum) || acList[0];
      if (agCfg?.annonces_cache) cfg.annonces_cache = agCfg.annonces_cache;
    } catch(_) {}

    // Stocker l'id DB du client pour les mises à jour de compteurs
    cfg.clientDbId           = client.id || null;
    cfg.appels_total         = client.appels_total  || 0;
    cfg.appels_mois          = client.appels_mois   || 0;
    cfg.appels_pack          = client.appels_pack   || 200;
    cfg.appels_seuil_alerte  = client.appels_seuil_alerte || 20;
    cfg.alerte_envoyee       = client.alerte_envoyee || false;
    cfg.alerte_email         = client.alerte_email  || '';
    cfg.plan                 = client.plan          || 'Starter';
    console.log(`[CFG] accueil="${cfg.message_accueil}" voix=${cfg.voix} pack=${cfg.appels_pack} mois=${cfg.appels_mois}`);
    return cfg;
  } catch(e) { console.error('[CFG] Erreur:', e.message); return DEF; }
}

function buildPrompt(cfg, callerNum) {
  const accueil  = (cfg.message_accueil||'').trim() || `${cfg.nom_agence}, bonjour !`;
  const annonces = cfg.annonces_cache ? `\nBIENS DISPONIBLES :\n${cfg.annonces_cache}` : '\n(Aucune annonce disponible pour l\'instant)';

  // Si un scénario IA est défini, il est PRIORITAIRE et remplace le flux par défaut
  if (cfg.scraping_format && cfg.scraping_format.trim()) {
    const scenario = cfg.scraping_format.trim()
      .replace(/\[NUMÉRO\]/g, callerNum||'numéro non détecté')
      .replace(/\[numéro\]/gi, callerNum||'numéro non détecté');

    return `Tu es l'assistante téléphonique de ${cfg.nom_agence}. Tu parles UNIQUEMENT en français, jamais en anglais.

━━ ACCUEIL OBLIGATOIRE ━━
Ta toute première phrase doit être EXACTEMENT : "${accueil}"
Commence DIRECTEMENT par cette phrase, sans rien ajouter avant.

━━ SCÉNARIO À SUIVRE STRICTEMENT ━━
${scenario}

Agents par secteur :
${cfg.agents}

Horaires : ${cfg.horaires}
${annonces}

RÈGLES ABSOLUES :
- TOUJOURS en français
- Une seule question par réponse
- Suis le scénario ci-dessus à la lettre
- Commence par "${accueil}" sans exception`;
  }

  // Flux par défaut (si pas de scénario défini)
  return `Tu es l'assistante téléphonique de ${cfg.nom_agence}. Tu parles UNIQUEMENT en français. Tu es chaleureuse, concise et naturelle.

━━ ACCUEIL OBLIGATOIRE ━━
Ta toute première phrase doit être EXACTEMENT : "${accueil}"
Rien d'autre avant. Commence DIRECTEMENT par cette phrase.

━━ FLUX DE L'APPEL ━━
1. Besoin : achat / vente / renseignement ?
2. Ville ou secteur ?
3. Budget envisagé ?
4. Prénom et nom ?
5. Confirmation numéro : "Vous appelez depuis le ${callerNum||'numéro non détecté'}, c'est bien votre numéro de rappel ?"
6. Clôture : "Merci pour votre appel, à très bientôt !" puis raccrocher immédiatement.

Agents par secteur :
${cfg.agents}

Horaires : ${cfg.horaires}
${annonces}

RÈGLES ABSOLUES :
- TOUJOURS en français
- Une seule question par réponse
- Max 2 phrases par tour
- Commence par "${accueil}" sans exception`;
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

  async function flush() {
    if (saved || !cfg) return; saved = true;
    const tx  = transcript.map(m=>`${m.r==='a'?'IA':'Client'}: ${m.t}`).join('\n');
    const ag  = lead.agent || 'Luca CIMMARUSTI';
    const now = new Date().toLocaleString('fr-FR',{timeZone:'Europe/Paris'});
    const tel = lead.tel || callerRaw;
    // Créer le lead en base
    const leadResult = await b44Create('Lead', {
      nom: lead.nom||'Inconnu', telephone: tel,
      besoin: lead.besoin||'Appel entrant', agent_nom: ag,
      agent_initiales: lead.agent ? lead.agent.split(' ').map(w=>w[0]).join('').toUpperCase() : 'LC',
      statut: 'Nouveau',
      notes: `Ville:${lead.ville||'?'}|Prix:${lead.prix||'?'}|Réf:${lead.ref||'?'}|CallSid:${callSid}|client_id:${cfg.client_id||'?'}\n\n${tx}`
    });
    console.log('[LEAD] Résultat création:', leadResult ? '✅ OK id='+leadResult.id : '❌ ECHEC');
    console.log('[LEAD] ✅', lead.nom||'Inconnu', tel, '→', ag);

    // Incrémenter les compteurs d'appels du client
    if (cfg.clientDbId) {
      const newTotal = (cfg.appels_total||0) + 1;
      const newMois  = (cfg.appels_mois||0) + 1;
      const pack     = cfg.appels_pack || 200;
      const seuil    = cfg.appels_seuil_alerte || 20;
      const restants = pack - newMois;
      await b44Update('Client', cfg.clientDbId, {
        appels_total: newTotal,
        appels_mois:  newMois,
        alerte_envoyee: restants <= 0 ? true : cfg.alerte_envoyee
      });
      console.log(`[COMPTEUR] total=${newTotal} mois=${newMois} restants=${restants}`);

      // Alerte seuil si restants <= seuil et pas encore envoyée
      if (!cfg.alerte_envoyee && restants <= seuil && restants > 0 && cfg.alerte_email) {
        const alertDest = cfg.alerte_email || cfg.destinataires_email;
        gmailSend(alertDest,
          `⚠️ Alerte Voxzen — Il vous reste ${restants} appels`,
          `⚠️ ALERTE CRÉDIT APPELS — ${cfg.nom_agence}

Il vous reste seulement ${restants} appels dans votre pack ${cfg.plan||'Starter'}.

Appels utilisés ce mois : ${newMois} / ${pack}

Pour éviter toute interruption de service, pensez à contacter Voxzen pour upgrader votre plan.

📧 contact@voxzen.io
🌐 voxzen.io

— L'équipe Voxzen`
        );
        await b44Update('Client', cfg.clientDbId, { alerte_envoyee: true });
        console.log(`[ALERTE] ✅ Seuil atteint (${restants} restants) → email envoyé à ${alertDest}`);
      }
      // Alerte pack épuisé
      if (restants <= 0 && !cfg.alerte_envoyee) {
        const alertDest = cfg.alerte_email || cfg.destinataires_email;
        gmailSend(alertDest,
          `🚨 Pack épuisé — Voxzen VoiceImmo`,
          `🚨 PACK D'APPELS ÉPUISÉ — ${cfg.nom_agence}

Vous avez consommé tous vos ${pack} appels inclus dans votre pack ${cfg.plan||'Starter'}.

Les appels supplémentaires sont facturés 0,30€/appel.

Contactez-nous pour upgrader votre plan et bénéficier d'un tarif plus avantageux.

📧 contact@voxzen.io

— L'équipe Voxzen`
        );
        console.log(`[ALERTE] 🚨 Pack épuisé → email envoyé`);
      }
    }
    gmailSend(cfg.destinataires_email,
      `🏠 Lead → ${ag} | ${tel} | ${lead.besoin||'?'} | ${lead.ville||'?'}`,
      `🏠 NOUVEAU LEAD — ${cfg.nom_agence}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\nNom       : ${lead.nom||'Inconnu'}\nTéléphone : ${tel}\nBesoin    : ${lead.besoin||'?'}\nVille     : ${lead.ville||'Non précisé'}\nPrix      : ${lead.prix||'Non précisé'}\nRéférence : ${lead.ref||'Non précisé'}\nAgent     : ${ag}\nDate      : ${now}\nCallSid   : ${callSid}\n\n━━ CONVERSATION ━━\n${tx}`
    );
  }

  function connectOAI(callerNum) {
    oai = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      ['realtime', `openai-insecure-api-key.${OPENAI_API_KEY}`, 'openai-beta.realtime-v1']
    );
    oai.on('open', () => {
      console.log(`[OAI] ✅ Connecté — voice:${cfg.voix}`);
      oai.send(JSON.stringify({ type:'session.update', session:{
        modalities:['text','audio'],
        instructions: buildPrompt(cfg, callerNum),
        voice: cfg.voix || 'shimmer',
        input_audio_format:'pcm16',
        output_audio_format:'pcm16',
        input_audio_transcription:{ model:'whisper-1' },
        turn_detection:{ type:'server_vad', threshold:0.5, prefix_padding_ms:300, silence_duration_ms:700 },
        temperature:0.6,
        max_response_output_tokens:150,
      }}));
    });

    oai.on('message', data => {
      try {
        const m = JSON.parse(data);
        if ((m.type==='session.created'||m.type==='session.updated') && !ready) {
          ready = true;
          const accueil = (cfg.message_accueil||'').trim() || `${cfg.nom_agence}, bonjour !`;
          console.log(`[OAI] Session prête → accueil forcé: "${accueil}"`);
          // Injecter le message d'accueil exact comme premier tour assistant
          oai.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'input_text', text: accueil }]
            }
          }));
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
          console.log(`[IA] "${curAss.slice(0,120)}"`);
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
          const isEnd = lastIA.includes('très bientôt') || lastIA.includes('au revoir') || lastIA.includes('bonne journée');
          if (isEnd && (lead.tel||callerRaw)) {
            flush();
            // Attendre que l'audio soit joué puis raccrocher
            setTimeout(() => {
              try {
                if (ws.readyState === WebSocket.OPEN) {
                  // Envoyer un mark pour savoir quand l'audio est terminé
                  ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'end_of_call' } }));
                  console.log('[WS] Signal raccrochage envoyé');
                }
              } catch(e) { console.error('[WS hangup]', e.message); }
            }, 3500);
          }
          if (!saved && transcript.length >= 14 && (lead.tel||callerRaw)) flush();
        }
        // Quand Twilio confirme la fin de l'audio → raccrocher
        if (m.type==='response.done') { /* handled above */ }
      } catch(e) { console.error('[OAI parse]',e.message); }
    });

    oai.on('error', e => console.error('[OAI err]',e.message));
    oai.on('close', code => console.log('[OAI closed]',code));
  }

  ws.on('message', async data => {
    try {
      const m = JSON.parse(data);

      if (m.event==='connected') {
        console.log('[WS] Event: connected');
      }

      if (m.event==='start') {
        streamSid  = m.start?.streamSid || '';
        // Récupérer les paramètres depuis customParameters
        const params = m.start?.customParameters || {};
        callerRaw  = params.caller || callerRaw || '';
        toRaw      = params.to     || toRaw     || '';
        callSid    = params.sid    || m.start?.callSid || callSid;

        console.log(`[WS] START streamSid:${streamSid} caller:"${callerRaw}" to:"${toRaw}" sid:${callSid}`);

        lead.tel = callerRaw.replace(/\s/g,'').replace(/^\+33/,'0').replace(/(\d{2})(?=\d)/g,'$1 ').trim();

        // Charger config client puis connecter OpenAI
        cfg = await getClientConfig(toRaw || undefined);
        const callerNum = lead.tel;
        connectOAI(callerNum);
      }

      else if (m.event==='media' && m.media?.payload) {
        const ulaw = Buffer.from(m.media.payload,'base64');
        const pcm  = u2p(new Uint8Array(ulaw));
        const up   = r8_24(pcm);
        const b64  = Buffer.from(new Int16Array(up).buffer).toString('base64');
        if (oai && oai.readyState===WebSocket.OPEN && ready)
          oai.send(JSON.stringify({ type:'input_audio_buffer.append', audio:b64 }));
        else if (oai) queue.push(b64);
      }

      else if (m.event==='mark') {
        const markName = m.mark?.name || '';
        console.log(`[WS] Mark reçu: ${markName}`);
        if (markName === 'end_of_call') {
          console.log('[WS] Audio terminé → raccrochage');
          flush();
          if (oai) try{oai.close();}catch(_){}
          ws.close();
        }
      }

      else if (m.event==='stop') {
        console.log(`[WS] STOP — ${transcript.length} échanges`);
        flush();
        if (oai) try{oai.close();}catch(_){}
      }
    } catch(e) { console.error('[WS parse]',e.message); }
  });

  ws.on('close', ()=>{ console.log('[WS] Connexion fermée'); flush(); if(oai) try{oai.close();}catch(_){} });
  ws.on('error', e=>console.error('[WS err]',e.message));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 VoiceImmo v3 démarré port ${PORT}`));
