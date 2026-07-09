'use strict';
const http      = require('http');
const express   = require('express');
const { WebSocketServer, WebSocket } = require('ws');

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
    voix:                'coral',
    site_internet:       'https://www.leone-immobilier.fr',
    message_accueil:     "Bonjour et bienvenue chez Leone Immobilier ! Comment puis-je vous aider aujourd'hui ? Vous souhaitez vendre, acheter, ou louer ?",
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
      + '<tr><td style="padding:8px;font-weight:bold">Téléphone</td><td style="padding:8px"><a href="tel:' + (lead.tel||'').replace(/\s/g,'') + '" style="color:#4f46e5;font-weight:700;text-decoration:none;font-size:16px">' + (lead.tel||'N/A') + '</a></td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Besoin</td><td style="padding:8px">' + (lead.besoin||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Ville</td><td style="padding:8px">' + (lead.ville||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;background:#f3f4f6;font-weight:bold">Prix</td><td style="padding:8px">' + (lead.prix||'N/A') + '</td></tr>'
      + '<tr><td style="padding:8px;font-weight:bold">Référence</td><td style="padding:8px">' + (lead.ref||'N/A') + '</td></tr>'
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
app.get('/',       (req, res) => res.json({ status: 'ok', version: 'v64.10-revert-recap-timer', service: 'VoiceImmo WS', build: '20260709.0848' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', async (req, res) => {
  let oaiOk = false, gmailOk = false;
  try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }); oaiOk = r.ok; } catch(_) {}
  gmailOk = true; // Resend
  res.json({ version: 'v64.10-revert-recap-timer', hasOAI: !!OPENAI_API_KEY, oaiOk, gmailOk, configs: Object.keys(CONFIGS) });
});

app.get('/logs', (req, res) => {
  const n     = parseInt(req.query.n    || '50');
  const since = parseInt(req.query.since|| '0');
  res.json({ logs: LOG_BUFFER.filter(l => l.ts > since).slice(-n), serverTime: Date.now(), version: 'v64.10-revert-recap-timer' });
});

app.get('/stats', async (req, res) => {
  let oaiOk = false, gmailOk = false;
  try { const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }); oaiOk = r.ok; } catch(_) {}
  gmailOk = true; // Resend
  res.json({ ok: true, version: 'v64.10-revert-recap-timer', uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed/1024/1024), oaiOk, gmailOk, node: process.version, serverTime: Date.now(), activeConnections: wss.clients.size, configs: Object.keys(CONFIGS) });
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
    <Stream url="${baseUrl.replace('https://','wss://').replace('http://','ws://')}">
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
  // Ordre STRICT validé par CR : 1) accueil  2) mention enregistrement  3) elle enchaine sur le déroulement
  const accueilNettoye = messageAccueil.trimEnd().replace(/[.,!?]+$/, '');
  return accueilNettoye + '. ' + mention.trim();
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
    // Toujours injecter le garde-fou anti-hallucination (même pour les instructions personnalisées)
    prompt += `\n\n## GARDE-FOU ANTI-HALLUCINATION (OBLIGATOIRE)\nN'INVENTE JAMAIS un nom, une ville, un besoin ou une réponse. Si l'audio n'est pas clair (bruit de fond, circulation, vent, appelant qui marche ou parle loin du téléphone, voix hachée), NE DEVINE PAS : dis simplement "Je n'ai pas bien entendu, pouvez-vous répéter s'il vous plaît ?" et attends une vraie réponse avant de continuer. Ne remplis un champ (nom/ville/besoin/prix/référence) QUE si l'appelant l'a clairement et explicitement énoncé lui-même dans cet appel.`;
    // Toujours injecter le bloc de collecte structurée
    prompt += `\n\n## COLLECTE DONNÉES (OBLIGATOIRE)\nQuand tu as collecté les infos, avant de raccrocher, envoie une ligne structurée EXACTEMENT ainsi :\nDONNEES: NOM=[prénom et nom complet], BESOIN=[achat/vente/location/estimation], VILLE=[ville], PRIX=[prix ou vide], REF=[référence ou vide]`;
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
- Ton ton est chaleureux, avenant et souriant — tu parles comme une personne accueillante, pas comme un robot froid. Utilise des formulations naturelles et sympathiques. Ton objectif est que l'appelant vive une expérience fluide et agréable, à l'écoute et sans jamais le brusquer.
- Tu ne recommandes aucune autre plateforme (SeLoger, LeBonCoin, etc.)
- Tu ne donnes pas de conseils juridiques ou financiers
- N'INVENTE JAMAIS d'information. Si tu n'as pas clairement entendu ou compris ce que dit l'appelant (son coupé, bruit de fond, silence, voix pas claire), NE DEVINE PAS un nom, un besoin ou une réponse : dis simplement "Je n'ai pas bien entendu, pouvez-vous répéter s'il vous plaît ?" et attends sa réponse.
- Ta toute première question après l'accueil est simplement : bien attendre la réponse de l'appelant à "vente, achat ou location". Ne remercie JAMAIS et n'invente JAMAIS de prénom avant que l'appelant ait réellement répondu à une question.
- Une fois que l'appelant a répondu à "vente, achat ou location", tu collectes ensuite les informations dans cet ordre :
  1. Prénom et nom de l'appelant
  2. Ville / secteur du bien
  3. Budget approximatif
  4. Référence du bien si disponible
  5. Confirme le numéro de rappel détecté en le lisant chiffre par chiffre : "${callerNum}" — demande si c'est bien ce numéro
