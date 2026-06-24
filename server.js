'use strict';
const http      = require('http');
const express   = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

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
const OAI_MODEL          = process.env.OAI_MODEL          || 'gpt-4o-realtime-preview';
// const GMAIL_CLIENT_ID    = process.env.GMAIL_CLIENT_ID    || '';
// const GMAIL_CLIENT_SECRET= process.env.GMAIL_CLIENT_SECRET|| '';
// const GMAIL_REFRESH_TOKEN= process.env.GMAIL_REFRESH_TOKEN|| '';
// const GMAIL_FROM         = process.env.GMAIL_FROM         || 'voiceimmo5@gmail.com';
const BASE44_PROXY_URL   = 'https://fr-2758ee0c.base44.app/functions/getClientConfig';
const BASE44_HOSP_LIST_URL = 'https://fr-2758ee0c.base44.app/functions/hospitalityAuth';
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
    voix:                'coral',
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
    voix:                'coral',
    site_internet:       'https://www.leone-immobilier.fr',
    message_accueil:     "Bonjour, ceci est le serveur de test Leone Immobilier. Comment puis-je vous aider ?",
    instructions_ia:     null,
    agents_arr: [
      { nom: 'Luca',  email: 'leone.immobilier@gmail.com',      zones: 'givors, irigny, st genis laval, corbas, oullins, pierre-benite' },
      { nom: 'Kenny', email: 'kenny.leoneimmobilier@gmail.com',  zones: 'villette de vienne, vienne, roussillon' },
      { nom: 'Jeff',  email: 'jeff.leoneimmobilier@gmail.com',   zones: 'villefontaine, nord rhone, beaujolais' }
    ],
    destinataires_email: ['christophe.despretz@gmail.com'],
  },
  '+33939249373': {
    nom_agence:          'Grand Hotel de Lyon',
    hotel_id:            'HOSP-DEMO',
    voix:                'shimmer',
    site_internet:       'https://hospitality.voxzen.io',
    message_accueil:     'Bonjour, Grand Hotel de Lyon, je suis Sofia. Puis-je avoir votre prenom et nom ?',
    instructions_ia:     null,
    destinataires_email: ['christophe.despretz@gmail.com'],
    enregistrement_actif: true,
    is_hospitality:      true,
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
    voix:                 c.voix || fallback.voix || 'coral',
    site_internet:        c.site_internet || fallback.site_internet || '',
    message_accueil:      c.message_accueil || fallback.message_accueil || 'Bonjour, comment puis-je vous aider ?',
    instructions_ia:      c.instructions_ia || null,
    agents_arr,
    destinataires_email:  dest,
    enregistrement_actif: c.enregistrement_actif === true,
    is_hospitality:       c.secteur === 'hospitality' || c.is_hospitality === true || false,
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
    // Charger aussi les HotelClients (SVIA Hospitality)
    try {
      const hospRes = await fetch(BASE44_HOSP_LIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list_hotels' }),
        signal: AbortSignal.timeout(8000)
      });
      if (hospRes.ok) {
        const hospData = await hospRes.json();
        const hotels = hospData.hotels || [];
        for (const h of hotels) {
          const num = h.numero_voxzen;
          if (!num) continue;
          const key = num.startsWith('+') ? num : `+${num}`;
          newConfigs[key] = {
            nom_agence:          h.nom_hotel || 'Grand Hotel',
            hotel_id:            h.hotel_id || h.id,
            voix:                h.voix || 'shimmer',
            site_internet:       h.site_internet || 'https://hospitality.voxzen.io',
            message_accueil:     `Bonjour, ${h.nom_hotel || 'Grand Hotel'}, je suis Sofia. Puis-je avoir votre prenom et nom ?`,
            instructions_ia:     h.instructions_ia || null,
            destinataires_email: Array.isArray(h.destinataires_email) ? h.destinataires_email : [h.email || 'christophe.despretz@gmail.com'],
            enregistrement_actif: h.enregistrement_actif === true,
            is_hospitality:      true,
            langue:              h.langue || 'fr',
            categorie:           h.categorie || '4 etoiles',
          };
        }
        console.log(`[CFG] ✅ Hotels chargés: ${hotels.length} | ${hotels.map(h=>h.nom_hotel).join(', ')}`);
      }
    } catch(he) {
      console.warn('[CFG] ⚠️ Impossible de charger hotels:', he.message);
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
    const destList = [...new Set([...(cfg.destinataires_email||[]), 'voiceimmo5@gmail.com'].filter(Boolean))];

    // Bouton écouter l'enregistrement (commun aux deux templates)
    const recHtml = recordingUrl
      ? '<div style="margin:20px 0;padding:16px;background:#fef3c7;border:2px solid #f59e0b;border-radius:10px;text-align:center">'
        + '<p style="margin:0 0 10px;font-weight:700;color:#92400e;font-size:15px">&#127897; Enregistrement disponible</p>'
        + '<a href="' + recordingUrl + '" style="display:inline-block;background:#f59e0b;color:#fff;text-decoration:none;padding:11px 28px;border-radius:8px;font-weight:700;font-size:14px">&#9654; Ecouter</a>'
        + '</div>'
      : '';

    let html, subject;

    if (cfg.is_hospitality) {
      // ── Template SOFIA — Hospitality ──
      const transcriptHtml = transcript && transcript.length
        ? '<div style="margin-top:20px"><p style="font-weight:700;color:#374151;margin-bottom:6px">&#128172; Transcription :</p>'
          + '<div style="background:#f9fafb;border-radius:8px;padding:12px;font-size:13px;line-height:1.9;border:1px solid #e5e7eb">'
          + transcript.map(e => e.r === 'a'
            ? '<span style="color:#d97706;font-weight:700">Sofia :</span> ' + e.t
            : '<span style="color:#4b5563;font-weight:700">Client :</span> ' + e.t
          ).join('<br>')
          + '</div></div>'
        : '';
      subject = '[' + (cfg.nom_agence||'SVIA') + '] ' + (lead.type_demande||'Appel').toUpperCase() + ' — ' + (lead.nom||'Client');
      html = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">'
        + '<div style="background:linear-gradient(135deg,#1a1a2e,#b8860b);color:#fff;padding:24px;border-radius:12px 12px 0 0">'
        + '<h2 style="margin:0">&#127970; Voxzen Hospitality</h2>'
        + '<p style="margin:4px 0 0;opacity:0.85;font-size:14px">' + (cfg.nom_agence||'SVIA') + '</p>'
        + '</div>'
        + '<div style="padding:24px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">'
        + '<table style="width:100%;border-collapse:collapse">'
        + '<tr><td style="padding:8px;background:#fef9ec;font-weight:bold;width:160px;border-bottom:1px solid #e5e7eb">&#128100; Client</td><td style="padding:8px;font-weight:700;font-size:15px;border-bottom:1px solid #e5e7eb">' + (lead.nom||'Inconnu') + '</td></tr>'
        + '<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #e5e7eb">&#128222; Téléphone</td><td style="padding:8px;border-bottom:1px solid #e5e7eb"><a href="tel:' + (lead.telephone||'').replace(/\s/g,'') + '" style="color:#d97706;font-weight:700;text-decoration:none;font-size:16px">' + (lead.telephone||'N/A') + '</a></td></tr>'
        + '<tr><td style="padding:8px;background:#fef9ec;font-weight:bold;border-bottom:1px solid #e5e7eb">&#127981; Type de demande</td><td style="padding:8px;border-bottom:1px solid #e5e7eb">' + (lead.type_demande||lead.besoin||'N/A') + '</td></tr>'
        + '<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #e5e7eb">&#127959; Chambre</td><td style="padding:8px;border-bottom:1px solid #e5e7eb">' + (lead.numero_chambre||'—') + '</td></tr>'
        + '<tr><td style="padding:8px;background:#fef9ec;font-weight:bold;border-bottom:1px solid #e5e7eb">&#128203; Demande</td><td style="padding:8px;border-bottom:1px solid #e5e7eb">' + (lead.demande||lead.besoin||'—') + '</td></tr>'
        + (lead.resume_ia ? '<tr><td style="padding:8px;font-weight:bold">&#129302; Résumé IA</td><td style="padding:8px;color:#6b7280;font-style:italic">' + lead.resume_ia + '</td></tr>' : '')
        + '</table>'
        + recHtml
        + transcriptHtml
        + '</div></div>';

    } else {
      // ── Template SOPHIE — VoiceImmo ──
      const agentTrouve = (cfg.agents_arr || cfg.agents || []).find(a =>
        (lead.agent_initiales||'').toLowerCase().split('/').map(s=>s.trim()).some(ini => a.nom.split(' ')[0].toLowerCase() === ini) ||
        (lead.ville||'').toLowerCase().split(' ').some(v => a.zones.toLowerCase().includes(v))
      );
      if (agentTrouve?.email) destList.push(agentTrouve.email);
      const finalDest = [...new Set(destList)];
      const agentLabel = agentTrouve ? agentTrouve.nom : (lead.agent_initiales || 'N/A');
      subject = 'Nouveau lead VoiceImmo — ' + (lead.nom||'Inconnu');
      html = '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">'
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
        + recHtml
        + '<div style="margin-top:24px;text-align:center">'
        + '<a href="' + (process.env.WS_BASE_URL || 'https://voiceimmo-ws-production-ebd2.up.railway.app') + '/mark-lead-done?id=' + (lead.id||'') + '" '
        + 'style="display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:#fff;text-decoration:none;padding:12px 32px;border-radius:10px;font-weight:700;font-size:15px">&#9989; Marquer comme Trait&eacute;</a>'
        + '</div>'
        + '</div></div>';
    }

    // Construire l'email avec ou sans pièce jointe MP3
    const emailPayload = {
      from: cfg.is_hospitality ? 'Voxzen Hospitality <notifications@voxzen.io>' : 'VoiceImmo <no-reply@voxzen.io>',
      to: destList,
      subject,
      html
    };

    // Attacher l'enregistrement MP3 si disponible
    if (recordingUrl) {
      try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken  = process.env.TWILIO_AUTH_TOKEN;
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
app.get('/',       (req, res) => res.json({ status: 'ok', version: 'v54-stripe', service: 'VoiceImmo WS', build: '20260624.1820' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  let oaiOk = false, gmailOk = false;
  try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }); oaiOk = r.ok; } catch(_) {}
  gmailOk = true; // Resend
  res.json({ version: 'v54-stripe', hasOAI: !!OPENAI_API_KEY, oaiOk, gmailOk, configs: Object.keys(CONFIGS) });
});

