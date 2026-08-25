'use strict';
const http      = require('http');
const express   = require('express');
const { WebSocketServer, WebSocket } = require('ws');


// ─── Fond sonore PAD (chargé au démarrage, scope global) ────────────────────
const _fs   = require('fs');
const _path = require('path');
let PAD_PCM = null;
try {
  const raw = _fs.readFileSync(_path.join(__dirname, 'voxzen_pad.wav'));
  // Parser le WAV proprement — le chunk 'data' n'est PAS toujours à l'offset 44
  // (ffmpeg mulaw génère des chunks fmt(18)+fact+LIST avant data)
  let wavOffset = 12; // skip RIFF header
  let dataOffset = 44; // fallback si parsing échoue
  while (wavOffset < raw.length - 8) {
    const chunkId   = raw.slice(wavOffset, wavOffset + 4).toString('ascii');
    const chunkSize = raw.readUInt32LE(wavOffset + 4);
    if (chunkId === 'data') {
      dataOffset = wavOffset + 8; // après l'entête du chunk (4 id + 4 size)
      break;
    }
    wavOffset += 8 + chunkSize + (chunkSize % 2 !== 0 ? 1 : 0);
  }
  PAD_PCM = raw.slice(dataOffset);
  console.log('[PAD] Fond sonore chargé : offset=' + dataOffset + ', ' + Math.round(PAD_PCM.length/1024) + ' KB, ' + (PAD_PCM.length/8000).toFixed(1) + 's');
} catch(e) {
  console.warn('[PAD] voxzen_pad.wav introuvable — pas de fond sonore :', e.message);
}

function mixMulaw(src, pad, vol) {
  vol = vol || 0.15;
  const MULAW_BIAS = 33;
  const mulaw2pcm = (u) => {
    u = ~u & 0xFF;
    const sign = u & 0x80;
    const exp  = (u >> 4) & 0x07;
    const mant = (u & 0x0F) + MULAW_BIAS;
    let s = (mant << (exp + 1)) - MULAW_BIAS;
    return sign ? -s : s;
  };
  const EXP_LUT = [0,132,396,924,1980,4092,8316,16764];
  const pcm2mulaw = (s) => {
    const CLIP = 32635;
    const sign = (s < 0) ? 0x80 : 0;
    if (s < 0) s = -s;
    if (s > CLIP) s = CLIP;
    s += MULAW_BIAS;
    let exp = 7;
    for (; exp >= 0 && s < EXP_LUT[exp]; exp--) {}
    const mant = (s >> (exp + 1)) & 0x0F;
    return (~(sign | (exp << 4) | mant)) & 0xFF;
  };
  const len = Math.min(src.length, pad.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    let mixed = mulaw2pcm(src[i]) + Math.round(mulaw2pcm(pad[i]) * vol);
    if (mixed >  32767) mixed =  32767;
    if (mixed < -32768) mixed = -32768;
    out[i] = pcm2mulaw(mixed);
  }
  return out;
}
// ────────────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

// Fix RSV1 — DOIT être AVANT la création du WSS pour que notre handler passe en premier
// Railway Hikari peut injecter de la compression WS — on la supprime ici
server.on('upgrade', (req, socket, head) => {
  delete req.headers['sec-websocket-extensions'];
  req.headers['sec-websocket-extensions'] = '';
});

const wss    = new WebSocketServer({ server, perMessageDeflate: false });

// Route Stripe raw body — DOIT être avant express.json()
// ─── Stripe — Webhook ────────────────────────────────────────────────────────
// IMPORTANT : raw body AVANT express.json() — à placer avant app.use(express.json())
// mais on utilise express.raw() directement sur la route

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = verifyStripeSignature(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[STRIPE] ❌ Signature invalide:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }
  res.json({ received: true });
  console.log('[STRIPE] Event reçu:', event.type);
  try {
    if (event.type === 'invoice.payment_succeeded') {
      await handlePaymentSucceeded(event.data.object);
    } else if (event.type === 'invoice.payment_failed') {
      await handlePaymentFailed(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object);
    } else if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object);
    }
  } catch (err) {
    console.error('[STRIPE] ❌ Erreur traitement event:', err.message);
  }
});



