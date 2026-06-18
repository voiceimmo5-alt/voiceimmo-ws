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
      + '<tr><td style="padding:8px;font-weight:bold">Téléphone</td><td style="padding:8px">' + (lead.telephone||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Besoin</td><td style="padding:8px">' + (lead.besoin||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Ville</td><td style="padding:8px">' + (lead.ville||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Prix</td><td style="padding:8px">' + (lead.prix||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Référence</td><td style="padding:8px">' + (lead.reference||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Agent</td><td style="padding:8px">' + agentLabel + '</td></tr>'
      + '</table>'
      + (recordingUrl ? '<p style="margin-top:20px;color:#6b7280;font-size:13px">Enregistrement de l\'appel en piece jointe.</p>' : '')
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
app.get('/',       (req, res) => res.json({ status: 'ok', version: 'v54-stripe', service: 'VoiceImmo WS' }));
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
  const baseUrl = process.env.SERVER_BASE_URL || 'https://ws-staging.voiceimmo.fr';

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
    <Stream url="wss://ws-staging.voiceimmo.fr">
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
  // Insérer la mention après la première phrase (après le premier point ou virgule)
  const match = messageAccueil.match(/^([^.!?]+[.!?]\s*)/);
  if (match) {
    return match[0] + mention + messageAccueil.slice(match[0].length);
  }
  return messageAccueil + ' ' + mention;
}

// ─── Prompt Sophie ────────────────────────────────────────────────────────────
function buildPrompt(c, callerNum) {
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
    console.log('[PROMPT] ✅ Instructions IA personnalisées utilisées pour', c.nom_agence, '| caller:', callerNum, '| enregistrement:', c.enregistrement_actif||false);
    return prompt;
  }
  // Priorité 2 : prompt générique fallback
  console.log('[PROMPT] ⚠️ Fallback prompt générique pour', c.nom_agence);
  const agentsStr = (c.agents_arr || []).map(a => `• ${a.nom} → ${a.zones}`).join('\n');
  const recordMention = c.enregistrement_actif ? getRecordingMention(c.voix) : '';
  return `${recordMention}Tu es Sophie, assistante vocale de l'agence ${c.nom_agence}.
LANGUE : FRANÇAIS UNIQUEMENT. Jamais d'anglais.

RÈGLES ABSOLUES :
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
  let ready      = false;
  let queue      = [];
  let transcript = [];
  let curAss     = '';
  let lead       = { nom:'', tel:'', besoin:'', agent:'', agentNom:'', ville:'', prix:'', ref:'' };
  let cfg        = null;
  let saved      = false;
  let accueilDone = false;
  let callTimer  = null;

  function hangup() {
    if (callTimer) { clearTimeout(callTimer); callTimer = null; }
    if (oai && oai.readyState === WebSocket.OPEN) oai.close();
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
        signal:  AbortSignal.timeout(8000)
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
        signal:  AbortSignal.timeout(8000)
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
      sendEmail(lead, activeCfg, transcript, lead.recording_url),
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
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: cfg?.voix || 'coral'
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
        let accueil = cfg?.message_accueil || DEF_CFG().message_accueil;
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
          response: { instructions: `IMPORTANT: Prononce MAINTENANT ce message d'accueil en français, mot pour mot : "${accueil}"` }
        }));
      }

      if (m.type === 'response.output_audio.delta' && m.delta && streamSid) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: m.delta } }));
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
        if (finPhrases.test(t)) {
          console.log('[FIN] Phrase de fin détectée → raccrochage dans 5s');
          setTimeout(async () => {
            console.log('[FIN] → fermeture WebSocket');
            try { ws.close(); } catch(_) {}
            try { if (oai) oai.close(); } catch(_) {}
            if (callSid) {
              try {
                const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
                await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`, {
                  method: 'POST',
                  headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: 'Status=completed'
                });
                console.log('[FIN] REST Twilio envoyé');
              } catch(e) { console.warn('[FIN] REST error:', e.message); }
            }
            await flush();
          }, 5000);
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

      // Après le message d'accueil → Sophie enchaîne directement sur l'étape 1
      if (m.type === 'response.done' && !accueilDone) {
        accueilDone = true;
        console.log('[OAI] Accueil terminé → lancement étape 1 (demande de nom)');
        oai.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: 'Enchaîne IMMÉDIATEMENT sur la première étape du script : demande le prénom et le nom de l\'appelant.' }
        }));
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
    // Nom : "je m'appelle X", "c'est X Y" (prénom + nom obligatoire), "mon nom est X"
    if (!lead.nom) {
      const mApp = text.match(/je m.appelle\s+([A-ZÀ-Ýa-zà-ý]+(?:\s+[A-ZÀ-Ýa-zà-ý]+)+)/i);
      const mNom = text.match(/mon nom est\s+([A-ZÀ-Ýa-zà-ý]+(?:\s+[A-ZÀ-Ýa-zà-ý]+)+)/i);
      // "c'est X Y" : exige au moins prénom + nom (2 mots min, premiers en majuscule)
      const mCest = text.match(/c.est\s+([A-ZÀ-Ý][a-zà-ý]+\s+[A-ZÀ-Ý][a-zà-ý]+)/);
      if (mApp) lead.nom = mApp[1];
      else if (mNom) lead.nom = mNom[1];
      else if (mCest) lead.nom = mCest[1];
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
      callTimer = setTimeout(() => { console.log('[TIMER] 2min → raccrocher'); hangup(); }, 120000);

      // Déclencher l'enregistrement via API REST Twilio (pas via TwiML pour ne pas couper le stream)
      if (doRecord && callSid && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        setTimeout(async () => {
          try {
            const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
            const baseUrl = process.env.SERVER_BASE_URL || 'https://ws-staging.voiceimmo.fr';
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