app.get('/logs', (req, res) => {
  const n     = parseInt(req.query.n    || '50');
  const since = parseInt(req.query.since|| '0');
  res.json({ logs: LOG_BUFFER.filter(l => l.ts > since).slice(-n), serverTime: Date.now(), version: 'v54-stripe' });
});

app.get('/stats', async (req, res) => {
  let oaiOk = false, gmailOk = false;
  try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }); oaiOk = r.ok; } catch(_) {}
  gmailOk = true; // Resend
  res.json({ ok: true, version: 'v54-stripe', uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed/1024/1024), oaiOk, gmailOk, node: process.version, serverTime: Date.now(), activeConnections: wss.clients.size, configs: Object.keys(CONFIGS) });
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

app.post('/twiml', (req, res) => {
  const caller = req.body.From   || req.body.Caller || '';
  const to     = req.body.To     || req.body.Called || '';
  const sid    = req.body.CallSid|| '';
  console.log(`[TWIML] From:${caller} To:${to} Sid:${sid}`);
  const baseUrl = process.env.SERVER_BASE_URL || 'https://voiceimmo-ws-production-ebd2.up.railway.app';

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
    <Stream url="wss://${baseUrl.replace('https://','').replace('http://','')}">
      <Parameter name="caller" value="${caller}" />
      <Parameter name="to" value="${to}" />
      <Parameter name="sid" value="${sid}" />
      <Parameter name="record" value="${doRecord}" />
    </Stream>
  </Connect>
</Response>`);
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

// ─── Prompt Sophie ────────────────────────────────────────────────────────────
function buildPrompt(c, callerNum) {
  const recordMention = c.enregistrement_actif ? getRecordingMention(c.voix) : '';

  // ─── Prompt SOFIA — Hospitality ───────────────────────────────────────────
  if (c.is_hospitality) {
    // Utiliser les instructions_ia personnalisées si renseignées, sinon le scénario défaut
    const scenarioBase = (c.instructions_ia && c.instructions_ia.trim())
      ? c.instructions_ia.trim()
      : `Notre hôtel est un établissement de standing. Vous êtes Sofia, l'assistante vocale de l'hôtel, disponible 24h/24. Répondez toujours avec élégance, chaleur et professionnalisme.

Le check-in est à 15h, le check-out à 12h. Pour toute extension de séjour, proposez de transférer à la réception.
Pour le room service, notez la commande et confirmez le délai de 30 minutes.
Pour les demandes de taxi ou transfert, prenez les détails (heure, destination, nombre de personnes).
Pour les problèmes techniques dans la chambre, notez le numéro de chambre et créez un ticket.
Pour les réservations restaurant, notez le nom, le nombre de couverts et l'heure souhaitée.

Parlez la langue du client. Si français → français. Si anglais → anglais. Si le client ne répond pas, dites doucement : "Vous êtes toujours là ?" avant de raccrocher.`;

    const prompt = recordMention
      + `Tu es Sofia, l'assistante vocale de l'hôtel ${c.nom_agence || 'Grand Hôtel'}. `
      + `Numéro détecté de l'appelant : ${callerNum}.\n\n`
      + scenarioBase
      + `\n\n## RÈGLES ABSOLUES (NE JAMAIS ENFREINDRE)
- COMMENCE TOUJOURS par : "Bonjour, ${c.nom_agence || 'Grand Hôtel'}, je suis Sofia. Puis-je avoir votre prénom et nom s'il vous plaît ?"
- Attends la réponse avant de continuer. N'accepte PAS "tout bon" ou une expression comme nom. Si le client dit juste "oui" ou une expression floue, redemande poliment : "Pourriez-vous me donner votre prénom et nom ?"
- Si tu n'entends pas bien : "Je suis désolée, pourriez-vous répéter ?" — après 2 tentatives, raccroche poliment.
- Ne donne jamais de tarifs — redirige vers la réception.
- Numéro de rappel détecté : ${callerNum}

## COLLECTE DONNÉES (OBLIGATOIRE — envoyer avant de raccrocher)
Envoie une ligne structurée EXACTEMENT ainsi :
DONNEES: NOM=[prénom et nom complet du client], CHAMBRE=[numéro de chambre ou vide], TYPE=[type de demande : room-service/réveil/taxi/technique/réservation/autre], DEMANDE=[résumé en 1 phrase]`;

    console.log('[PROMPT] ✅ Prompt Sofia Hospitality pour', c.nom_agence, '| enregistrement:', c.enregistrement_actif||false);
    return prompt;
  }

  // ─── Prompt SOPHIE — VoiceImmo ────────────────────────────────────────────
  // Priorité 1 : instructions_ia personnalisées
  if (c.instructions_ia && c.instructions_ia.trim()) {
    let prompt = c.instructions_ia
      .replace(/\{\{CALLER\}\}/g, callerNum)
      .replace(/\{\{NUM\}\}/g, callerNum);
    if (c.enregistrement_actif) {
      prompt = recordMention + prompt;
    }
    prompt += `\n\n## COMMUNICATION DIFFICILE (OBLIGATOIRE)\nSi tu n'entends pas bien l'appelant, dis : "Je suis désolée, je vous entends mal. Pourriez-vous vous rapprocher du micro ou parler un peu plus fort ?" Si après deux tentatives le problème persiste, invite à rappeler et raccroche.`;
    prompt += `\n\n## COLLECTE DONNÉES (OBLIGATOIRE)\nQuand tu as collecté les infos, envoie une ligne structurée EXACTEMENT ainsi :\nDONNEES: NOM=[prénom et nom complet], BESOIN=[achat/vente/location/estimation], VILLE=[ville], PRIX=[prix ou vide], REF=[référence ou vide]`;
    console.log('[PROMPT] ✅ Instructions IA personnalisées pour', c.nom_agence, '| enregistrement:', c.enregistrement_actif||false);
    return prompt;
  }

  // Priorité 2 : prompt générique VoiceImmo
  console.log('[PROMPT] ⚠️ Fallback prompt générique pour', c.nom_agence);
  const agentsStr = (c.agents_arr || []).map(a => `• ${a.nom} → ${a.zones}`).join('\n');
  return `${recordMention}Tu es Sophie, assistante vocale de l'agence ${c.nom_agence}.
LANGUE : FRANÇAIS UNIQUEMENT. Jamais d'anglais.

RÈGLES ABSOLUES :
- Si tu n'entends pas bien l'appelant, dis : "Je suis désolée, je vous entends mal. Pourriez-vous vous rapprocher du micro ou parler un peu plus fort ?" — si le problème persiste après deux essais, invite à rappeler et raccroche.
- Tu ne recommandes aucune autre plateforme (SeLoger, LeBonCoin, etc.)
- Tu ne donnes pas de conseils juridiques ou financiers
- Tu collectes les informations dans cet ordre :
  1. Prénom et nom de l'appelant
  2. Nature du besoin (achat, vente, location, estimation)
  3. Ville / secteur du bien
  4. Budget approximatif
  5. Référence du bien si disponible
  6. Confirme le numéro de rappel détecté en le lisant chiffre par chiffre : "${callerNum}" — demande si c'est bien ce numéro
- Après collecte complète : "Merci [Prénom], un agent va vous rappeler très rapidement. Au revoir !"

AGENTS ET ZONES :
${agentsStr}

Site web : ${c.site_internet || 'https://www.leone-immobilier.fr'}
Numéro détecté : ${callerNum}`;
}


// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('[WS] ✅ Connexion depuis', req.socket.remoteAddress);

  let streamSid  = '';
  let callSid    = '';
  let oai        = null;
  let silenceTimer = null;
  let ready      = false;
  let queue      = [];
  let transcript = [];
  let curAss     = '';
  let lead       = { nom:'', tel:'', besoin:'', agent:'', agentNom:'', ville:'', prix:'', ref:'' };
  let cfg        = null;
  let saved      = false;
  let accueilDone = false;
  let callTimer  = null;

  let hangingUp = false; // garde-fou anti-double-raccrochage

  async function hangupTwilio(sid) {
    if (!sid) return;
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;
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
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (oai && oai.readyState === WebSocket.OPEN) oai.close();
    // Fermer aussi le WebSocket Twilio Media Stream pour libérer la connexion
    try { if (ws.readyState === ws.OPEN) ws.close(); } catch(_) {}
  }


  // ─── Sauvegarde lead en base ────────────────────────────────────────────────
  async function saveLead(leadData, cfgData) {
    try {
      const isHospitality = cfgData?.is_hospitality === true;
      if (isHospitality) {
        // ─── Hospitality : sauvegarder dans AppelHotel ─────────────────────
        const hospPayload = {
          hotel_id:        cfgData?.client_db_id || cfgData?.hotel_id || 'HOSP-DEMO',
          call_sid:        leadData.callSid || '',
          type_demande:    leadData.type_demande || 'autre',
          nom_client:      leadData.nom      || 'Inconnu',
          telephone:       leadData.tel      || 'Inconnu',
          numero_chambre:  leadData.numero_chambre || '',
          demande:         leadData.demande  || '',
          resume_ia:       leadData.demande  || '',
          statut:          'Nouveau',
          email_envoye:    true,
          notes:           leadData.transcript && leadData.transcript.length
            ? leadData.transcript.map(e =>
                (e.r === 'a' ? 'Sofia: ' : 'Client: ') + e.t
              ).join('\n')
            : '',
        };
        const resH = await fetch(`${BASE44_APP_URL}/saveAppelHotel`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(hospPayload),
          signal:  AbortSignal.timeout(15000)
        });
        const dataH = await resH.json();
        if (dataH.ok) {
          console.log('[HOSP] ✅ AppelHotel sauvegardé, id:', dataH.id);
        } else {
          console.warn('[HOSP] ⚠️ Erreur saveAppelHotel:', JSON.stringify(dataH));
        }
        return;
      }
      // ─── VoiceImmo : sauvegarder dans Lead (comportement existant) ─────────
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
          instructions: buildPrompt(cfg || DEF_CFG(), callerNum),
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: cfg?.voix || 'coral',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 }
        }
      }));
    });

    oai.on('message', async (data) => {
      let m;
      try { m = JSON.parse(data); } catch(_) { return; }

      if (m.type === 'session.updated' && !ready) {
        ready = true;
        const nomAgAccueil = cfg?.nom_agence || 'Grand Hôtel';
  const accueilDefault = `Bonjour, ${nomAgAccueil}, je suis Sofia. Puis-je avoir votre prénom et nom, s'il vous plaît ?`;
  let accueil = cfg?.message_accueil || (cfg?.is_hospitality ? accueilDefault : DEF_CFG().message_accueil);
        // Injecter la mention RGPD si enregistrement actif
        if (cfg?.enregistrement_actif) {
          accueil = injectRecordingMention(accueil, cfg?.voix);
        }
        console.log('[OAI] Session prête → accueil:', accueil.slice(0, 80));
        for (const c of queue) {
          oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: c }));
        }
        queue = [];
        oai.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: `Dis exactement ceci pour accueillir le client, une seule fois, sans répéter : "${accueil}"` }
        }));
      }

      if (m.type === 'response.output_audio.delta' && m.delta && streamSid) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: m.delta } }));
        }
      }

      if (m.type === 'response.audio_transcript.delta' && m.delta) {
        curAss += m.delta;
        // Détection phrase de fin EN STREAMING → coupe immédiatement, pas de récap
        if (!hangingUp) {
          const finPhrasesDelta = /au revoir/i;
          if (finPhrasesDelta.test(curAss)) {
            hangingUp = true;
            console.log('[FIN-DELTA] ✅ Phrase de fin détectée en streaming → annulation immédiate');
            // 1. Annuler la génération OpenAI → stoppe tout audio supplémentaire
            try { if (oai && oai.readyState === 1) oai.send(JSON.stringify({type:'response.cancel'})); } catch(e){}
            // 2. Vider le buffer audio Twilio
            try { if (ws.readyState === 1) ws.send(JSON.stringify({event:'clear', streamSid})); } catch(e){}
            // 3. Raccrocher après 800ms (laisser la dernière phrase partir)
            setTimeout(async () => {
              await hangupTwilio(callSid);
              hangup();
              await flush();
            }, 800);
          }
        }
      }

      // Détection phrase de fin + sauvegarde transcript Sophie
      async function handleSophieTranscript(text) {
        if (!text || !text.trim()) return;
        const t = text.trim();
        // Éviter les doublons
        if (transcript.some(e => e.r === 'a' && e.t === t)) return;
        transcript.push({ r: 'a', t });
        console.log(`[IA] "${t.slice(0, 100)}"`);
        // Détection phrase de fin → raccrocher dans 5s
        const finPhrases = /au revoir/i;
        if (finPhrases.test(t) && !hangingUp) {
          hangingUp = true;
          console.log('[FIN] ✅ Phrase de fin détectée (fallback transcript) → raccrochage 500ms');
          try { if (oai && oai.readyState === 1) oai.send(JSON.stringify({type:'response.cancel'})); } catch(e){}
          try { if (ws.readyState === 1) ws.send(JSON.stringify({event:'clear', streamSid})); } catch(e){}
          setTimeout(async () => {
            await hangupTwilio(callSid);
            hangup();
            await flush();
          }, 500);
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

      // Après accueil : Sofia a déjà demandé le nom, Sophie enchaîne sur étape 1
      if (m.type === 'response.done' && !accueilDone) {
        accueilDone = true;
        if (!cfg?.is_hospitality) {
          console.log('[OAI] Accueil terminé → lancement étape 1 (demande de nom)');
          oai.send(JSON.stringify({
            type: 'response.create',
            response: { instructions: 'Enchaîne IMMÉDIATEMENT sur la première étape du script : demande le prénom et le nom de l\'appelant.' }
          }));
        } else {
          console.log('[OAI] Accueil Sofia terminé → attente réponse du client');
        }
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

  function parseLeadInfo(text) {
    // PRIORITÉ 0 : Format structuré Hospitality DONNEES: NOM=[...], CHAMBRE=[...], TYPE=[...], DEMANDE=[...]
    const mHosp = text.match(/DONNEES:\s*NOM=\[([^\]]+)\].*?CHAMBRE=\[([^\]]*)\].*?TYPE=\[([^\]]*)\].*?DEMANDE=\[([^\]]*)\]/is);
    if (mHosp) {
      const nomH = mHosp[1].trim();
      if (nomH && nomH !== 'prénom et nom') {
        lead.nom = nomH;
        lead.numero_chambre = mHosp[2].trim() || '';
        lead.type_demande   = mHosp[3].trim() || 'autre';
        lead.demande        = mHosp[4].trim() || '';
        console.log('[HOSP-DATA] ✅', JSON.stringify({nom:lead.nom, chambre:lead.numero_chambre, type:lead.type_demande}));
      }
    }
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
      const EXCLUS_NOM = /^(Bonjour|Bonsoir|Merci|Bonne|Journée|Soirée|Continuation|Oui|Non|Voilà|Excusez|Désolé|Voici|Allô|Allo|Sophie|Sofia|Madame|Monsieur|Mademoiselle|Bien|Très|Super|Parfait|Accord|Revoir|Bientôt|Pour|Avoir|Faire|Aller|Venir|Prendre|Donner|Trouver|Chercher|Appeler|Vouloir|Pouvoir|Tout|Bon|Bien|Oui|Non|Ok|Okay|Voilà|Voila|Exactement|Effectivement|Absolument|Certainement|Évidemment|Evidemment|Correct|Parfait|Entendu|Compris|Aussi|Même|Encore|Toujours|Déjà|Jamais|Rien|Quelque|Chose|Autre|Celle|Celui|Ceux|Celles|Cette|Avec|Sans|Dans|Sur|Sous|Vers|Chez|Entre|Depuis|Pendant|Avant|Après|Merci|Bonne|Nuit|Jour|Soir|Matin|Demain|Hier|Aujourd|Chambre|Hôtel|Hotel|Service|Restaurant|Bar|Piscine|Spa|Réception|Reception|Annulation|Réservation|Reservation|Voxzen|Voiceimmo)$/i;
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
      // doRecord = paramètre TwiML OU config enregistrement_actif (Hospitality)
      const cfgForRecord = getConfig(params.to || params.To || '');
      const doRecord = params.record === 'true' || cfgForRecord?.enregistrement_actif === true;
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
            const baseUrl = process.env.SERVER_BASE_URL || 'https://voiceimmo-ws-production-ebd2.up.railway.app';
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
      // Réinitialiser le timer de silence à chaque paquet audio reçu
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (!hangingUp && ready) {
        silenceTimer = setTimeout(async () => {
          if (hangingUp) return;
          // Étape 1 : demander si l'appelant est toujours là
          console.log('[SILENCE] 10s sans audio → demande présence');
          try {
            if (oai && oai.readyState === 1) {
              oai.send(JSON.stringify({
                type: 'response.create',
                response: { instructions: 'Dis naturellement, avec une voix douce et un peu inquiète : "Vous êtes toujours là ?" — rien d\'autre, juste cette phrase.' }
              }));
            }
          } catch(e) {}
          // Étape 2 : si toujours pas de réponse après 10s supplémentaires → raccrocher
          silenceTimer = setTimeout(async () => {
            if (hangingUp) return;
            hangingUp = true;
            console.log('[SILENCE] 20s total sans audio → raccrochage');
            try { if (oai && oai.readyState === 1) oai.send(JSON.stringify({type:'response.create', response:{instructions:'Dis : "Je ne vous entends plus, je vais raccrocher. N\'hésitez pas à nous rappeler. Au revoir !"'}})); } catch(e){}
            setTimeout(async () => {
              await hangupTwilio(callSid);
              hangup();
              await flush();
            }, 2500);
          }, 10000);
        }, 10000);
      }
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
  const mp3Url = `${process.env.WS_BASE_URL || 'https://voiceimmo-ws-production-ebd2.up.railway.app'}/recording/${RecordingSid}`;
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

server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v54-stripe sur port ${PORT}`));