// ─── Route auto-login token (appelée par merci.html) ─────────────────────────
app.get('/get-autologin-token', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { token, session_id } = req.query;
  let resolvedToken = token;
  if (!resolvedToken && session_id) resolvedToken = AUTOLOGIN_BY_SESSION.get(session_id);
  if (!resolvedToken) return res.json({ ok: false, error: 'token manquant' });
  const data = AUTOLOGIN_TOKENS.get(resolvedToken);
  if (!data || data.expires < Date.now()) {
    return res.json({ ok: false, error: 'token invalide ou expiré' });
  }
  res.json({ ok: true, email: data.email, nom_agence: data.nom_agence, token: resolvedToken });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Buffer de logs circulaire ───────────────────────────────────────────────
const LOG_BUFFER = [];
const MAX_LOGS = 200;
const origLog   = console.log;
const origError = console.error;
function pushLog(level, args) {
  const line = { ts: Date.now(), level, msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') };
  LOG_BUFFER.push(line);
  if (LOG_BUFFER.length > MAX_LOGS) LOG_BUFFER.shift();
}
console.log   = (...a) => { origLog(...a);   pushLog('info',  a); };
console.error = (...a) => { origError(...a); pushLog('error', a); };

// ─── Variables d'environnement ───────────────────────────────────────────────
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || '';
// ─── Détection automatique du modèle OpenAI Realtime ─────────────────────────
const OAI_MODEL = process.env.OAI_MODEL || 'gpt-4o-realtime-preview';

// const GMAIL_CLIENT_ID    = process.env.GMAIL_CLIENT_ID    || '';
// const GMAIL_CLIENT_SECRET= process.env.GMAIL_CLIENT_SECRET|| '';
// const GMAIL_REFRESH_TOKEN= process.env.GMAIL_REFRESH_TOKEN|| '';
// const GMAIL_FROM         = process.env.GMAIL_FROM         || 'voiceimmo5@gmail.com';
const BASE44_PROXY_URL   = 'https://fr-2758ee0c.base44.app/functions/getClientConfig';
const BASE44_API_KEY     = process.env.BASE44_API_KEY     || '';
const BASE44_APP_URL     = 'https://fr-2758ee0c.base44.app/functions';

const RESEND_API_KEY        = process.env.RESEND_API_KEY        || '';
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY     || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE44_WRITE_URL      = 'https://fr-2758ee0c.base44.app/functions';


// ─── Config clients (dynamique depuis Base44) ────────────────────────────────
// Fallback hardcodé si le proxy est indisponible
const CONFIGS_FALLBACK = {
  '+33939245959': {
    nom_agence:          'LEONE IMMOBILIER',
    client_db_id:        '6a0cdf1388a8c7697ae8a452',
    voix:                'shimmer',
    site_internet:       'https://www.leone-immobilier.fr',
    message_accueil:     "Bonjour et bienvenue chez Leone Immobilier, comment puis-je vous aider ?",
    instructions_ia:     null,
    agents_arr: [
      { nom: 'Luca',  email: 'leone.immobilier@gmail.com',      zones: 'givors, irigny, st genis laval, corbas, oullins, pierre-benite, charly' },
      { nom: 'Kenny', email: 'kenny.leoneimmobilier@gmail.com',  zones: 'villette de vienne, vienne, roussillon, grigny' },
      { nom: 'Jeff',  email: 'jeff.leoneimmobilier@gmail.com',   zones: 'villefontaine, nord rhone, beaujolais, villefranche' }
    ],
    destinataires_email: ['leone.immobilier@gmail.com', 'christophe.despretz@gmail.com'],
  },
  '+33939247019': {
    nom_agence:          'LEONE IMMOBILIER (STAGING)',
    client_db_id:        '6a057fa03ad6f7b2ebf4b79e',
    voix:                'shimmer',
    site_internet:       'https://www.leone-immobilier.fr',
    message_accueil:     "Bonjour, ceci est le serveur de test Leone Immobilier. Comment puis-je vous aider ?",
    instructions_ia:     null,
    agents_arr: [
      { nom: 'Luca',  email: 'leone.immobilier@gmail.com',      zones: 'givors, irigny, st genis laval, corbas, oullins, pierre-benite' },
      { nom: 'Kenny', email: 'kenny.leoneimmobilier@gmail.com',  zones: 'villette de vienne, vienne, roussillon' },
      { nom: 'Jeff',  email: 'jeff.leoneimmobilier@gmail.com',   zones: 'villefontaine, nord rhone, beaujolais' }
    ],
    destinataires_email: ['christophe.despretz@gmail.com'],
  }
};

// Cache dynamique — mis à jour depuis Base44 toutes les 5 minutes
let CONFIGS = { ...CONFIGS_FALLBACK };

// ─── Auto-login token store (onboarding Stripe) ──────────────────────────────
const AUTOLOGIN_TOKENS = new Map(); // token -> { email, nom_agence, expires }
const AUTOLOGIN_BY_SESSION = new Map(); // session_id -> token
function storeAutologinToken(token, email, nom_agence, sessionId) {
  const data = { email, nom_agence, expires: Date.now() + 15 * 60 * 1000 }; // 15 min
  AUTOLOGIN_TOKENS.set(token, data);
  if (sessionId) AUTOLOGIN_BY_SESSION.set(sessionId, token);
  // Nettoyage auto
  setTimeout(() => { AUTOLOGIN_TOKENS.delete(token); AUTOLOGIN_BY_SESSION.delete(sessionId); }, 15 * 60 * 1000);
}


function mapClientToConfig(c) {
  // Convertit un enregistrement Client Base44 en config voicebot
  const num = c.numero_actuel || '';
  const fallback = CONFIGS_FALLBACK[num] || {};
  let agents_arr = fallback.agents_arr || [];
  if (c.agents && typeof c.agents === 'string') {
    try { agents_arr = JSON.parse(c.agents); } catch(e) {}
  } else if (Array.isArray(c.agents)) {
    agents_arr = c.agents;
  }
  let dest = fallback.destinataires_email || [];
  if (c.destinataires_email) {
    if (typeof c.destinataires_email === 'string') {
      dest = c.destinataires_email.split(',').map(e => e.trim()).filter(Boolean);
    } else if (Array.isArray(c.destinataires_email)) {
      dest = c.destinataires_email;
    }
  }
  return {
    nom_agence:           c.nom_entreprise || fallback.nom_agence || 'VoiceImmo',
    client_db_id:         c.id || fallback.client_db_id,
    voix:                 c.voix || fallback.voix || 'shimmer',
    site_internet:        c.site_internet || fallback.site_internet || '',
    message_accueil:      c.message_accueil || fallback.message_accueil || 'Bonjour, comment puis-je vous aider ?',
    instructions_ia:      c.instructions_ia || null,
    modele_metier:        c.modele_metier || fallback.modele_metier || 'IMMO',
    agents_arr,
    destinataires_email:  dest,
    enregistrement_actif: c.enregistrement_actif === true,
  };
}

async function refreshConfigs() {
  try {
    const url = BASE44_PROXY_URL;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const clients = data.clients || [];
    const newConfigs = { ...CONFIGS_FALLBACK };
    for (const c of clients) {
      if (c.numero_actuel) {
        newConfigs[c.numero_actuel] = mapClientToConfig(c);
      }
    }
    CONFIGS = newConfigs;
    console.log(`[CFG] ✅ Config rechargée depuis Base44 — ${clients.length} client(s): ${Object.keys(newConfigs).join(', ')}`);
  } catch(e) {
    console.warn('[CFG] ⚠️ Impossible de charger Base44, config fallback utilisée:', e.message);
  }
}

// Charger au démarrage puis toutes les 5 minutes
refreshConfigs();
setInterval(refreshConfigs, 5 * 60 * 1000);

const DEF_CFG = () => CONFIGS['+33939245959'] || Object.values(CONFIGS)[0];

function getConfig(numTwilio) {
  const key = numTwilio.startsWith('+') ? numTwilio : `+${numTwilio}`;
  const cfg = CONFIGS[key];
  if (cfg) { console.log(`[CFG] Config trouvée pour ${key}: ${cfg.nom_agence}`); return cfg; }
  console.log(`[CFG] Numéro ${key} inconnu → fallback`);
  return DEF_CFG();
}


// ─── Envoyer email via Resend ────────────────────────────────────────────────
async function sendResend(to, subject, html) {
  const toArr = Array.isArray(to) ? to : [to];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'VoiceImmo <no-reply@voxzen.io>',
      to: toArr,
      cc: ['voiceimmo5@gmail.com'],
      subject,
      html
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Resend error ' + res.status + ': ' + err);
  }
  return true;
}

// ─── Pending emails (attend le recording avant envoi) ───────────────────────
const pendingEmails = new Map(); // callSid → { lead, cfg, transcript, timer }

// ─── Email notification lead ──────────────────────────────────────────────────
async function sendEmail(lead, cfg, transcript, recordingUrl) {
  if (!RESEND_API_KEY) {
    console.log('[EMAIL] RESEND_API_KEY absent → email ignoré');
    return false;
  }
  try {
    const agentTrouve = (cfg.agents || []).find(a =>
      (lead.agent_initiales||'').toLowerCase().split('/').map(s=>s.trim()).some(ini => a.nom.split(' ')[0].toLowerCase() === ini) ||
      (lead.ville||'').toLowerCase().split(' ').some(v => a.zones.toLowerCase().includes(v))
    );
    const destAgent = agentTrouve ? agentTrouve.email : null;
    const destList = [...new Set([...(cfg.destinataires_email||[]), destAgent, 'voiceimmo5@gmail.com'].filter(Boolean))];
    const agentLabel = agentTrouve ? agentTrouve.nom : (lead.agent_initiales || 'N/A');
    const html = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">'
      + '<div style="background:#4f46e5;color:#fff;padding:24px;border-radius:12px 12px 0 0">'
      + '<h2 style="margin:0">&#127968; Nouveau lead &mdash; ' + (cfg.nom_agence||'VoiceImmo') + '</h2>'
      + '</div>'
      + '<div style="padding:24px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">'
      + '<table style="width:100%;border-collapse:collapse">'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold;width:140px">Nom</td><td style="padding:8px">' + (lead.nom||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Téléphone</td><td style="padding:8px"><a href="tel:' + (lead.telephone||'').replace(/\s/g,'') + '" style="color:#4f46e5;font-weight:700;text-decoration:none;font-size:16px">' + (lead.telephone||'N/A') + '</a></td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Besoin</td><td style="padding:8px">' + (lead.besoin||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Ville</td><td style="padding:8px">' + (lead.ville||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Prix</td><td style="padding:8px">' + (lead.prix||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Référence</td><td style="padding:8px">' + (lead.reference||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Agent</td><td style="padding:8px">' + agentLabel + '</td></tr>'
      + '</table>'
      + (recordingUrl ? '<p style="margin-top:20px;color:#6b7280;font-size:13px">&#127897; Enregistrement de l\'appel en pi&egrave;ce jointe.</p>' : '')
      + '<div style="margin-top:24px;text-align:center">'
      + '<a href="' + (process.env.WS_BASE_URL || 'https://ws-staging.voiceimmo.fr') + '/mark-lead-done?id=' + (lead.id||'') + '" '
      + 'style="display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:#fff;text-decoration:none;padding:12px 32px;border-radius:10px;font-weight:700;font-size:15px">&#9989; Marquer comme Trait&eacute;</a>'
      + '</div>'
      + '</div></div>';

    // Construire l'email avec ou sans pièce jointe MP3
    const emailPayload = {
      from: 'VoiceImmo <no-reply@voxzen.io>',
      to: destList,
      subject: 'Nouveau lead VoiceImmo — ' + (lead.nom||'Inconnu'),
      html
    };

    // Attacher l'enregistrement MP3 si disponible
    if (recordingUrl) {
      try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken  = process.env.TWILIO_AUTH_TOKEN;
        // Extraire le RecordingSid depuis l'URL proxy ws-staging.voiceimmo.fr/recording/RExxxx
        const recSidMatch = recordingUrl.match(/\/recording\/(RE[a-z0-9]+)/i);
        if (recSidMatch) {
          const recSid = recSidMatch[1];
          const twilioMp3Url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recSid}.mp3`;
          const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
          const mp3Res = await fetch(twilioMp3Url, { headers: { 'Authorization': authHeader } });
          if (mp3Res.ok) {
            const mp3Buf = await mp3Res.arrayBuffer();
            const mp3B64 = Buffer.from(mp3Buf).toString('base64');
            const nomLead = (lead.nom || 'lead').replace(/\s+/g, '_');
            emailPayload.attachments = [{
              filename: `appel_${nomLead}.mp3`,
              content: mp3B64,
              type: 'audio/mpeg',
              disposition: 'attachment'
            }];
            console.log('[EMAIL] 🎙️ MP3 attaché (' + Math.round(mp3Buf.byteLength / 1024) + ' KB)');
          }
        }
      } catch(e) {
        console.warn('[EMAIL] ⚠️ Impossible d\'attacher le MP3:', e.message);
      }
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload)
    });
    if (!res.ok) throw new Error('Resend ' + res.status + ': ' + await res.text());
    console.log('[EMAIL] ✅ Email envoyé via Resend à:', destList.join(', '));
    return true;
  } catch(e) {
    console.error('[EMAIL] ❌ Erreur Resend:', e.message);
    return false;
  }
}

// ─── Email OTP Admin ──────────────────────────────────────────────────────────
async function sendOtpEmail(to, code, expiry) {
  const html = '<div style="font-family:sans-serif;max-width:400px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">'
    + '<h2 style="color:#4f46e5">⚡ Voxzen Admin</h2>'
    + '<p>Votre code de connexion :</p>'
    + '<div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#111;text-align:center;padding:16px;background:#f3f4f6;border-radius:8px">' + code + '</div>'
    + '<p style="color:#6b7280;font-size:13px">Valide jusqu\'à ' + expiry + ' — Ne partagez pas ce code.</p>'
    + '</div>';
  await sendResend(to, 'Code OTP Voxzen Admin - ' + code, html);
  return true;
}

// ─── Email bienvenue nouveau client ──────────────────────────────────────────
async function sendWelcomeEmail(email, nom_agence, login, setPasswordLink) {
  const html = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">'
    + '<div style="background:#4f46e5;color:#fff;padding:32px;border-radius:12px 12px 0 0;text-align:center">'
    + '<h1 style="margin:0;font-size:28px">🎉 Bienvenue sur Voxzen !</h1>'
    + '<p style="margin:8px 0 0;opacity:0.9">Votre agent IA est prêt</p>'
    + '</div>'
    + '<div style="padding:32px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">'
    + '<p style="font-size:16px">Bonjour <strong>' + nom_agence + '</strong>,</p>'
    + '<p>Votre abonnement Voxzen est actif. Voici vos informations de connexion :</p>'
    + '<div style="background:#f3f4f6;border-radius:8px;padding:20px;margin:20px 0">'
    + '<p style="margin:0"><strong>Identifiant :</strong> ' + login + '</p>'
    + '</div>'
    + '<div style="text-align:center;margin:32px 0">'
    + '<a href="' + setPasswordLink + '" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px">Définir mon mot de passe</a>'
    + '</div>'
    + '<p style="color:#6b7280;font-size:13px">Ce lien est valable 72h. Si vous n\'avez pas souscrit à Voxzen, ignorez cet email.</p>'
    + '</div></div>';
  await sendResend(email, 'Bienvenue sur Voxzen — Activez votre compte', html);
  return true;
}

// ─── Stripe — Handlers ───────────────────────────────────────────────────────

async function handlePaymentSucceeded(invoice) {
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;
  const plan = await getPlanFromSubscription(subscriptionId);
  console.log('[STRIPE] ✅ Paiement réussi — customer:', customerId, 'plan:', plan);

  // Chercher le client existant
  let client = await findClientByStripeId(customerId);

  if (client) {
    // Mettre à jour le statut paiement
    await base44UpdateClient(client.id, {
      stripe_payment_status: 'active',
      stripe_last_payment: new Date().toISOString().split('T')[0],
      stripe_payment_failed_at: null,
      alerte_envoyee: false,
      statut: 'Actif'
    });
    console.log('[STRIPE] ✅ Client mis à jour:', client.nom_entreprise);
  } else {
    // Nouveau client — onboarding automatique
    console.log('[STRIPE] 🆕 Nouveau client, onboarding...');
    await handleNewClientOnboarding(invoice, customerId, subscriptionId, plan);
  }
}

async function handlePaymentFailed(invoice) {
  const customerId = invoice.customer;
  console.log('[STRIPE] ❌ Paiement échoué — customer:', customerId);
  const client = await findClientByStripeId(customerId);
  if (!client) return console.log('[STRIPE] Client introuvable pour', customerId);

  const failedAt = client.stripe_payment_failed_at;
  const now = Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

  await base44UpdateClient(client.id, {
    stripe_payment_status: 'failed',
    stripe_payment_failed_at: new Date().toISOString()
  });

  if (failedAt && (now - new Date(failedAt).getTime()) > twoDaysMs) {
    // +48h → suspendre Twilio
    console.log('[STRIPE] ⏰ +48h sans paiement → suspension Twilio');
    await suspendTwilioNumber(client.numero_actuel);
    await base44UpdateClient(client.id, { statut: 'Suspendu' });
  }

  // Notifier par email
  if (client.email && RESEND_API_KEY) {
    const html = '<p>Bonjour <strong>' + (client.nom_entreprise||'') + '</strong>,</p>'
      + '<p>Le paiement de votre abonnement Voxzen a échoué. Veuillez mettre à jour votre moyen de paiement dans les 48h pour éviter la suspension de votre service.</p>'
      + '<p><a href="https://app.voxzen.io">Accéder à mon compte</a></p>';
    await sendResend(client.email, 'Action requise — Échec de paiement Voxzen', html);
  }
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  console.log('[STRIPE] 🗑️ Subscription supprimée — customer:', customerId);
  const client = await findClientByStripeId(customerId);
  if (!client) return;
  await suspendTwilioNumber(client.numero_actuel);
  await base44UpdateClient(client.id, { statut: 'Résilié', stripe_payment_status: 'cancelled' });
}

async function handleCheckoutCompleted(session) {
  const customerId = session.customer;
  console.log('[STRIPE] 💳 Checkout complété — customer:', customerId, '→ onboarding géré par invoice.payment_succeeded');
  // Ne pas créer le client ici — invoice.payment_succeeded arrive dans la foulée et s'en charge
  // Cela évite la double création
}

async function handleNewClientOnboarding(obj, customerId, subscriptionId, plan) {
  try {
    // Récupérer les infos customer Stripe
    const customer = await stripeRequest('GET', '/v1/customers/' + customerId, null);
    const email = customer.email || obj.customer_email || '';
    const nom_agence = customer.metadata?.agence_nom || customer.name || email.split('@')[0];
    const login = email;
    const planFinal = plan || customer.metadata?.plan || 'starter';

    // Créer le client dans Base44
    const newClient = {
      email,
      login,
      nom_entreprise: nom_agence,
      plan: planFinal,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId || '',
      stripe_payment_status: 'active',
      stripe_last_payment: new Date().toISOString().split('T')[0],
      statut: 'Actif',
      date_souscription: new Date().toISOString().split('T')[0],
      message_accueil: 'Bonjour, vous êtes bien chez ' + nom_agence + '. Comment puis-je vous aider ?',
      instructions_ia: 'Tu es un assistant téléphonique pour l\'agence ' + nom_agence + '. Réponds de façon professionnelle et chaleureuse.',
      voix: 'shimmer',
      appels_total: 0,
      appels_mois: 0,
      appels_pack: planFinal === 'premium' ? 500 : planFinal === 'pro' ? 200 : 100,
      periode_reset: 'mensuel'
    };

    const created = await base44CreateClient(newClient);
    console.log('[STRIPE] ✅ Nouveau client créé:', email, '| id:', created?.id);

    // Envoyer email de bienvenue avec lien set-password
    if (email && RESEND_API_KEY) {
      const token = Buffer.from(email + ':' + Date.now()).toString('base64url');
      const sessionId = obj.metadata?.checkout_session_id || obj.subscription || '';
      storeAutologinToken(token, email, nom_agence, sessionId);
      const setPasswordLink = 'https://app.voxzen.io/set-password?token=' + token + '&email=' + encodeURIComponent(email);
      await sendWelcomeEmail(email, nom_agence, login, setPasswordLink);
      console.log('[STRIPE] 📧 Email bienvenue envoyé à:', email);
    }
  } catch (e) {
    console.error('[STRIPE] ❌ Erreur onboarding:', e.message);
  }
}

// ─── Stripe — Utilitaires ─────────────────────────────────────────────────────

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!secret || !sigHeader) return JSON.parse(payload.toString());
  const crypto = require('crypto');
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const ts = parts.t;
  const sig = parts.v1;
  const signed = ts + '.' + payload.toString();
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  if (expected !== sig) throw new Error('Signature Stripe invalide');
  return JSON.parse(payload.toString());
}

async function stripeRequest(method, path, params) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const body = params ? new URLSearchParams(params).toString() : '';
    const options = {
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
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

async function getPlanFromSubscription(subscriptionId) {
  if (!subscriptionId) return 'starter';
  try {
    const sub = await stripeRequest('GET', '/v1/subscriptions/' + subscriptionId, null);
    const priceId = sub.items?.data?.[0]?.price?.id || '';
    if (priceId.includes('premium') || priceId === 'price_1TioXoBBo7r41OM6JJKF5O4b' || priceId === 'price_1TioXoBBo7r41OM6abc123') return 'premium';
    if (priceId.includes('pro') || priceId === 'price_1TioWiBBo7r41OM6y0iNLqd0' || priceId === 'price_1TioWiBBo7r41OM6abc123') return 'pro';
    return 'starter';
  } catch { return 'starter'; }
}

async function findClientByStripeId(stripeCustomerId) {
  try {
    const r = await base44Request('filter', 'Client', { stripe_customer_id: stripeCustomerId });
    return r?.records?.[0] || null;
  } catch { return null; }
}

async function suspendTwilioNumber(numero) {
  if (!numero) return;
  console.log('[TWILIO] Suspension du numéro:', numero);
  // Implémentation via API Twilio si besoin
}

async function base44Request(action, entity, data) {
  const res = await fetch(BASE44_APP_URL + '/' + action + '_' + entity, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': BASE44_API_KEY },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function base44UpdateClient(id, data) {
  const res = await fetch(BASE44_APP_URL + '/updateClient', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': BASE44_API_KEY },
    body: JSON.stringify({ id, ...data })
  });
  return res.json();
}

async function base44CreateClient(data) {
  const res = await fetch(BASE44_APP_URL + '/clientAuth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create_client_stripe', ...data })
  });
  const json = await res.json();
  // Retourner le client directement (compatibilité avec le code existant)
  return json.client || json;
}

// ─── Endpoints HTTP ──────────────────────────────────────────────────────────
app.get('/',       (req, res) => res.json({ status: 'ok', version: 'v69.0-pizzeria-vertical', service: 'VoiceImmo WS', build: '20260728.0700' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  let oaiOk = false, gmailOk = false;
  try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }); oaiOk = r.ok; } catch(_) {}
  gmailOk = true; // Resend
  res.json({ version: 'v69.0-pizzeria-vertical', hasOAI: !!OPENAI_API_KEY, oaiOk, gmailOk, configs: Object.keys(CONFIGS) });
});

app.get('/logs', (req, res) => {
  const n     = parseInt(req.query.n    || '50');
  const since = parseInt(req.query.since|| '0');
  res.json({ logs: LOG_BUFFER.filter(l => l.ts > since).slice(-n), serverTime: Date.now(), version: 'v69.0-pizzeria-vertical' });
});

app.get('/stats', async (req, res) => {
  let oaiOk = false, gmailOk = false;
  try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }); oaiOk = r.ok; } catch(_) {}
  gmailOk = true; // Resend
  res.json({ ok: true, version: 'v69.0-pizzeria-vertical', uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed/1024/1024), oaiOk, gmailOk, node: process.version, serverTime: Date.now(), activeConnections: wss.clients.size, configs: Object.keys(CONFIGS) });
});


// ─── Proxy audio Twilio (évite l'auth Basic dans le navigateur) ──────────────
app.get('/recording/:sid', async (req, res) => {
  const sid = req.params.sid;
  if (!sid || !sid.startsWith('RE')) return res.status(400).send('Invalid SID');
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sid}.mp3`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const upstream = await fetch(url, { headers: { 'Authorization': `Basic ${auth}` } });
    if (!upstream.ok) return res.status(upstream.status).send('Recording not found');
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    // Stream le body directement
    const arrayBuf = await upstream.arrayBuffer();
    res.send(Buffer.from(arrayBuf));
  } catch(e) {
    console.warn('[REC-PROXY] Erreur:', e.message);
    res.status(500).send('Proxy error');
  }
});

app.post('/twiml', async (req, res) => {
  const caller = req.body.From   || req.body.Caller || '';
  const to     = req.body.To     || req.body.Called || '';
  const sid    = req.body.CallSid|| '';
  console.log(`[TWIML] From:${caller} To:${to} Sid:${sid}`);

  // 🔄 Rechargement automatique de la config à chaque appel entrant
  // → garantit que toute modif du dashboard (script IA, message_accueil, voix...)
  //   est prise en compte immédiatement sans redémarrer le serveur
  await refreshConfigs();

  // Fix : SERVER_BASE_URL peut pointer vers un mauvais domaine Railway — forcer le bon
  let baseUrl = process.env.SERVER_BASE_URL || 'https://ws-staging.voiceimmo.fr';
  if (baseUrl.includes('production-92c4') || baseUrl.includes('railway.app')) {
    baseUrl = 'https://ws-staging.voiceimmo.fr';
  }

  // Enregistrement : on passe l'info via paramètre au WebSocket
  // L'enregistrement sera déclenché via API REST Twilio après établissement du stream
  const toKey = to.startsWith('+') ? to : '+' + to;
  const cfgTwiml = CONFIGS[toKey] || DEF_CFG();
  const doRecord = cfgTwiml.enregistrement_actif ? 'true' : 'false';
  console.log(`[TWIML] enregistrement_actif:${cfgTwiml.enregistrement_actif||false} pour ${toKey}`);

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${baseUrl.replace('https://','wss://').replace('http://','ws://')}">
      <Parameter name="caller" value="${caller}" />
      <Parameter name="to" value="${to}" />
      <Parameter name="sid" value="${sid}" />
      <Parameter name="record" value="${doRecord}" />
    </Stream>
  </Connect>
</Response>`);
/* NOTE : le fond sonore <Play loop="0"> n'est PAS compatible avec <Connect><Stream>
   dans le même <Response> (Twilio exécute séquentiellement, pas en parallèle).
   Approche correcte : Media Streams bi-directionnels avec audio injecté côté WS,
   OU désactiver le fond sonore. Pour l'instant on supprime le fond sonore pour
   préserver la qualité audio de Sophie. */
});


// ─── Fond sonore — pad électro doux (servi statiquement) ──────────────────────
app.get('/pad.wav', (req, res) => {
  const path = require('path');
  const fs   = require('fs');
  const file = path.join(__dirname, 'voxzen_pad.wav');
  if (!fs.existsSync(file)) {
    return res.status(404).send('Not found');
  }
  res.set('Content-Type', 'audio/wav');
  res.set('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(file).pipe(res);
});

// ─── Mention légale enregistrement ───────────────────────────────────────────
function getRecordingMention(voix) {
  // Adapté selon la voix (toutes féminines en français par défaut)
  const voixMasc = ['alloy', 'echo', 'onyx', 'fable'];
  const estMasc  = voixMasc.includes((voix||'coral').toLowerCase());
  if (estMasc) {
    return "Pour améliorer la qualité de notre service, cet appel peut être enregistré. ";
  }
  return "Pour améliorer la qualité de notre service, cet appel peut être enregistré. ";
}

function injectRecordingMention(messageAccueil, voix) {
  const mention = getRecordingMention(voix);
  // Ajouter la mention APRÈS l'accueil complet — ne jamais couper la phrase d'accueil
  const accueilNettoye = messageAccueil.trimEnd().replace(/[.,!?]+$/, '');
  return accueilNettoye + '. ' + mention.trim();
}

// ─── Blocs de collecte structurée par modèle métier ──────────────────────────
// NOTE : on réutilise volontairement les MÊMES clés (NOM/BESOIN/VILLE/PRIX/REF)
// pour tous les modèles métier — seul le SENS contextuel change. Ça permet de
// garder le même parseur de leads (parseLeadInfo) sans toucher au schéma Lead.
const DONNEES_BLOCKS = {
  IMMO: `DONNEES: NOM=[prénom et nom complet], BESOIN=[achat/vente/location/estimation], VILLE=[ville], PRIX=[prix ou vide], REF=[référence ou vide]`,
  HOSPITALITY: `DONNEES: NOM=[prénom et nom complet], BESOIN=[réservation/information séjour/service en chambre/réclamation], VILLE=[numéro de chambre ou "réception" si non applicable], PRIX=[dates de séjour ou nombre de nuits, vide sinon], REF=[numéro de réservation ou vide]`,
  TRANSPORT_LOGISTIQUE: `DONNEES: NOM=[prénom et nom complet + société si donnée], BESOIN=[devis transport/enlèvement-collecte/livraison/suivi de commande/réclamation], VILLE=[ville ou adresse de départ - ville ou adresse d'arrivée], PRIX=[poids/volume/nombre de palettes ou budget estimé, vide sinon], REF=[numéro de commande ou de bon de transport, vide sinon]`
};

function getDonneesBlock(modeleMetier) {
  return DONNEES_BLOCKS[modeleMetier] || DONNEES_BLOCKS.IMMO;
}

// ─── Squelette IMMO (défaut historique) ──────────────────────────────────────
function buildPromptImmo(c, callerNum) {
  const agentsStr = (c.agents_arr || []).map(a => `• ${a.nom} → ${a.zones}`).join('\n');
  const recordMention = c.enregistrement_actif ? getRecordingMention(c.voix) : '';
  return `${recordMention}Tu es Sophie, assistante vocale de l'agence ${c.nom_agence}.
LANGUE : FRANÇAIS UNIQUEMENT. Jamais d'anglais.

RÈGLES ABSOLUES :
- Ton ton est chaleureux, avenant et souriant — tu parles comme une personne accueillante, pas comme un robot froid. Utilise des formulations naturelles et sympathiques. Ton objectif est que l'appelant vive une expérience fluide et agréable, à l'écoute et sans jamais le brusquer.
- Tu ne recommandes aucune autre plateforme (SeLoger, LeBonCoin, etc.)
- Tu ne donnes pas de conseils juridiques ou financiers
- N'INVENTE JAMAIS d'information. Si tu n'as pas clairement entendu ou compris ce que dit l'appelant (son coupé, bruit de fond, silence, voix pas claire), NE DEVINE PAS un nom, un besoin ou une réponse : dis simplement "Je n'ai pas bien entendu, pouvez-vous répéter s'il vous plaît ?" et attends sa réponse.
- Tu collectes les informations dans cet ordre :
  1. Prénom et nom de l'appelant
  2. Nature du besoin (achat, vente, location, estimation)
  3. Ville / secteur du bien
  4. Budget approximatif
  5. Référence du bien si disponible
  6. Confirme le numéro de rappel détecté en le lisant chiffre par chiffre : "${callerNum}" — demande si c'est bien ce numéro
- Ne récapitule JAMAIS les informations collectées à voix haute (pas de "donc c'est bien Monsieur X, pour un achat à..."), dis directement la phrase de conclusion
- Après collecte complète : "Merci [Prénom], un agent va vous rappeler très rapidement. Au revoir !"

AGENTS ET ZONES :
${agentsStr}

Site web : ${c.site_internet || 'https://www.leone-immobilier.fr'}
Numéro détecté : ${callerNum}

## GARDE-FOU ANTI-HALLUCINATION (OBLIGATOIRE)
N'INVENTE JAMAIS un nom, une ville, un besoin ou une réponse. Si l'audio n'est pas clair (bruit de fond, circulation, vent, appelant qui marche ou parle loin du téléphone, voix hachée), NE DEVISE PAS : dis simplement "Je n'ai pas bien entendu, pouvez-vous répéter s'il vous plaît ?" et attends une vraie réponse avant de continuer. Ne remplis un champ (nom/ville/besoin/prix/référence) QUE si l'appelant l'a clairement et explicitement énoncé lui-même dans cet appel.

## NE JAMAIS RÉCAPITULER (OBLIGATOIRE)
Ne récapitule JAMAIS les informations collectées à voix haute avant de raccrocher (pas de "donc c'est bien M./Mme X, pour un achat à...", pas de ligne technique du type "DONNEES:"). Dis directement et uniquement la phrase de conclusion prévue, puis tais-toi.`;
}

// ─── Squelette HOSPITALITY (générique, réutilisable pour tout établissement) ─
function buildPromptHospitality(c, callerNum) {
  const recordMention = c.enregistrement_actif ? getRecordingMention(c.voix) : '';
  return `${recordMention}Tu es l'assistante vocale de ${c.nom_agence}.
LANGUE : FRANÇAIS UNIQUEMENT. Jamais d'anglais.

RÈGLES ABSOLUES :
- Tu es chaleureuse, professionnelle, et orientée service client
- Tu ne donnes jamais de prix fermes non confirmés — tu proposes un rappel de l'équipe pour les devis/réservations complexes
- Tu collectes les informations dans cet ordre :
  1. Prénom et nom de l'appelant
  2. Nature de la demande (réservation, information séjour, service en chambre, réclamation)
  3. Numéro de chambre si applicable
  4. Dates de séjour ou nombre de nuits si pertinent
  5. Numéro de réservation si disponible
  6. Confirme le numéro de rappel détecté en le lisant chiffre par chiffre : "${callerNum}" — demande si c'est bien ce numéro
- Ne récapitule JAMAIS les informations collectées à voix haute, dis directement la phrase de conclusion
- Après collecte complète : "Merci [Prénom], nous revenons vers vous très rapidement. Bonne journée !"

Site web : ${c.site_internet || ''}
Numéro détecté : ${callerNum}

## GARDE-FOU ANTI-HALLUCINATION (OBLIGATOIRE)
N'INVENTE JAMAIS un nom, une ville, un besoin ou une réponse. Si l'audio n'est pas clair (bruit de fond, circulation, vent, appelant qui marche ou parle loin du téléphone, voix hachée), NE DEVISE PAS : dis simplement "Je n'ai pas bien entendu, pouvez-vous répéter s'il vous plaît ?" et attends une vraie réponse avant de continuer. Ne remplis un champ (nom/ville/besoin/prix/référence) QUE si l'appelant l'a clairement et explicitement énoncé lui-même dans cet appel.

## NE JAMAIS RÉCAPITULER (OBLIGATOIRE)
Ne récapitule JAMAIS les informations collectées à voix haute avant de raccrocher (pas de "donc c'est bien M./Mme X, pour un achat à...", pas de ligne technique du type "DONNEES:"). Dis directement et uniquement la phrase de conclusion prévue, puis tais-toi.`;
}

// ─── Squelette TRANSPORT & LOGISTIQUE (générique) ────────────────────────────
function buildPromptTransport(c, callerNum) {
  const recordMention = c.enregistrement_actif ? getRecordingMention(c.voix) : '';
  return `${recordMention}Tu es l'assistante vocale de ${c.nom_agence}, spécialiste du transport et de la logistique.
LANGUE : Tu parles la langue détectée chez l'appelant (français, anglais, ou autre) et t'adaptes automatiquement — la clientèle peut être internationale (transporteurs étrangers, douanes).

RÈGLES ABSOLUES :
- IMPORTANT : le message d'accueil ("Bonjour...") a déjà été prononcé automatiquement avant que tu ne prennes la parole. Ne dis JAMAIS "Bonjour" une seconde fois — enchaîne directement sur l'identification du besoin.
- Clientèle professionnelle (B2B) : dès la première question utile, demande à la fois le PRÉNOM/NOM et le NOM DE LA SOCIÉTÉ de l'appelant — les deux sont obligatoires et ne doivent jamais être omis.
- Tu es efficace, directe et rassurante — les appelants sont souvent des professionnels pressés (transporteurs, expéditeurs, clients en attente de livraison)
- Tu ne donnes jamais de tarif ferme au téléphone — tu proposes systématiquement un rappel sous 2h pour les devis
- Si l'appelant se plaint, exprime son mécontentement, ou demande explicitement à parler à un responsable : reste calme et rassurante, propose IMMÉDIATEMENT une mise en relation avec un responsable de l'exploitation, confirme qu'il sera rappelé en priorité, et ne cherche pas à gérer seule une réclamation sensible.
- Tu identifies dès le début la nature de l'appel parmi :
  1. Demande de devis transport (marchandise, poids/volume, palettes, départ/arrivée, date souhaitée)
  2. Enlèvement / collecte à programmer
  3. Livraison à programmer ou à confirmer
  4. Suivi d'une commande / d'un colis déjà en cours (demander le numéro de commande ou bon de transport)
  5. Réclamation (retard, colis endommagé, litige) — reste posée et rassurante, ne présente jamais d'excuses juridiquement engageantes, propose une mise en relation avec un responsable
  6. Urgence transporteur (incident sur la route, besoin d'un contact immédiat) — dans ce cas uniquement, indique que tu transmets en priorité absolue
- Tu collectes ensuite systématiquement :
  1. Prénom, nom ET société de l'appelant (obligatoire, clientèle B2B)
  2. Nature du besoin (voir liste ci-dessus)
  3. Ville/adresse de départ et ville/adresse d'arrivée si pertinent
  4. Poids, volume ou nombre de palettes si c'est un devis ou un enlèvement
  5. Date souhaitée
  6. Numéro de commande ou de bon de transport si l'appel concerne un suivi ou une réclamation
  7. Confirme le numéro de rappel détecté en le lisant chiffre par chiffre : "${callerNum}" — demande si c'est bien ce numéro
- Ne récapitule JAMAIS les informations collectées à voix haute, dis directement la phrase de conclusion
- Après collecte complète : "Merci [Prénom], notre équipe exploitation revient vers vous très rapidement. Bonne journée !"

Site web : ${c.site_internet || ''}
Numéro détecté : ${callerNum}

## GARDE-FOU ANTI-HALLUCINATION (OBLIGATOIRE)
N'INVENTE JAMAIS un nom, une ville, un besoin ou une réponse. Si l'audio n'est pas clair (bruit de fond, circulation, vent, appelant qui marche ou parle loin du téléphone, voix hachée), NE DEVISE PAS : dis simplement "Je n'ai pas bien entendu, pouvez-vous répéter s'il vous plaît ?" et attends une vraie réponse avant de continuer. Ne remplis un champ (nom/ville/besoin/prix/référence) QUE si l'appelant l'a clairement et explicitement énoncé lui-même dans cet appel.

## NE JAMAIS RÉCAPITULER (OBLIGATOIRE)
Ne récapitule JAMAIS les informations collectées à voix haute avant de raccrocher (pas de "donc c'est bien M./Mme X, pour un achat à...", pas de ligne technique du type "DONNEES:"). Dis directement et uniquement la phrase de conclusion prévue, puis tais-toi.`;
}


// ─────────────────────────────────────────────────────────────────────────────
// SQUELETTE PIZZERIA / RESTAURATION — Voxzen v1.0
// Gère : commandes vocales, lecture de carte dynamique (chargée depuis la base),
//        récapitulatif commande, confirmation livraison/sur-place, dispatch vers
//        appareil connecté (imprimante cuisine / Raspberry Pi / webhook)
// ─────────────────────────────────────────────────────────────────────────────
function buildPromptPizzeria(c, callerNum) {
  const recordMention = c.enregistrement_actif ? getRecordingMention(c.voix) : '';

  // Construire la carte textuelle depuis le champ scraping_format
  // Format attendu dans Client.instructions_ia OU Client.scraping_format :
  //   CARTE: {"pizzas": [...], "boissons": [...], "desserts": [...]}
  // Si vide → utilise une carte générique de démonstration
  let carteText = '';
  if (c.scraping_format && c.scraping_format.trim()) {
    try {
      const carte = JSON.parse(c.scraping_format);
      const sections = [];
      if (carte.pizzas && carte.pizzas.length) {
        sections.push('PIZZAS DISPONIBLES :\n' + carte.pizzas.map(p =>
          `  • ${p.nom} — ${p.description || ''} — ${p.prix_s ? p.prix_s+'€ (S) / ' : ''}${p.prix_m ? p.prix_m+'€ (M) / ' : ''}${p.prix_l ? p.prix_l+'€ (L)' : p.prix+'€'}`
        ).join('\n'));
      }
      if (carte.boissons && carte.boissons.length) {
        sections.push('BOISSONS :\n' + carte.boissons.map(b =>
          `  • ${b.nom} — ${b.prix}€`
        ).join('\n'));
      }
      if (carte.desserts && carte.desserts.length) {
        sections.push('DESSERTS :\n' + carte.desserts.map(d =>
          `  • ${d.nom} — ${d.prix}€`
        ).join('\n'));
      }
      if (carte.options_supplementaires && carte.options_supplementaires.length) {
        sections.push('OPTIONS / SUPPLÉMENTS :\n' + carte.options_supplementaires.map(o =>
          `  • ${o.nom} — +${o.prix}€`
        ).join('\n'));
      }
      carteText = sections.join('\n\n');
    } catch(e) {
      carteText = c.scraping_format; // fallback : texte brut si pas JSON valide
    }
  } else {
    // Carte de démonstration générique
    carteText = `PIZZAS DISPONIBLES :
  • Margherita — tomate, mozzarella, basilic — 9€ (S) / 13€ (M) / 17€ (L)
  • 4 Fromages — mozzarella, gorgonzola, chèvre, parmesan — 11€ (S) / 15€ (M) / 19€ (L)
  • Reine — tomate, mozzarella, jambon, champignons — 11€ (S) / 15€ (M) / 19€ (L)
  • Napolitaine — tomate, mozzarella, anchois, câpres, olives — 12€ (S) / 16€ (M) / 20€ (L)
  • Végétarienne — tomate, mozzarella, poivrons, courgette, aubergine — 12€ (S) / 16€ (M) / 20€ (L)
  • Diavola — tomate, mozzarella, salami pimenté, piment — 12€ (S) / 16€ (M) / 20€ (L)

BOISSONS :
  • Eau minérale 50cl — 2€
  • Coca-Cola 33cl — 2,50€
  • Jus d'orange 25cl — 2€
  • Bière artisanale 33cl — 4€

DESSERTS :
  • Tiramisu maison — 5€
  • Panna cotta fruits rouges — 4,50€

OPTIONS / SUPPLÉMENTS :
  • Supplément fromage — +1,50€
  • Supplément jambon — +1,50€
  • Pâte sans gluten — +2€
  • Livraison à domicile — +2,50€`;
  }

  const horaires = c.horaires ? `\nHoraires : \${c.horaires}` : '';
  const siteWeb  = c.site_internet ? `\nSite web / commande en ligne : \${c.site_internet}` : '';

  return `\${recordMention}Tu es l'assistante vocale de \${c.nom_agence || 'la pizzeria'}, une pizzeria artisanale.
LANGUE : FRANÇAIS UNIQUEMENT. Jamais d'anglais.

RÈGLES ABSOLUES :
- IMPORTANT : le message d'accueil a déjà été prononcé automatiquement. Ne dis JAMAIS "Bonjour" à nouveau — enchaîne DIRECTEMENT sur la prise de commande.
- Tu es chaleureuse, efficace et gourmande dans tes formulations — tu parles avec enthousiasme des pizzas !
- Tu NE fais JAMAIS de récapitulatif vocal complet avant de raccrocher — seulement la phrase de clôture.
- N'INVENTE JAMAIS un produit, un prix ou une disponibilité. Si tu ne trouves pas dans la carte ci-dessous, dis "Je ne trouve pas ce produit dans notre carte, voici ce que nous proposons..."
- Si l'appelant demande quelque chose qui n'est pas sur la carte, propose la pizza la plus proche ou suggère une alternative.
- Tu gères les commandes LIVRAISON et SUR PLACE (à préciser dès le début).
- Minimum de commande pour la livraison : vérifie si configuré dans la carte, sinon considère 15€ minimum.

─────────────────────────────────────────────────────────────
CARTE DU JOUR :
\${carteText}
─────────────────────────────────────────────────────────────

DÉROULEMENT DE LA COMMANDE (strict, dans cet ordre) :

ÉTAPE 1 — TYPE DE COMMANDE
  Demande : "C'est pour une livraison à domicile ou à emporter ?"
  → Si livraison : demande l'adresse complète (numéro, rue, ville)
  → Si sur place : demande "Pour combien de personnes et à quelle heure ?"
  → Si commande téléphonique sans livraison ni sur-place : traite normalement

ÉTAPE 2 — PRISE DE COMMANDE
  Présente les grandes catégories disponibles : pizzas, boissons, desserts.
  Pour chaque pizza commandée, confirme OBLIGATOIREMENT :
    a) La pizza choisie (répète le nom)
    b) La taille : petite (S) / moyenne (M) / grande (L) — demander si non précisé
    c) Les suppléments souhaités (fromage, jambon, etc.)
  Propose naturellement les boissons si l'appelant n'en a pas commandé.
  Propose naturellement les desserts en fin de commande.

ÉTAPE 3 — RÉCAPITULATIF COMMANDE (UNIQUEMENT VOCAL, CONCIS)
  Énonce UNE SEULE FOIS la commande sous forme très courte :
  "Donc j'ai bien : [liste courte] pour un total de [montant]€. C'est bien ça ?"
  → Si l'appelant confirme → passer à l'étape 4
  → Si l'appelant corrige → modifier et re-confirmer une seule fois

ÉTAPE 4 — COORDONNÉES & CONFIRMATION
  Collecte dans cet ordre :
    1. Prénom et nom de l'appelant
    2. Confirme le numéro de téléphone en lisant chiffre par chiffre : "\${callerNum}" — "C'est bien votre numéro ?"
    3. Si livraison : confirme l'adresse complète
  Annonce le temps de préparation estimé (utilise la valeur configurée ou 25-30 minutes par défaut).
  Phrase de clôture obligatoire : "Merci [Prénom] ! Votre commande est bien enregistrée, elle sera prête dans [X] minutes. À très bientôt !"

─────────────────────────────────────────────────────────────
FORMAT DE SORTIE SILENCIEUX (NE JAMAIS PRONONCER À VOIX HAUTE) :
Après la phrase de clôture, émets silencieusement en dernier token de ta réponse le bloc :
COMMANDE: NOM=[nom client] | TEL=\${callerNum} | TYPE=[LIVRAISON/EMPORTER] | ADRESSE=[adresse si livraison] | ITEMS=[liste des pizzas+tailles+suppléments, boissons, desserts] | TOTAL=[montant total]€ | HEURE=[heure actuelle HH:MM]
─────────────────────────────────────────────────────────────
\${horaires}\${siteWeb}
Numéro détecté : \${callerNum}

## GARDE-FOU ANTI-HALLUCINATION (OBLIGATOIRE)
N'INVENTE JAMAIS un produit, un prix, une disponibilité ou une information. Si tu n'entends pas clairement, NE DEVINE PAS : dis "Je n'ai pas bien entendu, pouvez-vous répéter ?" et attends.

## NE JAMAIS RÉCAPITULER AVANT RACCROCHAGE (OBLIGATOIRE)
Après la phrase de clôture, tais-toi immédiatement. Pas de ligne technique "COMMANDE:" à voix haute.`;
}

const SKELETON_BUILDERS = {
  IMMO: buildPromptImmo,
  HOSPITALITY: buildPromptHospitality,
  TRANSPORT_LOGISTIQUE: buildPromptTransport,
  PIZZERIA: buildPromptPizzeria
};

// ─── Prompt Sophie (dispatch multi-modèles métier) ───────────────────────────
function buildPrompt(c, callerNum) {
  const modele = c.modele_metier || 'IMMO';
  // Priorité 1 : instructions_ia personnalisées depuis la base de données
  if (c.instructions_ia && c.instructions_ia.trim()) {
    let prompt = c.instructions_ia
      .replace(/\{\{CALLER\}\}/g, callerNum)
      .replace(/\{\{NUM\}\}/g, callerNum);
    // Injecter mention légale si enregistrement activé
    if (c.enregistrement_actif) {
      const mention = getRecordingMention(c.voix);
      prompt = mention + prompt;
    }
    // Si un message_accueil est défini, il sera joué en premier par le serveur.
    // On indique au modèle de ne PAS répéter l'accueil et de commencer directement à la 1ère vraie question.
    if (c.message_accueil && c.message_accueil.trim()) {
      prompt += '\n\n## IMPORTANT : Le message d\'accueil a déjà été dit par le système. Ne le répète jamais. Commence directement à la première étape du déroulement (identifier le besoin de l\'appelant).';
    }
    // NOTE : plus d'injection de bloc "DONNEES:" à prononcer à voix haute (générait un récap audible non désiré).
    // L'extraction du lead se fait uniquement via parseLeadInfo() sur le transcript de l'appelant (regex fallback).
    prompt += `\n\n## GARDE-FOU ANTI-HALLUCINATION (OBLIGATOIRE)\nN'INVENTE JAMAIS un nom, une ville, un besoin ou une réponse. Si l'audio n'est pas clair (bruit de fond, circulation, vent, appelant qui marche ou parle loin du téléphone, voix hachée), NE DEVISE PAS : dis simplement \"Je n'ai pas bien entendu, pouvez-vous répéter s'il vous plaît ?\" et attends une vraie réponse avant de continuer. Ne remplis un champ (nom/ville/besoin/prix/référence) QUE si l'appelant l'a clairement et explicitement énoncé lui-même dans cet appel.`;
    prompt += `\n\n## NE JAMAIS RÉCAPITULER (OBLIGATOIRE)\nNe récapitule JAMAIS les informations collectées à voix haute avant de raccrocher (pas de \"donc c'est bien M./Mme X, pour un achat à...\", pas de ligne technique du type \"DONNEES:\"). Dis directement et uniquement la phrase de conclusion prévue, puis tais-toi.`;
    console.log('[PROMPT] ✅ Instructions IA personnalisées utilisées pour', c.nom_agence, '| modele:', modele, '| caller:', callerNum, '| enregistrement:', c.enregistrement_actif||false);
    return prompt;
  }
  // Priorité 2 : squelette générique selon le modèle métier sélectionné
  const builder = SKELETON_BUILDERS[modele] || buildPromptImmo;
  console.log('[PROMPT] ⚠️ Squelette générique utilisé pour', c.nom_agence, '| modele:', modele);
  let prompt = builder(c, callerNum);
  // NOTE : plus d'injection de bloc "DONNEES:" à prononcer à voix haute (générait un récap audible non désiré).
  // L'extraction du lead se fait uniquement via parseLeadInfo() sur le transcript de l'appelant (regex fallback).
  return prompt;
}


// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] ✅ Connexion depuis', req.socket.remoteAddress);

  let streamSid  = '';
  let padOffset  = 0; // Curseur lecture PAD (position en bytes dans PAD_PCM)
  let callSid    = '';
  let oai        = null;
  let ready      = false;
  let queue      = [];
  let transcript = [];
  let curAss     = '';
  let botInterrupted = false; // Flag barge-in : bloque l'envoi d'audio vers Twilio
  let lead       = { nom:'', tel:'', besoin:'', agent:'', agentNom:'', ville:'', prix:'', ref:'' };
  let cfg        = null;
  let saved      = false;
  let accueilDone = false;
  let callTimer  = null;

  let hangingUp = false; // garde-fou anti-double-raccrochage

  async function hangupTwilio(sid) {
    if (!sid) { console.warn('[HANGUP] Pas de callSid disponible'); return; }
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      console.warn('[HANGUP] ⚠️ TWILIO creds manquantes — raccrochage via ws.close() uniquement');
      return; // hangup() sera appelé juste après dans le setTimeout
    }
    try {
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${sid}.json`,
        {
          method: 'POST',
          headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'Status=completed'
        }
      );
      const status = r.status;
      console.log(`[HANGUP] REST Twilio → HTTP ${status}`);
    } catch(e) {
      console.warn('[HANGUP] REST error:', e.message);
    }
  }

  function hangup() {
    if (callTimer) { clearTimeout(callTimer); callTimer = null; }
    if (oai && oai.readyState === WebSocket.OPEN) oai.close();
    // Fermer le WebSocket Twilio Media Stream — ws.terminate() est brutal mais garanti
    try { if (ws.readyState === ws.OPEN) { ws.close(); } } catch(_) {}
    try { ws.terminate(); } catch(_) {}
    console.log('[HANGUP] ws.terminate() → Twilio doit raccrocher');
  }


  // ─── Sauvegarde lead en base ────────────────────────────────────────────────
  async function saveLead(leadData, cfgData) {
    try {
      const payload = {
        nom:              leadData.nom      || 'Inconnu',
        telephone:        leadData.tel      || 'Inconnu',
        besoin:           leadData.besoin   || '',
        ville:            leadData.ville    || '',
        prix:             leadData.prix     || '',
        reference:        leadData.ref      || '',
        agent_initiales:  leadData.agent    || '',
        agent_nom:        leadData.agentNom || '',
        statut:           'Nouveau',
        email_envoye:     true,
        client_id:        cfgData?.client_db_id || null,
        call_sid:         leadData.callSid || '',
        notes:            leadData.transcript && leadData.transcript.length
          ? 'Discussion:\n' + leadData.transcript.map(e =>
              (e.r === 'a' ? 'Sophie: ' : 'Client: ') + e.t
            ).join('\n')
          : '',
      };
      const res = await fetch(`${BASE44_APP_URL}/saveLead`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(15000)
      });
      const data = await res.json();
      if (data.ok) {
        console.log('[LEAD] ✅ Lead sauvegardé en base, id:', data.id);
      } else {
        console.warn('[LEAD] ⚠️ Erreur saveLead:', JSON.stringify(data));
      }
    } catch(e) {
      console.warn('[LEAD] ⚠️ Exception saveLead:', e.message);
    }
  }

  // ─── Incrémentation compteurs appels ────────────────────────────────────────
  async function incrementAppels(cfgData) {
    try {
      const res = await fetch(`${BASE44_APP_URL}/incrementAppels`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ client_db_id: cfgData?.client_db_id }),
        signal:  AbortSignal.timeout(15000)
      });
      const data = await res.json();
      if (data.ok) {
        console.log('[APPEL] ✅ Compteurs incrémentés →', `total:${data.appels_total} mois:${data.appels_mois}`);
      } else {
        console.warn('[APPEL] ⚠️ Erreur incrementAppels:', JSON.stringify(data));
      }
    } catch(e) {
      console.warn('[APPEL] ⚠️ Exception incrementAppels:', e.message);
    }
  }

  async function flush() {
    if (saved) return; saved = true;
    // Capturer la dernière réplique de Sophie si non terminée
    if (curAss && curAss.trim()) {
      transcript.push({ r: 'a', t: curAss.trim() });
      curAss = '';
    }
    hangup();
    const activeCfg = cfg || DEF_CFG();
    // ── PIZZERIA : dispatch commande vers appareil connecté ──────────────────────
    const activeCfgForPizza = cfg || DEF_CFG();
    if (activeCfgForPizza.modele_metier === 'PIZZERIA') {
      const allText = transcript.map(t => (t.text || t.t || '')).join(' ');
      const cmd = parseCommandePizzeria(allText);
      if (cmd && cmd.items) {
        console.log('[PIZZERIA] 🍕 Commande détectée :', JSON.stringify(cmd));
        const dispatchUrl = activeCfgForPizza.regles_dispatch;
        if (dispatchUrl && dispatchUrl.startsWith('http')) {
          try {
            await fetch(dispatchUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                source:      'voxzen_voicebot',
                restaurant:  activeCfgForPizza.nom_agence,
                commande:    cmd,
                timestamp:   new Date().toISOString()
              })
            });
            console.log('[PIZZERIA] ✅ Commande dispatchée vers', dispatchUrl);
          } catch(e) {
            console.warn('[PIZZERIA] ⚠️ Dispatch échoué :', e.message);
          }
        } else {
          console.log('[PIZZERIA] ℹ️ Pas de webhook configuré dans regles_dispatch — commande loguée uniquement');
        }
        // Enrichir le lead avec les détails commande pour l'email et la base
        lead.besoin = 'Commande pizza : ' + cmd.items;
        lead.notes  = 'TYPE=' + cmd.type + ' | ADRESSE=' + cmd.adresse + ' | TOTAL=' + cmd.total + '€ | HEURE=' + cmd.heure;
      }
    }

        await Promise.all([
      (async () => {
        // Stocker l'email en attente — sera envoyé quand le recording arrive (ou timeout 45s)
        const sid = callSid;
        if (sid) {
          pendingEmails.set(sid, { lead: {...lead}, cfg: activeCfg, transcript: [...transcript] });
          // Timeout de sécurité : envoyer sans MP3 après 45s si le recording n'arrive pas
          const t = setTimeout(async () => {
            const pending = pendingEmails.get(sid);
            if (pending) {
              pendingEmails.delete(sid);
              console.log('[EMAIL] ⏱️ Timeout recording — envoi sans MP3');
              await sendEmail(pending.lead, pending.cfg, pending.transcript, null);
            }
          }, 45000);
          pendingEmails.get(sid).timer = t;
          console.log('[EMAIL] ⏳ Email en attente du recording pour callSid:', sid);
        } else {
          await sendEmail(lead, activeCfg, transcript, null);
        }
      })(),
      saveLead({ ...lead, transcript, callSid }, activeCfg),
      incrementAppels(activeCfg),
    ]);
  }

  function connectOAI(callerNum) {
    console.log('[OAI] Connexion OpenAI Realtime...');
    oai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OAI_MODEL}`,
      ['realtime'],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    oai.on('open', () => {
      console.log('[OAI] Connecté → session.update');
      oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: buildPrompt(cfg || DEF_CFG(), callerNum),
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'gpt-4o-transcribe', language: 'fr' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: (cfg || DEF_CFG())?.voix || 'shimmer'
            }
          }
        }
      }));
    });

    oai.on('message', async (data) => {
      let m;
      try { m = JSON.parse(data); } catch(_) { return; }

      if (m.type === 'session.updated' && !ready) {
        ready = true;
        // message_accueil toujours joué en 1er. Si vide, fallback neutre (jamais une config tierce).
        let accueil = (cfg?.message_accueil && cfg.message_accueil.trim())
          ? cfg.message_accueil
          : 'Bonjour, comment puis-je vous aider ?';
        // Injecter la mention RGPD si enregistrement actif
        if (cfg?.enregistrement_actif) {
          accueil = injectRecordingMention(accueil, cfg?.voix);
        }
        console.log('[OAI] Session prête → accueil:', accueil.slice(0, 80));
        for (const c of queue) {
          oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: c }));
        }
        queue = [];
        // Jouer le message d'accueil — le script IA prend le relais après
        // (buildPrompt() injecte automatiquement 'ne répète pas l\'accueil')
        oai.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: `Dis exactement ceci pour accueillir le client, une seule fois, sans jamais répéter : "${accueil}"` }
        }));
      }

      // Reset barge-in quand une nouvelle réponse commence
      if (m.type === 'response.created') {
        botInterrupted = false;
      }

      if (m.type === 'response.output_audio.delta' && m.delta && streamSid) {
        if (botInterrupted) return; // 🛑 Barge-in : ne pas envoyer d'audio pendant interruption
        if (true /* ElevenLabs désactivé */) {
          // Fallback : audio OpenAI direct (mixé avec le pad si disponible)
          if (ws.readyState === 1) {
            // Audio OpenAI direct — pas de mixing (préserve la qualité mulaw 8kHz)
            ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: m.delta } }));
          }
        }
        // Si ElevenLabs actif : on ignore l'audio OpenAI, on attend le transcript
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

      // ElevenLabs TTS : intercepter le transcript et générer l'audio via ElevenLabs
      if (false /* ElevenLabs désactivé */ &&
          m.type === 'response.audio_transcript.done' && m.transcript && streamSid) {
        const txt = m.transcript.trim();
        if (txt) {
          sendElevenLabsAudio(ws, streamSid, txt, ELEVENLABS_VOICE_ID).catch(e =>
            console.error('[EL-TTS] Erreur réponse:', e.message)
          );
        }
      }

      if (m.type === 'response.audio_transcript.delta' && m.delta) curAss += m.delta;

      // Détection phrase de fin + sauvegarde transcript Sophie
      async function handleSophieTranscript(text) {
        if (!text || !text.trim()) return;
        const t = text.trim();
        // Éviter les doublons
        if (transcript.some(e => e.r === 'a' && e.t === t)) return;
        transcript.push({ r: 'a', t });
        console.log(`[IA] "${t.slice(0, 100)}"`);
        // Détection phrase de fin → raccrocher dans 5s
        const finPhrases = /au revoir|à bientôt|à très bientôt|bientôt|bonne journée|bonne soirée|bonne continuation|rappeler très rapidement/i;
        if (finPhrases.test(t) && !hangingUp) {
          hangingUp = true;
          console.log('[FIN] ✅ Phrase de fin détectée → raccrochage dans 2s');
          setTimeout(async () => {
            // 1. API REST Twilio EN PREMIER → raccroche le téléphone physiquement
            await hangupTwilio(callSid);
            // 2. Fermer les connexions WebSocket
            hangup();
            // 3. Sauvegarder le lead + envoyer email
            await flush();
          }, 2000);
        }
      }

      // Source 1 : response.audio_transcript.done (event standard)
      if (m.type === 'response.audio_transcript.done' && curAss) {
        await handleSophieTranscript(curAss);
        curAss = '';
      }

      // Source 2 : response.output_item.done → item.formatted.transcript (fallback fiable)
      if (m.type === 'response.output_item.done' && m.item?.formatted?.transcript) {
        await handleSophieTranscript(m.item.formatted.transcript);
        if (!curAss) curAss = ''; // reset si déjà capturé
      }

      // Après le message d'accueil → on NE force plus d'enchaînement immédiat.
      // On attend la vraie réponse de l'appelant (server_vad déclenche automatiquement
      // la réponse suivante du modèle une fois que l'appelant a fini de parler).
      if (m.type === 'response.done' && !accueilDone) {
        accueilDone = true;
        console.log('[OAI] Accueil terminé → en attente de la réponse de l\'appelant');
      }

      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        transcript.push({ r: 'u', t: m.transcript });
        console.log(`[USER] "${m.transcript.slice(0, 100)}"`);
        parseLeadInfo(m.transcript);
      }

      if (m.type === 'error') console.error('[OAI] Erreur:', JSON.stringify(m.error));
    });

    oai.on('error', (e) => console.error('[OAI] WS Error:', e.message));
    oai.on('close', (code) => console.log('[OAI] Fermé, code:', code));
  }

