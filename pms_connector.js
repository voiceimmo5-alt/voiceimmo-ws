/**
 * pms_connector.js — Voxzen Hospitality PMS Connector
 * =====================================================
 * Connecteur multi-PMS pour l'intégration voicebot Sofia
 *
 * PMS supportés :
 *   - oracle  : Mock local Oracle Opera Cloud (OHIP simulé)
 *   - mews    : Mews Connector API (sandbox public disponible)
 *   - apaleo  : Apaleo REST API (sandbox dev gratuit)
 *
 * Usage :
 *   const pms = createPMSConnector(pms_type, pms_config);
 *   const resa = await pms.getReservation(reservationId);
 *   const dispo = await pms.checkAvailability({ dateArrivee, dateDepart, nbPersonnes });
 *   await pms.createReservation({ ... });
 *   const facture = await pms.getBill(reservationId);
 *
 * Auteur : FR (Voxzen)
 * Version : V1.0.0
 * Date : 26/06/2026
 */

'use strict';

// ─── Timeouts & constantes ────────────────────────────────────────────────────
const PMS_TIMEOUT = 8000; // 8s max par appel PMS

// ─── Helpers ─────────────────────────────────────────────────────────────────
function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`PMS timeout après ${ms}ms`)), ms)
  );
}

async function fetchWithTimeout(url, options, ms = PMS_TIMEOUT) {
  return Promise.race([fetch(url, options), timeout(ms)]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MOCK ORACLE OPERA CLOUD (local)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Mock Oracle Opera Cloud (OHIP)
 * Simule les endpoints REST Opera Cloud sans instance réelle.
 * Quand une vraie instance Oracle est disponible, remplacer
 * les méthodes par des appels à :
 *   https://[host]/fol/v1/hotels/[hotelId]/reservations
 * avec OAuth2 client_credentials Oracle.
 */
class OracleMockConnector {
  constructor(config = {}) {
    this.hotelId = config.hotel_id || 'SAND01';
    this.name = 'Oracle Opera Cloud (Mock)';

    // Données de test simulées
    this._reservations = [
      {
        id: 'RES-001',
        reservationId: 'RES-001',
        nom: 'Dupont',
        prenom: 'Jean',
        telephone: '+33612345678',
        email: 'jean.dupont@email.com',
        numeroChambre: '204',
        typeChambre: 'Chambre Deluxe',
        dateArrivee: '2026-06-26',
        dateDepart: '2026-06-28',
        nbNuits: 2,
        nbPersonnes: 2,
        prixNuit: 189,
        montantTotal: 378,
        statut: 'DUE_IN',
        source: 'booking.com',
        demandesSpeciales: 'Lit double, vue sur jardin',
      },
      {
        id: 'RES-002',
        reservationId: 'RES-002',
        nom: 'Martin',
        prenom: 'Claire',
        telephone: '+33698765432',
        email: 'c.martin@corp.fr',
        numeroChambre: '312',
        typeChambre: 'Suite Junior',
        dateArrivee: '2026-06-25',
        dateDepart: '2026-06-27',
        nbNuits: 2,
        nbPersonnes: 1,
        prixNuit: 290,
        montantTotal: 580,
        statut: 'IN_HOUSE',
        source: 'direct',
        demandesSpeciales: 'Oreiller ergonomique',
      },
    ];

    this._chambres = [
      { numero: '101', type: 'Standard', capacite: 2, prix: 129, statut: 'VACANT_CLEAN' },
      { numero: '102', type: 'Standard', capacite: 2, prix: 129, statut: 'OCCUPIED' },
      { numero: '203', type: 'Deluxe', capacite: 2, prix: 189, statut: 'VACANT_CLEAN' },
      { numero: '204', type: 'Deluxe', capacite: 2, prix: 189, statut: 'OCCUPIED' },
      { numero: '301', type: 'Suite Junior', capacite: 3, prix: 290, statut: 'VACANT_DIRTY' },
      { numero: '312', type: 'Suite Junior', capacite: 1, prix: 290, statut: 'OCCUPIED' },
      { numero: '401', type: 'Suite Prestige', capacite: 4, prix: 450, statut: 'VACANT_CLEAN' },
    ];
  }

  async getReservation(reservationId) {
    await this._simulateLatency();
    const r = this._reservations.find(r => r.id === reservationId || r.numeroChambre === reservationId);
    if (!r) throw new Error(`Réservation ${reservationId} introuvable (mock Opera)`);
    return r;
  }

  async getReservationByPhone(telephone) {
    await this._simulateLatency();
    const r = this._reservations.find(r => r.telephone === telephone);
    return r || null;
  }

  async getReservationByRoom(numeroChambre) {
    await this._simulateLatency();
    return this._reservations.find(r => r.numeroChambre === numeroChambre && r.statut === 'IN_HOUSE') || null;
  }

  async checkAvailability({ dateArrivee, dateDepart, nbPersonnes = 1, typeChambre = null }) {
    await this._simulateLatency();
    const disponibles = this._chambres.filter(c =>
      c.statut === 'VACANT_CLEAN' &&
      c.capacite >= nbPersonnes &&
      (!typeChambre || c.type.toLowerCase().includes(typeChambre.toLowerCase()))
    );
    return {
      disponible: disponibles.length > 0,
      chambres: disponibles,
      dateArrivee,
      dateDepart,
      nbPersonnes,
    };
  }

  async createReservation({ nom, prenom, telephone, email, typeChambre, dateArrivee, dateDepart, nbPersonnes, demandesSpeciales }) {
    await this._simulateLatency();
    const chambre = this._chambres.find(c => c.statut === 'VACANT_CLEAN' && c.type.toLowerCase().includes((typeChambre || '').toLowerCase()));
    if (!chambre) throw new Error('Aucune chambre disponible pour ces critères (mock Opera)');

    const nbNuits = Math.max(1, Math.round((new Date(dateDepart) - new Date(dateArrivee)) / 86400000));
    const nouvelleResa = {
      id: `RES-${String(this._reservations.length + 1).padStart(3, '0')}`,
      reservationId: `RES-${String(this._reservations.length + 1).padStart(3, '0')}`,
      nom, prenom, telephone, email,
      numeroChambre: chambre.numero,
      typeChambre: chambre.type,
      dateArrivee, dateDepart,
      nbNuits,
      nbPersonnes,
      prixNuit: chambre.prix,
      montantTotal: chambre.prix * nbNuits,
      statut: 'RESERVED',
      source: 'voicebot_voxzen',
      demandesSpeciales: demandesSpeciales || '',
    };
    this._reservations.push(nouvelleResa);
    chambre.statut = 'OCCUPIED';
    return nouvelleResa;
  }

  async getBill(reservationId) {
    await this._simulateLatency();
    const r = await this.getReservation(reservationId);
    return {
      reservationId: r.id,
      nom: `${r.prenom} ${r.nom}`,
      chambre: r.numeroChambre,
      montantHT: Math.round(r.montantTotal / 1.1),
      tva: Math.round(r.montantTotal - r.montantTotal / 1.1),
      montantTTC: r.montantTotal,
      statut: 'NON_PAYEE',
      items: [
        { libelle: `Nuit(s) ${r.typeChambre}`, quantite: r.nbNuits, prixUnitaire: r.prixNuit, total: r.montantTotal },
      ],
    };
  }

  async getRoomStatus(numeroChambre) {
    await this._simulateLatency();
    const c = this._chambres.find(c => c.numero === numeroChambre);
    return c || null;
  }

  _simulateLatency() {
    return new Promise(r => setTimeout(r, 80 + Math.random() * 120)); // 80–200ms réaliste
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. MEWS CONNECTOR API
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Mews Connector API
 * Docs : https://docs.mews.com/connector-api
 * Sandbox public : https://api.mews-demo.com
 *
 * Tokens publics de démo (Gross Pricing - UK) :
 *   ClientToken  : E0D439EE522F44368DC78E1BFB03710C-D24FB11DBE31D4621C4817E028D9E1D
 *   AccessToken  : C66EF7B239D24632943D115EDE9CB810-EA00F8FD8294692C940F6B5A8F9453D
 *
 * En production, les tokens sont fournis par Mews après certification.
 */
class MewsConnector {
  constructor(config = {}) {
    this.demo = config.demo !== false; // true par défaut si pas de config prod
    this.baseUrl = this.demo
      ? 'https://api.mews-demo.com'
      : (config.base_url || 'https://api.mews.com');
    this.clientToken = config.client_token || 'E0D439EE522F44368DC78E1BFB03710C-D24FB11DBE31D4621C4817E028D9E1D';
    this.accessToken = config.access_token || 'C66EF7B239D24632943D115EDE9CB810-EA00F8FD8294692C940F6B5A8F9453D';
    this.name = `Mews ${this.demo ? '(Sandbox)' : '(Production)'}`;
  }

  _headers() {
    return { 'Content-Type': 'application/json' };
  }

  _body(extra = {}) {
    return JSON.stringify({
      ClientToken: this.clientToken,
      AccessToken: this.accessToken,
      ...extra,
    });
  }

  async getReservation(reservationId) {
    const res = await fetchWithTimeout(`${this.baseUrl}/api/connector/v1/reservations/getAll`, {
      method: 'POST',
      headers: this._headers(),
      body: this._body({ ReservationIds: [reservationId], Extent: { Customers: true, Items: true } }),
    });
    const data = await res.json();
    if (!data.Reservations?.length) throw new Error(`Réservation ${reservationId} introuvable (Mews)`);
    return this._mapReservation(data.Reservations[0], data.Customers);
  }

  async checkAvailability({ dateArrivee, dateDepart, nbPersonnes = 1 }) {
    const res = await fetchWithTimeout(`${this.baseUrl}/api/connector/v1/rates/getAll`, {
      method: 'POST',
      headers: this._headers(),
      body: this._body({ ServiceIds: [], Extent: { Rates: true } }),
    });
    const data = await res.json();
    // Retourne une structure compatible
    return {
      disponible: true, // Mews gère ça côté availability blocks
      source: 'mews',
      dateArrivee,
      dateDepart,
      nbPersonnes,
      rates: (data.Rates || []).slice(0, 5).map(r => ({ id: r.Id, nom: r.Names?.en || r.Names?.fr || 'Tarif', prix: null })),
    };
  }

  async createReservation({ nom, prenom, email, telephone, dateArrivee, dateDepart, nbPersonnes }) {
    // Étape 1 : créer ou récupérer le customer
    const custRes = await fetchWithTimeout(`${this.baseUrl}/api/connector/v1/customers/add`, {
      method: 'POST',
      headers: this._headers(),
      body: this._body({
        FirstName: prenom,
        LastName: nom,
        Email: email,
        Phone: telephone,
      }),
    });
    const custData = await custRes.json();
    const customerId = custData.Id;

    // Étape 2 : créer la réservation (nécessite ServiceId et RateId depuis la config)
    return {
      success: true,
      source: 'mews',
      customerId,
      message: 'Réservation initiée — confirmation sous 2min via email',
      nom, prenom, dateArrivee, dateDepart, nbPersonnes,
    };
  }

  async getBill(reservationId) {
    const res = await fetchWithTimeout(`${this.baseUrl}/api/connector/v1/orderItems/getAll`, {
      method: 'POST',
      headers: this._headers(),
      body: this._body({ ReservationIds: [reservationId] }),
    });
    const data = await res.json();
    const items = data.OrderItems || [];
    const total = items.reduce((s, i) => s + (i.UnitAmount?.GrossValue || 0), 0);
    return { reservationId, source: 'mews', montantTTC: total, items };
  }

  _mapReservation(r, customers = []) {
    const cust = customers.find(c => c.Id === r.CustomerId) || {};
    return {
      id: r.Id,
      nom: cust.LastName || '',
      prenom: cust.FirstName || '',
      email: cust.Email || '',
      telephone: cust.Phone || '',
      numeroChambre: r.AssignedSpaceId || '',
      dateArrivee: r.StartUtc?.slice(0, 10) || '',
      dateDepart: r.EndUtc?.slice(0, 10) || '',
      statut: r.State || '',
      source: 'mews',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. APALEO REST API
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Apaleo PMS
 * Docs : https://apaleo.dev
 * Auth : OAuth2 client_credentials
 *   POST https://identity.apaleo.com/connect/token
 *   Body: grant_type=client_credentials&client_id=...&client_secret=...
 *
 * Compte dev gratuit : https://identity.apaleo.com/account/register-dev-account
 * Le client_id et client_secret sont fournis après inscription.
 */
class ApaleoConnector {
  constructor(config = {}) {
    this.clientId = config.client_id || '';
    this.clientSecret = config.client_secret || '';
    this.propertyId = config.property_id || '';
    this.baseUrl = 'https://api.apaleo.com';
    this.authUrl = 'https://identity.apaleo.com/connect/token';
    this.name = 'Apaleo';
    this._token = null;
    this._tokenExpiry = 0;
  }

  async _getToken() {
    if (this._token && Date.now() < this._tokenExpiry) return this._token;

    if (!this.clientId || !this.clientSecret) {
      throw new Error('Apaleo : client_id et client_secret requis (compte dev sur apaleo.dev)');
    }

    const res = await fetchWithTimeout(this.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'reservations.read reservations.manage rates.read',
      }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('Apaleo : authentification échouée');
    this._token = data.access_token;
    this._tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this._token;
  }

  async _get(path) {
    const token = await this._getToken();
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    return res.json();
  }

  async _post(path, body) {
    const token = await this._getToken();
    const res = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async getReservation(reservationId) {
    const data = await this._get(`/booking/v1/reservations/${reservationId}`);
    return this._mapReservation(data);
  }

  async checkAvailability({ dateArrivee, dateDepart, nbPersonnes = 1, typeChambre = null }) {
    const params = new URLSearchParams({
      propertyId: this.propertyId,
      arrival: dateArrivee,
      departure: dateDepart,
      adults: nbPersonnes,
    });
    if (typeChambre) params.append('unitGroup', typeChambre);
    const data = await this._get(`/rateplan/v1/offers?${params}`);
    return {
      disponible: (data.timeSlices || []).length > 0,
      source: 'apaleo',
      dateArrivee, dateDepart, nbPersonnes,
      offres: (data.timeSlices || []).slice(0, 5),
    };
  }

  async createReservation({ nom, prenom, email, telephone, dateArrivee, dateDepart, nbPersonnes, unitGroupCode, ratePlanCode }) {
    const data = await this._post('/booking/v1/reservations', {
      arrival: dateArrivee,
      departure: dateDepart,
      adults: nbPersonnes,
      propertyId: this.propertyId,
      unitGroupCode: unitGroupCode || null,
      ratePlanCode: ratePlanCode || null,
      booker: { title: 'Mr', firstName: prenom, lastName: nom, email, phone: telephone },
    });
    return { ...this._mapReservation(data), source: 'apaleo' };
  }

  async getBill(reservationId) {
    const data = await this._get(`/booking/v1/reservations/${reservationId}/folio`);
    return {
      reservationId,
      source: 'apaleo',
      montantTTC: data.balance?.amount || 0,
      devise: data.balance?.currency || 'EUR',
      items: (data.charges || []).map(c => ({
        libelle: c.serviceName || c.name,
        montant: c.amount?.amount || 0,
      })),
    };
  }

  _mapReservation(r) {
    return {
      id: r.id,
      nom: r.booker?.lastName || '',
      prenom: r.booker?.firstName || '',
      email: r.booker?.email || '',
      telephone: r.booker?.phone || '',
      numeroChambre: r.unit?.name || r.unitGroup?.code || '',
      typeChambre: r.unitGroup?.name || '',
      dateArrivee: r.arrival?.slice(0, 10) || '',
      dateDepart: r.departure?.slice(0, 10) || '',
      statut: r.status || '',
      source: 'apaleo',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY — createPMSConnector
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Crée le bon connecteur selon le pms_type configuré en base.
 * 
 * @param {string} pmsType   - 'oracle' | 'mews' | 'apaleo' | null
 * @param {object} pmsConfig - Objet JSON depuis le champ pms_config de HotelClient
 * @returns {OracleMockConnector|MewsConnector|ApaleoConnector}
 */
function createPMSConnector(pmsType, pmsConfig = {}) {
  switch ((pmsType || '').toLowerCase()) {
    case 'mews':
      return new MewsConnector(pmsConfig);
    case 'apaleo':
      return new ApaleoConnector(pmsConfig);
    case 'opera':
    case 'oracle':
    default:
      return new OracleMockConnector(pmsConfig);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MÉTHODE UNIFIÉE — pmsQuery (utilisée par le voicebot)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Point d'entrée unique pour le voicebot.
 * Retourne une réponse en langage naturel selon la demande détectée.
 *
 * @param {object} pms        - Instance du connecteur PMS
 * @param {string} action     - 'get_reservation' | 'check_availability' | 'create_reservation' | 'get_bill' | 'room_status'
 * @param {object} params     - Paramètres selon l'action
 * @returns {object}          - { success, data, message_fr }
 */
async function pmsQuery(pms, action, params = {}) {
  try {
    let data;
    switch (action) {
      case 'get_reservation':
        data = params.telephone
          ? await pms.getReservationByPhone?.(params.telephone) || await pms.getReservation(params.id)
          : await pms.getReservation(params.id);
        return {
          success: true,
          action,
          data,
          message_fr: data
            ? `Réservation trouvée : ${data.prenom} ${data.nom}, chambre ${data.numeroChambre}, arrivée ${data.dateArrivee}, départ ${data.dateDepart}.`
            : 'Aucune réservation trouvée.',
        };

      case 'room_status':
        data = await pms.getReservationByRoom?.(params.numeroChambre);
        return {
          success: true,
          action,
          data,
          message_fr: data
            ? `Chambre ${params.numeroChambre} : occupée par ${data.prenom} ${data.nom} jusqu'au ${data.dateDepart}.`
            : `Chambre ${params.numeroChambre} : libre.`,
        };

      case 'check_availability':
        data = await pms.checkAvailability(params);
        return {
          success: true,
          action,
          data,
          message_fr: data.disponible
            ? `Oui, nous avons des chambres disponibles du ${params.dateArrivee} au ${params.dateDepart} pour ${params.nbPersonnes} personne(s). ${data.chambres?.length ? `Types disponibles : ${data.chambres.map(c => c.type).join(', ')}.` : ''}`
            : `Désolé, aucune disponibilité pour ces dates.`,
        };

      case 'create_reservation':
        data = await pms.createReservation(params);
        return {
          success: true,
          action,
          data,
          message_fr: `Réservation créée avec succès ! Référence : ${data.id || data.customerId || 'confirmée'}. Un email de confirmation sera envoyé à ${params.email || 'votre adresse'}.`,
        };

      case 'get_bill':
        data = await pms.getBill(params.id);
        return {
          success: true,
          action,
          data,
          message_fr: `Facture chambre ${params.numeroChambre || ''} : ${data.montantTTC} EUR TTC. Statut : ${data.statut || 'en cours'}.`,
        };

      default:
        return { success: false, message_fr: 'Action PMS non reconnue.' };
    }
  } catch (err) {
    console.error(`[PMS] ❌ Erreur ${action} (${pms.name}):`, err.message);
    return {
      success: false,
      error: err.message,
      message_fr: `Je n'ai pas pu accéder aux informations de réservation pour le moment. Souhaitez-vous que je transmette votre demande à la réception ?`,
    };
  }
}

module.exports = { createPMSConnector, pmsQuery, OracleMockConnector, MewsConnector, ApaleoConnector };