- DÈS QUE l'appelant a confirmé (oui/non/correction) le numéro de rappel à l'étape 5, tu dis IMMÉDIATEMENT et UNIQUEMENT la phrase de clôture suivante, sans rien ajouter d'autre, sans récapitulatif : "Merci [Prénom], un agent va vous recontacter sous 24 heures. Je vous souhaite une excellente journée, au revoir !"

AGENTS ET ZONES :
${agentsStr}

Site web : ${c.site_internet || 'https://www.leone-immobilier.fr'}
Numéro détecté : ${callerNum}`;
}


// ─── WebSocket Handler ────────────────────────────────────────────────────────


wss.on('connection', (ws, req) => {
  console.log('[WS] ✅ Connexion depuis', req.socket.remoteAddress);
  console.log('[WS] Protocol négocié:', ws.protocol || '(aucun)', '| Headers upgrade:', JSON.stringify({ 'sec-websocket-protocol': req.headers['sec-websocket-protocol'], host: req.headers.host }));
  const __startWatchdog = setTimeout(() => {
    console.warn('[WS] ⚠️ Aucun événement "start" reçu 5s après connexion — Twilio n\'a peut-être pas ouvert le flux média correctement.');
  }, 5000);

  let streamSid  = '';
  let callSid    = '';
  let oai        = null;
  let ready      = false;
  let queue      = [];
  let transcript = [];
  let curAss     = '';
  let lead       = { nom:'', tel:'', besoin:'', agent:'', agentNom:'', ville:'', prix:'', ref:'' };
  let lastQuestion = null; // derniere question posee par Sophie (ville/prix/ref/nom) pour capture brute si reponse en un mot
  let cfg        = null;
  let saved      = false;
  let accueilDone = false;
  let firstRealTurnHandled = false; // évite l'auto-réponse VAD parasite (repetition question 1) avant la 1ere vraie reponse de l'appelant
  let callTimer  = null;

  let hangingUp = false; // garde-fou anti-double-raccrochage
  let cancelGraceTimer = null; // timer de grâce avant cancel éventuel (laisse l'audio de clôture finir de se générer)
  let hangupTimerSet = false;  // garde-fou anti-double-raccrochage programmé
  const finPhrases = /au revoir|à bientôt|à très bientôt|bientôt|bonne journée|bonne soirée|bonne continuation|rappeler très rapidement/i;
  function scheduleHangup(delayMs) {
    if (hangupTimerSet) return;
    hangupTimerSet = true;
    setTimeout(async () => {
      await hangupTwilio(callSid);
      hangup();
      await flush();
    }, delayMs);
  }

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
    if (oai && oai.readyState === WebSocket.OPEN) oai.close();
    // Fermer aussi le WebSocket Twilio Media Stream pour libérer la connexion
    try { if (ws.readyState === ws.OPEN) ws.close(); } catch(_) {}
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
    console.log('[OAI] 🔌 connectOAI() appelé — model:', OAI_MODEL, '| callerNum:', callerNum, '| clé présente:', !!OPENAI_API_KEY, '| longueur clé:', (OPENAI_API_KEY||'').length);
    oai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${OAI_MODEL}`,
      ['realtime'],
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    oai.on('unexpected-response', (req2, res2) => {
      let body = '';
      res2.on('data', (c) => { body += c; });
      res2.on('end', () => {
        console.error('[OAI] ❌ Unexpected HTTP response lors du handshake — status:', res2.statusCode, '| body:', body.slice(0, 500));
      });
    });

    oai.on('open', () => {
      console.log('[OAI] ✅ WebSocket ouvert — envoi session.update');
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
              turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 900, create_response: false }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: (cfg || DEF_CFG())?.voix || 'coral'
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
        if (false /* ElevenLabs désactivé */) {
          // ElevenLabs TTS pour le message d'accueil
          console.log('[EL-TTS] Accueil via ElevenLabs Amélie...');
          sendElevenLabsAudio(ws, streamSid, accueil, ELEVENLABS_VOICE_ID).catch(e => {
            console.error('[EL-TTS] Fallback OpenAI:', e.message);
            oai.send(JSON.stringify({
              type: 'response.create',
              response: { instructions: `Dis exactement ceci pour accueillir le client, une seule fois, sans répéter : "${accueil}"` }
            }));
          });
          // Demander à OpenAI de passer à l'étape 1 sans re-générer l'accueil
          setTimeout(() => {
            oai.send(JSON.stringify({
              type: 'response.create',
              response: { instructions: 'Le message d\'accueil a déjà été dit. Attends la réponse du client.' }
            }));
          }, 2500);
        } else {
          oai.send(JSON.stringify({
            type: 'response.create',
            response: { instructions: `Dis exactement ceci pour accueillir le client, une seule fois, sans répéter : "${accueil}"` }
          }));
        }
      }

      if (m.type === 'response.output_audio.delta' && m.delta && streamSid) {
        if (true /* ElevenLabs désactivé */) {
          // Fallback : audio OpenAI direct
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: m.delta } }));
          }
        }
        // Si ElevenLabs actif : on ignore l'audio OpenAI, on attend le transcript
      }

      // ElevenLabs TTS : intercepter le transcript et générer l'audio via ElevenLabs
      if (false /* ElevenLabs désactivé */ &&
          m.type === 'response.output_audio_transcript.done' && m.transcript && streamSid) {
        const txt = m.transcript.trim();
        if (txt) {
          sendElevenLabsAudio(ws, streamSid, txt, ELEVENLABS_VOICE_ID).catch(e =>
            console.error('[EL-TTS] Erreur réponse:', e.message)
          );
        }
      }

      if (m.type === 'response.output_audio_transcript.delta' && m.delta) {
        curAss += m.delta;
        // Anti-récapitulatif MOINS INTRUSIF : le texte (delta) arrive bien plus vite que l'audio ne se
        // génère/joue réellement sur la ligne. Annuler IMMÉDIATEMENT ici coupait l'audio de la phrase de
        // clôture elle-même avant qu'elle ait fini de jouer. On laisse donc une grâce pour que la réponse
        // se termine naturellement (cas normal, pas de récap) ; on ne cancel QUE si elle continue au-delà
        // de cette grâce (signe d'un vrai récapitulatif qui déborde).
        if (!hangingUp && finPhrases.test(curAss)) {
          hangingUp = true;
          console.log('[FIN] ✅ Phrase de clôture détectée en streaming → grâce de 5s (laisse l\'audio de clôture se terminer) avant cancel éventuel');
          // Empêche le server_vad d'auto-déclencher une NOUVELLE réponse (ex: bruit de fond après le
          // "au revoir") pendant qu'on referme l'appel — root cause du "0.5s de récap" entendu juste
          // avant la coupure : une réponse parasite démarrait après la clôture et se faisait couper net
          // par notre hangup programmé, au lieu de ne jamais démarrer.
          if (oai && oai.readyState === WebSocket.OPEN) {
            oai.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 900, create_response: false } } } } }));
          }
          cancelGraceTimer = setTimeout(() => {
            cancelGraceTimer = null;
            console.log('[FIN] ⏱️ Grâce écoulée, réponse toujours active → response.cancel (récap probable) + raccrochage dans 1.5s');
            if (oai && oai.readyState === WebSocket.OPEN) {
              oai.send(JSON.stringify({ type: 'response.cancel' }));
            }
            scheduleHangup(1500);
          }, 5000);
        }
      }

      // Détection phrase de fin + sauvegarde transcript Sophie
      async function handleSophieTranscript(text) {
        if (!text || !text.trim()) return;
        const t = text.trim();
        // Eviter les doublons
        if (transcript.some(e => e.r === 'a' && e.t === t)) return;
        transcript.push({ r: 'a', t });
        console.log(`[IA] "${t.slice(0, 100)}"`);

        // Sophie comprend souvent le nom correctement meme quand la transcription de l'utilisateur
        // le rate (ex: bruit, debit rapide) -- on utilise ses propres confirmations comme signal fiable.
        if (!lead.nom || lead.nom === 'Inconnu') {
          const mDonc = t.match(/\bdonc\s+([A-ZÀ-Ÿ][a-zà-ÿ\-]{2,})\s+([A-ZÀ-Ÿ][a-zà-ÿ\-]{2,})\b/);
          const mMerciFull = t.match(/\bMerci\s+([A-ZÀ-Ÿ][a-zà-ÿ\-]{2,})\s+([A-ZÀ-Ÿ][a-zà-ÿ\-]{2,})\b/);
          if (mDonc) lead.nom = `${mDonc[1]} ${mDonc[2]}`;
          else if (mMerciFull) lead.nom = `${mMerciFull[1]} ${mMerciFull[2]}`;
        }

        // Detecte la question que Sophie vient de poser, pour permettre une capture brute de la
        // reponse suivante si l'appelant repond en un seul mot sans preposition (ex: "Avion.").
        if (/secteur|ville|où se trouve|où se situe/i.test(t))       lastQuestion = 'ville';
        else if (/budget|prix|combien|valeur approximative/i.test(t)) lastQuestion = 'prix';
        else if (/référence/i.test(t))                                lastQuestion = 'ref';
        else if (/prénom|comment vous appelez|nom de famille|votre nom/i.test(t)) lastQuestion = 'nom';
        else if (finPhrases.test(t)) lastQuestion = null;
        // Fallback : si jamais la détection en streaming (delta) n'a pas déclenché, on la retente ici sur le texte complet
        if (finPhrases.test(t) && !hangingUp) {
          hangingUp = true;
          console.log('[FIN] ✅ Phrase de fin détectée (fallback done) → raccrochage dans 7s (laisse jouer l\'audio complet)');
          if (oai && oai.readyState === WebSocket.OPEN) {
            oai.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 900, create_response: false } } } } }));
          }
          scheduleHangup(7000);
          return;
        }
        // La réponse contenant la clôture s'est terminée NATURELLEMENT avant la fin de la grâce → pas de
        // récap, pas besoin de cancel. On raccroche après un délai généreux pour laisser le temps à tout
        // l'audio déjà généré (mais pas encore fini de jouer sur la ligne) de se terminer.
        if (hangingUp && cancelGraceTimer) {
          clearTimeout(cancelGraceTimer);
          cancelGraceTimer = null;
          console.log('[FIN] ✅ Réponse de clôture terminée naturellement (pas de récap) → raccrochage dans 7s (laisse jouer l\'audio complet)');
          scheduleHangup(7000);
        }
      }

      // Source 1 : response.output_audio_transcript.done (event standard)
      if (m.type === 'response.output_audio_transcript.done' && curAss) {
        await handleSophieTranscript(curAss);
        curAss = '';
      }

      // Source 2 : response.output_item.done → item.formatted.transcript (fallback fiable)
      if (m.type === 'response.output_item.done' && m.item?.formatted?.transcript) {
        await handleSophieTranscript(m.item.formatted.transcript);
        if (!curAss) curAss = ''; // reset si déjà capturé
      }

      // Après le message d'accueil + mention enregistrement → on enchaîne IMMÉDIATEMENT
      // (sans attendre l'appelant) sur la première question du déroulement (identifier le besoin).
      // C'est SEULEMENT après cette vraie question qu'on attend la réponse de l'appelant.
      if (m.type === 'response.done' && !accueilDone) {
        accueilDone = true;
        console.log('[OAI] Accueil + mention terminés → enchaînement sur la question d\'ouverture du déroulement');
        oai.send(JSON.stringify({
          type: 'response.create',
          response: { instructions: 'L\'accueil et la mention d\'enregistrement ont déjà été dits, ne les répète surtout pas et ne dis pas à nouveau bonjour. Dis EXACTEMENT et UNIQUEMENT cette phrase, mot pour mot, sans rien changer ni ajouter : "Vous souhaitez des renseignements pour un achat, une vente, une location, ou une estimation ?". N\'ajoute AUCUNE formule de transition avant ("d\'accord", "je vais vous aider", etc.) et ne reformule pas la phrase à ta manière. Puis attends réellement la réponse de l\'appelant — ne réponds jamais à sa place.' }
        }));
      }

      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        transcript.push({ r: 'u', t: m.transcript });
        console.log(`[USER] "${m.transcript.slice(0, 100)}"`);
        parseLeadInfo(m.transcript);

        // 1ere vraie reponse de l'appelant : on reactive l'auto-reponse VAD pour la suite normale de
        // la conversation (create_response:false servait uniquement a eviter qu'un silence pendant
        // l'accueil/la question d'ouverture ne fasse repeter la question par le modele). On declenche
        // aussi manuellement la reponse a CETTE premiere reponse, puisqu'elle n'a pas ete auto-generee.
        if (!firstRealTurnHandled) {
          firstRealTurnHandled = true;
          if (oai && oai.readyState === WebSocket.OPEN) {
            oai.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 900, create_response: true } } } } }));
            oai.send(JSON.stringify({ type: 'response.create' }));
          }
        }
      }

      if (m.type === 'error') console.error('[OAI] Erreur:', JSON.stringify(m.error));
    });

    oai.on('error', (e) => console.error('[OAI] ❌ WS Error:', e.message, '| code:', e.code));
    oai.on('close', (code, reason) => console.log('[OAI] Fermé — code:', code, '| reason:', reason ? reason.toString() : '(vide)'));
  }

  function parseLeadInfo(text) {
    // PRIORITÉ 1 : Format structuré DONNEES: NOM=..., BESOIN=..., etc.
    // Le modèle n'écrit PAS les crochets litéraux du template (NOM=Christophe, pas NOM=[Christophe]) —
    // la regex accepte donc les 2 formats (avec ou sans crochets), séparateur virgule ou saut de ligne.
    const mData = text.match(/DONNEES:\s*NOM=\[?([^,\]\n]+)\]?\s*,\s*BESOIN=\[?([^,\]\n]+)\]?\s*,\s*VILLE=\[?([^,\]\n]*)\]?\s*,\s*PRIX=\[?([^,\]\n]*)\]?\s*,\s*REF=\[?([^,\]\n]*)\]?/is);
    if (mData) {
      const [, nom, besoin, ville, prix, ref] = mData;
      if (nom && nom.trim() && nom.trim().toLowerCase() !== 'vide') lead.nom = nom.trim();
      if (besoin && besoin.trim() && besoin.trim().toLowerCase() !== 'vide') lead.besoin = besoin.trim();
      if (ville && ville.trim() && ville.trim().toLowerCase() !== 'vide') lead.ville = ville.trim();
      if (prix && prix.trim() && prix.trim().toLowerCase() !== 'vide') lead.prix = prix.trim();
      if (ref && ref.trim() && ref.trim().toLowerCase() !== 'vide') lead.ref = ref.trim();
      console.log('[PARSE] ✅ Format structuré détecté → nom:', lead.nom, '| besoin:', lead.besoin, '| ville:', lead.ville, '| prix:', lead.prix, '| ref:', lead.ref);
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

    // Capture brute de secours : si Sophie vient de poser une question précise (ville/prix/ref) et que
    // l'appelant répond en un seul mot SANS préposition ("Avion.", "Bordeaux"), les regex ci-dessus ne
    // matchent rien. On prend alors directement la réponse brute (nettoyée) comme valeur du champ attendu.
    const brut = text.replace(/[\.!\?,;]+\s*$/, '').trim();
    const exclusBrut = /^(oui|non|allo|allô|bonjour|bonsoir|merci|d.accord|voilà|hum|euh|pardon)$/i;
    if (lastQuestion === 'ville' && !lead.ville && brut && brut.length >= 3 && !exclusBrut.test(brut)) {
      lead.ville = brut;
      lastQuestion = null;
    } else if (lastQuestion === 'prix' && !lead.prix && brut && /\d/.test(brut)) {
      lead.prix = brut;
      lastQuestion = null;
    } else if (lastQuestion === 'ref' && !lead.ref && brut && !exclusBrut.test(brut)) {
      lead.ref = brut.replace(/^(la\s+)?référence\s*(de bien|du bien)?\s*(est|c.est)?\s*/i, '').trim() || brut;
      lastQuestion = null;
    } else if ((lead.ville && lastQuestion === 'ville') || (lead.prix && lastQuestion === 'prix') || (lead.ref && lastQuestion === 'ref')) {
      lastQuestion = null; // déjà rempli par une regex plus précise ci-dessus, on efface l'attente
    }
  }

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch(e) { console.warn('[WS] ⚠️ Message non-JSON reçu, taille=', data.length, 'erreur:', e.message); return; }

    if (m.event !== 'media') console.log('[WS] Event reçu:', m.event);
    if (m.event === 'start') {
      clearTimeout(__startWatchdog);
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
        console.log('[TIMER] 5min → raccrochage automatique');
        hangingUp = true;
        await hangupTwilio(callSid);
        hangup();
        await flush();
      }, 300000);

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

  ws.on('close', async (code, reason) => { clearTimeout(__startWatchdog); console.log('[WS] Connexion fermée — code:', code, '| reason:', reason ? reason.toString() : '(vide)'); await flush(); });
  ws.on('error', (e) => console.error('[WS] ❌ Erreur:', e.message));
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
// Fix CORS 03/07/2026 : les dashboards admin.voxzen.io / admin-dev.voxzen.io appellent
// cette route en cross-origin depuis le navigateur. Sans header CORS, le fetch()
// était bloqué silencieusement par le navigateur (catch{} vide côté frontend) et
// aucun email n'était jamais réellement envoyé malgré un statut 200 en test direct (curl).
app.options('/send-otp', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});
app.post('/send-otp', express.json(), (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
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

server.listen(PORT, '0.0.0.0', () => console.log(`[START] VoiceImmo WS v63.2-wait-for-response sur port ${PORT}`));