// ─── Parsing commande PIZZERIA depuis transcription ──────────────────────────
function parseCommandePizzeria(transcript) {
  // Cherche le bloc COMMANDE: émis silencieusement par le modèle en dernier token
  const fullText = Array.isArray(transcript) ? transcript.join(' ') : transcript;
  const m = fullText.match(/COMMANDE:\s*NOM=([^|]+)\|\s*TEL=([^|]+)\|\s*TYPE=([^|]+)\|\s*(?:ADRESSE=([^|]*)\|\s*)?ITEMS=([^|]+)\|\s*TOTAL=([^|]+)\|\s*HEURE=([^\n\r]+)/i);
  if (!m) return null;
  return {
    nom:     (m[1]||'').trim(),
    tel:     (m[2]||'').trim(),
    type:    (m[3]||'').trim(),   // LIVRAISON ou EMPORTER
    adresse: (m[4]||'').trim(),
    items:   (m[5]||'').trim(),
    total:   (m[6]||'').trim(),
    heure:   (m[7]||'').trim()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
  function parseLeadInfo(text) {
    // PRIORITÉ 1 : Format structuré DONNEES: NOM=[...], BESOIN=[...], etc.
    const mData = text.match(/DONNEES:\s*NOM=\[([^\]]+)\].*?BESOIN=\[([^\]]+)\].*?VILLE=\[([^\]]+)\].*?PRIX=\[([^\]]*)\].*?REF=\[([^\]]*)\]/is);
    if (mData) {
      const [, nom, besoin, ville, prix, ref] = mData;
      if (nom && nom.toLowerCase() !== 'vide' && nom.trim()) lead.nom = nom.trim();
      if (besoin && besoin.toLowerCase() !== 'vide' && besoin.trim()) lead.besoin = besoin.trim();
      if (ville && ville.toLowerCase() !== 'vide' && ville.trim()) lead.ville = ville.trim();
      if (prix && prix.toLowerCase() !== 'vide' && prix.trim()) lead.prix = prix.trim();
      if (ref && ref.toLowerCase() !== 'vide' && ref.trim()) lead.ref = ref.trim();
      console.log('[PARSE] ✅ Format structuré détecté → nom:', lead.nom, '| besoin:', lead.besoin, '| ville:', lead.ville);
      return; // Format structuré trouvé, pas besoin des regex fragiles
    }
    // PRIORITÉ 2 : Regex sur transcript libre (fallback)
    if (!lead.nom) {
      // Patterns explicites
      const mApp  = text.match(/je m.appelle\s+([A-ZÀ-Ÿa-zà-ÿ\-]+(?:\s+[A-ZÀ-Ÿa-zà-ÿ\-]+)+)/i);
      const mNom  = text.match(/mon nom est\s+([A-ZÀ-Ÿa-zà-ÿ\-]+(?:\s+[A-ZÀ-Ÿa-zà-ÿ\-]+)+)/i);
      const mCest = text.match(/c.est\s+([A-ZÀ-Ÿ][a-zà-ÿ\-]+\s+[A-ZÀ-Ÿ][a-zà-ÿ\-]+)/);
      const mSuis = text.match(/je suis\s+([A-ZÀ-Ÿ][a-zà-ÿ\-]+\s+[A-ZÀ-Ÿ][a-zà-ÿ\-]+)/i);
      // Pattern générique : 2 mots consécutifs Prénom Nom (majuscule + minuscules, min 3 chars chacun)
      // Exclure les faux positifs communs
      const EXCLUS_NOM = /^(Bonjour|Merci|Bonne|Journée|Oui|Non|Voilà|Excusez|Désolé|Voici|Allô|Sophie|Madame|Monsieur|Mademoiselle|Bien|Très|Super|Parfait|Accord|Revoir|Bientôt|Pour|Avoir|Faire|Aller|Venir|Prendre|Donner|Trouver|Chercher|Appeler|Vouloir|Pouvoir)$/i;
      const mDirect = text.match(/^\s*([A-ZÀ-Ÿ][a-zà-ÿ\-]{2,})(?:\s+([A-ZÀ-Ÿ][a-zà-ÿ\-]{2,}))+\s*[,\.!]?\s*$/m);

      if (mApp)  lead.nom = mApp[1].trim();
      else if (mNom)  lead.nom = mNom[1].trim();
      else if (mSuis) lead.nom = mSuis[1].trim();
      else if (mCest) lead.nom = mCest[1].trim();
      else if (mDirect) {
        const fullName = mDirect[0].replace(/[,\.!]/, '').trim();
        const parts = fullName.trim().split(/\s+/);
        if (parts.length >= 2 && parts.every(p => !EXCLUS_NOM.test(p))) {
          lead.nom = fullName.trim();
        }
      }
    }
    if (!lead.besoin && /acheter|achat|vendre|vente|louer|location|estim/i.test(text)) {
      const m = text.match(/(acheter|achat|vendre|vente|louer|location|estimation)/i);
      if (m) lead.besoin = m[1];
    }
    if (!lead.ville) {
      // Ville : "à Lyon", "sur Paris", "secteur Bordeaux" — exige une vraie ville (maj + min, min 3 chars)
      // Exclus les faux positifs : "plus", "bientôt", "accord", etc.
      const exclus = /^(plus|bientôt|accord|revoir|tout|cela|ça|voix|départ|arrivée|suite|nouveau)$/i;
      const m = text.match(/(?:à|sur|secteur|ville de|commune de|habite à|situé à|recherche à)\s+([A-ZÀ-Ý][a-zà-ý\-]{2,}(?:\s+[A-ZÀ-Ý][a-zà-ý\-]+)*)/i);
      if (m && !exclus.test(m[1].trim())) lead.ville = m[1];
    }
    if (!lead.prix) {
      const m = text.match(/(\d[\d\s\.]*(?:euros?|€|k€|000\b))/i);
      if (m) lead.prix = m[1];
    }
  }

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch(_) { return; }

    if (m.event === 'start') {
      streamSid    = m.start?.streamSid || '';
      const params = m.start?.customParameters || {};
      callSid      = params.sid    || params.CallSid || m.start?.callSid || '';
      const caller = params.caller || params.From || m.start?.from || '';
      const to     = params.to     || params.To   || m.start?.to   || '';
      const doRecord = params.record === 'true';
      console.log(`[WS] START streamSid:${streamSid} caller=${caller} to=${to} record=${doRecord}`);
      lead.tel = caller ? caller.replace(/^\+33/, '0').replace(/(\d{2})(?=\d)/g, '$1 ').trim() : 'Inconnu';
      cfg = getConfig(to || '');
      connectOAI(lead.tel);
      callTimer = setTimeout(async () => {
        console.log('[TIMER] 2min → raccrochage automatique');
        hangingUp = true;
        await hangupTwilio(callSid);
        hangup();
        await flush();
      }, 120000);

      // Déclencher l'enregistrement via API REST Twilio (pas via TwiML pour ne pas couper le stream)
      if (doRecord && callSid && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        setTimeout(async () => {
          try {
            const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
            // Fix : SERVER_BASE_URL peut pointer vers un mauvais domaine Railway — forcer le bon
  let baseUrl = process.env.SERVER_BASE_URL || 'https://ws-staging.voiceimmo.fr';
  if (baseUrl.includes('production-92c4') || baseUrl.includes('railway.app')) {
    baseUrl = 'https://ws-staging.voiceimmo.fr';
  }
            const recResp = await fetch(
              `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`,
              {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `RecordingStatusCallback=${encodeURIComponent(baseUrl + '/recording-callback')}&RecordingStatusCallbackMethod=POST`
              }
            );
            const recData = await recResp.json();
            if (recData.sid) console.log(`[REC] ✅ Enregistrement démarré: ${recData.sid}`);
            else console.warn('[REC] ⚠️ Réponse Twilio:', JSON.stringify(recData));
          } catch(e) {
            console.warn('[REC] ⚠️ Erreur démarrage enregistrement:', e.message);
          }
        }, 2000); // 2s après le stream pour laisser l'appel s'établir
      }
    }
    else if (m.event === 'media' && m.media?.payload) {
      if (oai && oai.readyState === WebSocket.OPEN && ready) {
        oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
      } else if (oai) {
        queue.push(m.media.payload);
      }
    }
    else if (m.event === 'stop') {
      console.log(`[WS] STOP — ${transcript.length} échanges`);
      await flush();
    }
  });

  ws.on('close', async () => { console.log('[WS] Connexion fermée'); await flush(); });
  ws.on('error', (e) => console.error('[WS] Erreur:', e.message));
});


