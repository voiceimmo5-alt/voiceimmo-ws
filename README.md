# VoiceImmo WS Server

WebSocket server pour Twilio Media Streams + OpenAI Realtime.

## Variables d'environnement (Railway)
- `OPENAI_API_KEY` — clé OpenAI
- `NOTIFICATION_EMAIL` — email de fallback pour les leads

## Déploiement Railway
1. Pusher ce repo sur GitHub
2. Créer un projet Railway → Deploy from GitHub
3. Ajouter les variables d'environnement
4. Railway donne une URL publique → mettre dans voicebot (Base44)
