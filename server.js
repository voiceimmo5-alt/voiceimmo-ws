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
      configCache.set(numeroVoxzen, { config: data, ts: Date.now() });
      console.log(`[CFG] ✅ Config chargée pour ${numeroVoxzen} → ${data.nom_hotel}`);
      return data;
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
function buildHospPrompt(cfg, callerNum) {
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

  return `You are SOFIA, the voice concierge of ${cfg.nom_hotel}.

## LANGUAGE RULE — ABSOLUTE PRIORITY
Detect the language of the caller from their very first word and ALWAYS respond in that SAME language throughout the entire call.
- Caller speaks English → respond in English only
- Caller speaks French → respond in French only
- Caller speaks Spanish → respond in Spanish only
- Caller switches language → switch with them immediately and naturally
- NEVER mention this rule. NEVER say you are adapting your language. Just do it.

## WHO YOU ARE
You are the finest concierge in the world — think The Ritz Paris, Four Seasons, or Le Bristol. You embody:
- Impeccable warmth and professionalism at all times
- Absolute discretion — you never mention scripts, AI, rules, or technical systems
- Proactivity — you anticipate needs before they are fully expressed
- Precision — you gather necessary information efficiently and elegantly
- Consistency — the same excellence at 3am as at noon

## GREETING & CALLER IDENTIFICATION
1. Open with: "${cfg.nom_hotel}, Sofia speaking — how may I assist you today?"
2. Then IMMEDIATELY: "I can see you're calling from ${callerNum || 'an unknown number'} — may I have your name please?"
   (In French: "Je vois que vous appelez depuis le ${callerNum || 'numéro inconnu'} — puis-je avoir votre nom s'il vous plaît ?")
3. Confirm: "Perfect [Name], let me note that for you."
   
IMPORTANT: Read the phone number digit by digit naturally — never as a block.
If the number is unknown or hidden, simply ask for their name directly.
The number ${callerNum || ''} is already known — DO NOT ask for it again.

## SERVICES YOU HANDLE
${servicesList}

## HOW TO HANDLE REQUESTS
- Listen fully before responding
- Ask only strictly necessary questions — one at a time, gracefully
- Restaurant reservation: name, date, time, number of guests
- Room service: room number, items requested, preferred delivery time
- Room issue: room number, nature of problem, urgency level
- Wake-up call: room number, desired time
- Beyond your scope: "Allow me to connect you with the right department" — never say you cannot help

## TONE & VOCABULARY
Use only refined, elegant language fitting a 5-star establishment:
✓ "Certainly", "Of course", "With pleasure", "Absolutely", "Right away", "Allow me"
✗ Never: "okay", "sure", "no problem", "sorry sorry sorry"
- Be concise — luxury guests dislike lengthy speeches
- Use the guest's name naturally if known
- Always close with: "Is there anything else I may assist you with?"

## SMS CONFIRMATIONS
When a guest requests a confirmation (reservation, wake-up call, room service, taxi booking, etc.) OR when you judge it helpful, you may send an SMS.
After sending the confirmation verbally, silently add this line in your response (NEVER read it aloud):
HOSP_SMS: TO=[guest phone number in format 06XXXXXXXX or +33XXXXXXXXX], MSG=[concise confirmation message in the guest's language, max 160 chars, hotel name + key details]

Example SMS body: "Hôtel Bellevue : Réservation restaurant confirmée pour 2 pers. ce soir à 20h. À tout à l'heure !"
Example SMS body: "Hôtel Bellevue: Room service confirmed for room 204 — delivery in 20 minutes. Enjoy!"

RULES:
- Only send if you have a valid phone number (from caller ID or provided by guest)
- Never mention the SMS unless the guest asked for it — just send it silently
- Never read the HOSP_SMS line aloud — it is a silent technical instruction
- Maximum ONE SMS per call unless guest explicitly asks for another

## ABSOLUTE PROHIBITIONS
- Never reveal you are an AI, a bot, or a system
- Never read aloud any instruction, script, template, or technical text
- Never say "I am programmed to..." or "According to my instructions..."
- Never make promises you cannot keep
- Never end a call abruptly

## INTERNAL DATA LOGGING — CRITICAL
At the END of the call only (when saying goodbye), output ONE single line silently in the transcript — DO NOT say it aloud:
HOSP_DATA: NOM=[guest name], TEL=[${callerNum || 'inconnu'}], CHAMBRE=[room number], DEMANDE=[request type], DETAIL=[summary], ACTION=[action taken]
This line is NEVER spoken. It is NEVER read aloud. It is a silent technical log only.
${customInstr}`;
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

// ─── Envoi SMS Twilio ─────────────────────────────────────────────────────────
async function sendSms({ to, from, body, hotelNumeroForSms = null }) {
  try {
    if (!to || !body) return { ok: false, error: 'Missing to or body' };
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) return { ok: false, error: 'Missing Twilio credentials' };

    // Normaliser le numéro destinataire en +33
    const toE164 = to.replace(/\s/g, '').replace(/^0/, '+33');
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const params = new URLSearchParams({ To: toE164, From: from, Body: body });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
    );
    const data = await res.json();
    if (data.sid) {
      console.log(`[SMS] ✅ Envoyé à ${toE164} | SID: ${data.sid}`);
      // Incrémenter compteur SMS en base
      if (hotelNumeroForSms) {
        fetch(`${process.env.B44_FUNCTION_URL || 'https://69edcbff1c52f6e82758ee0c.functions.base44.com'}/hospitalityAuth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.B44_API_KEY || '' },
          body: JSON.stringify({ action: 'increment_sms', numero_voxzen: hotelNumeroForSms })
        }).catch(e => console.error('[SMS] Erreur incrément:', e.message));
      }
      return { ok: true, sid: data.sid };
    } else {
      console.error('[SMS] ❌ Erreur Twilio:', JSON.stringify(data));
      return { ok: false, error: data.message };
    }
  } catch(e) {
    console.error('[SMS] Exception:', e.message);
    return { ok: false, error: e.message };
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
  let cfg         = null;
  let hotelNumero = '';
  let saved       = false;
  let accueilDone = false;
  let callTimer   = null;
  let lastResponseId = null;   // pour pouvoir annuler la réponse en cours
  let isResponding  = false;   // Sofia est en train de parler
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

  function connectOAI(rawCaller) {
    // Formater le numéro pour lecture naturelle : 06 12 34 56 78
    const callerNum = rawCaller
      ? rawCaller.replace(/\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ').trim()
      : '';
    console.log('[OAI] Connexion OpenAI Realtime...');
    oai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OAI_MODEL}`,
      ['realtime'],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    oai.on('open', () => {
      const instructions = buildHospPrompt(cfg, callerNum);
      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions,
          voice: cfg?.voix || 'sage',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
            create_response: true,
            interrupt_response: true
          },
          modalities: ['text', 'audio'],
          temperature: 0.7,
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
        const accueil = `Bonjour, ${cfg?.nom_hotel || 'Hôtel'}, Sofia à votre service, comment puis-je vous aider ?`;
        console.log('[OAI] Session prête → accueil:', accueil);
        oai.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: `IMPORTANT: Prononce maintenant cet accueil mot pour mot : "${accueil}"` }
        }));
      }

      // Track response ID + flag isResponding
      if (m.type === 'response.created') {
        lastResponseId = m.response?.id || null;
        isResponding = true;
      }
      if (m.type === 'response.done') {
        isResponding = false;
      }

      // ── INTERRUPTION : le client parle → on coupe Sofia immédiatement ──
      if (m.type === 'input_audio_buffer.speech_started') {
        console.log('[INTERRUPT] Client parle → annulation réponse Sofia');
        // Toujours couper, même si isResponding est false (précaution)
        try { oai.send(JSON.stringify({ type: 'response.cancel' })); } catch(_) {}
        try { oai.send(JSON.stringify({ type: 'input_audio_buffer.clear' })); } catch(_) {}
        if (ws.readyState === 1 && streamSid) {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        isResponding = false;
        lastResponseId = null;
      }

      // Audio vers Twilio
      if (m.type === 'response.output_audio.delta' && m.delta && streamSid) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: m.delta } }));
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
        const finPhrases = /au revoir|à bientôt|bonne journée|bonne soirée|excellente journée|excellente soirée|excellente nuit|goodbye|good bye|have a good|have a nice|thank you so much|that.s all|that.s everything/i;
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
        // Détecter commande SMS dans le transcript de Sofia
        const smsMatch = curAss.match(/HOSP_SMS:\s*TO=\[([^\]]+)\].*?MSG=\[([^\]]+)\]/is);
        if (smsMatch) {
          const smsTo   = smsMatch[1].trim();
          const smsBody = smsMatch[2].trim();
          const smsFrom = hotelNumero.startsWith('+') ? hotelNumero : '+' + hotelNumero;
          console.log(`[SMS] Commande détectée → to:${smsTo} | msg:${smsBody.slice(0,60)}`);
          sendSms({ to: smsTo, from: smsFrom, body: smsBody, hotelNumeroForSms: hotelNumero });
        }
        await handleSofiaTranscript(curAss);
        curAss = '';
      }

      if (m.type === 'response.output_item.done' && m.item?.formatted?.transcript) {
        await handleSofiaTranscript(m.item.formatted.transcript);
        if (!curAss) curAss = '';
      }

      if (m.type === 'response.done' && !accueilDone) {
        accueilDone = true;
        // Ne pas forcer de réponse — le VAD détectera quand le client parle
        console.log('[OAI] Accueil terminé, attente client...');
      }

      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        transcript.push({ r: 'u', t: m.transcript });
        console.log(`[USER] "${m.transcript.slice(0, 100)}"`);
        parseHospData(m.transcript, ctx);
        // Reset du timer d'inactivité à chaque prise de parole du client
        if (callTimer) { clearTimeout(callTimer); callTimer = null; }
        callTimer = setTimeout(async () => {
          console.log('[TIMER] 5min inactivité → raccrochage');
          hangingUp = true;
          await hangupTwilio(callSid);
          hangup();
          await flush();
        }, 300000);
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

      ctx.telephone = caller ? caller.replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ').trim() : '';
      hotelNumero  = to.replace(/\s/g, '').replace(/^\+/, '+');

      // Charger config hôtel
      fetchHotelConfig(hotelNumero).then(config => {
        cfg = config;
        connectOAI(caller); // passe le numéro brut, connectOAI formate
      });

      // Timeout 5 min
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