// ─── Protection globale contre les crashes ──────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[CRASH] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH] unhandledRejection:', reason);
});


const PORT = process.env.PORT || 8080;

// ─── Route reload-config (appelée par l'app après sauvegarde) ────────────────
// ─── Webhook Twilio — enregistrement disponible ─────────────────────────────

// ─── Route TwiML Hospitality ─────────────────────────────────────────────────

app.post('/recording-noop', (req, res) => {
  // Twilio appelle cette URL quand l'action <Record> se termine (avant Connect)
  // On ne fait rien — la conversation se poursuit via Connect/Stream
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

app.post('/recording-callback', express.urlencoded({ extended: true }), async (req, res) => {
  res.sendStatus(200);
  const { CallSid, RecordingSid, RecordingUrl, RecordingStatus } = req.body;
  console.log(`[REC] Callback — CallSid:${CallSid} RecordingSid:${RecordingSid} Status:${RecordingStatus}`);
  if (RecordingStatus !== 'completed' || !RecordingUrl || !CallSid) return;

  // URL proxy via notre backend (évite la popup d'auth Twilio dans le navigateur)
  const mp3Url = `${process.env.WS_BASE_URL || 'https://ws-staging.voiceimmo.fr'}/recording/${RecordingSid}`;
  console.log(`[REC] ✅ Enregistrement prêt: ${mp3Url}`);

  // Mettre à jour le Lead correspondant dans Base44
  try {
    const res2 = await fetch(`${BASE44_APP_URL}/updateLeadRecording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_sid: CallSid, recording_url: mp3Url, recording_sid: RecordingSid }),
      signal: AbortSignal.timeout(8000)
    });
    const data = await res2.json();
    if (data.ok) console.log('[REC] ✅ Lead mis à jour avec recording_url');
    else console.warn('[REC] ⚠️ updateLeadRecording:', JSON.stringify(data));
  } catch(e) {
    console.warn('[REC] ⚠️ Exception updateLeadRecording:', e.message);
  }

  // Envoyer l'email en attente avec le MP3 en pièce jointe
  const pending = pendingEmails.get(CallSid);
  if (pending) {
    clearTimeout(pending.timer);
    pendingEmails.delete(CallSid);
    console.log('[EMAIL] 🎙️ Recording reçu — envoi email avec MP3');
    pending.lead.recording_url = mp3Url;
    await sendEmail(pending.lead, pending.cfg, pending.transcript, mp3Url);
  } else {
    console.log('[EMAIL] ℹ️ Pas d\'email en attente pour ce callSid:', CallSid);
  }
});

// ─── Route : marquer lead comme Traité depuis email ─────────────────────────
app.get('/mark-lead-done', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Paramètre manquant');
  try {
    const r = await fetch(`${BASE44_APP_URL}/clientAuth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_lead', id: id, statut: 'Clôturé' }),
      signal: AbortSignal.timeout(8000)
    });
    const d = await r.json();
    if (d.ok) {
      console.log('[MARK] ✅ Lead', id, 'marqué Clôturé');
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Traité</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4"><div style="font-size:64px">✅</div><h2 style="color:#10b981">Lead marqué comme Traité !</h2><p style="color:#6b7280">Vous pouvez fermer cette fenêtre.</p></body></html>`);
    } else {
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><div style="font-size:64px">⚠️</div><h2>Erreur</h2><p>${JSON.stringify(d)}</p></body></html>`);
    }
  } catch(e) {
    console.error('[MARK] ❌', e.message);
    return res.status(500).send('Erreur: ' + e.message);
  }
});

app.post('/reload-config', express.json(), async (req, res) => {
  console.log('[CFG] 🔄 Rechargement forcé depuis l\'app client...');
  try {
    await refreshConfigs();
    res.json({ ok: true, message: 'Config rechargée', configs: Object.keys(CONFIGS) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Route OTP Admin ────────────────────────────────────────────────────────
app.post('/send-otp', express.json(), (req, res) => {
  const body = req.body || {};
  const to = 'admin@voxzen.io';  // Toujours forcer admin@voxzen.io
  const code = body.code;
  const expiry = body.expiry || '10 min';
  if (!code) return res.status(400).json({ error: 'Paramètres manquants' });
  console.log('[OTP] Requête reçue → ' + to + ' code=' + code);
  // Répondre immédiatement pour éviter le timeout Railway
  res.json({ ok: true, queued: true });
  // Envoyer l'email en arrière-plan
  sendOtpEmail(to, code, expiry)
    .then(() => console.log('[OTP] ✅ Email OTP envoyé à ' + to))
    .catch(e => console.error('[OTP] Echec envoi email: ' + e.message));
});




// ─── TwiML pour ElevenLabs ConvAI (both_tracks) ──────────────────────────────
// Cet endpoint génère un TwiML avec Stream both_tracks vers ElevenLabs
// pour que Sophie puisse PARLER (et pas seulement écouter)
app.post('/twiml-el', async (req, res) => {
  const caller = req.body.From   || req.body.Caller || '';
  const to     = req.body.To     || req.body.Called || '';
  const sid    = req.body.CallSid|| '';
  console.log(`[TWIML-EL] From:${caller} To:${to} Sid:${sid}`);

  // Obtenir un signed URL de conversation ElevenLabs
  const ELABS_KEY = process.env.ELEVENLABS_API_KEY_4 || process.env.ELEVENLABS_API_KEY;
  const AGENT_ID_EL = 'agent_9201kw4jr5j0fbgbfx06mfz28a1x';

  try {
    const signedResp = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID_EL}`, {
      headers: { 'xi-api-key': ELABS_KEY }
    });
    const signedData = await signedResp.json();
    const wsUrl = signedData.signed_url;
    console.log(`[TWIML-EL] signed_url obtenu: ${wsUrl ? wsUrl.substring(0,60)+'...' : 'ERREUR'}`);

    if (!wsUrl) {
      console.error('[TWIML-EL] Erreur signed_url:', JSON.stringify(signedData));
      res.status(500).send('Erreur signed_url');
      return;
    }

    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" track="both_tracks">
      <Parameter name="caller" value="${caller}" />
      <Parameter name="to" value="${to}" />
    </Stream>
  </Connect>
</Response>`);
  } catch(e) {
    console.error('[TWIML-EL] Exception:', e.message);
    res.status(500).send('Erreur interne');
  }
});

// ─── ElevenLabs TTS streaming → retourne Buffer ulaw 8kHz ───────────────────
async function streamElevenLabsTTS(text, voiceId) {
  const vid = voiceId || ELEVENLABS_VOICE_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/basic'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      output_format: 'ulaw_8000',
      voice_settings: { stability: 0.4, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true }
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`ElevenLabs TTS error ${resp.status}: ${err}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf;
}

// Envoyer audio ElevenLabs vers Twilio par chunks de 160 bytes (20ms @ 8kHz mulaw)
async function sendElevenLabsAudio(ws, streamSid, text, voiceId) {
  try {
    const audioBuf = await streamElevenLabsTTS(text, voiceId);
    const CHUNK = 160;
    for (let i = 0; i < audioBuf.length; i += CHUNK) {
      const chunk = audioBuf.slice(i, i + CHUNK);
      if (ws.readyState === 1 && streamSid) {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: chunk.toString('base64') }
        }));
      }
    }
    console.log(`[EL-TTS] ✅ Audio envoyé: ${audioBuf.length} bytes pour "${text.slice(0,60)}"`);
  } catch(e) {
    console.error('[EL-TTS] ❌ Erreur:', e.message);
  }
}

server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v68.12-auto-reload-on-call sur port ${PORT}`));
