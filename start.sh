#!/bin/bash

echo "=== DÉBUT PATCH RUNTIME ==="

# 1. Supprimer header OpenAI-Beta (toutes variantes)
sed -i "s/'OpenAI-Beta': 'realtime=v1',//g" /app/server.js 2>/dev/null || true
sed -i "s/, 'OpenAI-Beta': 'realtime=v1'//g" /app/server.js 2>/dev/null || true
sed -i 's/"OpenAI-Beta": "realtime=v1",//g' /app/server.js 2>/dev/null || true

# 2. Forcer modèle stable
sed -i "s/gpt-4o-realtime-preview/gpt-realtime/g" /app/server.js 2>/dev/null || true
sed -i "s/gpt-realtime-2/gpt-realtime/g" /app/server.js 2>/dev/null || true

# 3. Migration GA API via Python (sans set -e, erreurs silencieuses)
python3 << 'PYEOF' || echo "⚠️ Patch Python échoué, on continue quand même"
import re

with open('/app/server.js', 'r') as f:
    content = f.read()

# Pattern pour trouver le bloc session.update complet (DOTALL)
pattern = r"(oai\.send\(JSON\.stringify\(\{)\s*(type:\s*['\"]session\.update['\"],)\s*(session:\s*\{.*?\})\s*(\}\)\);)"
match = re.search(pattern, content, re.DOTALL)

if match:
    print(f"✅ Bloc session.update trouvé")
    new_block = """oai.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions: buildPrompt(cfg || DEF_CFG, callerNum),
          voice: voix,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1', language: 'fr' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 },
          temperature: 0.7,
          max_response_output_tokens: 200,
        }
      }));"""
    content = content[:match.start()] + new_block + content[match.end():]
    print("✅ Bloc remplacé (format Beta simple, compatible GA)")
else:
    print("ℹ️ Bloc session.update non trouvé par regex - code déjà à jour ou format différent")
    # Afficher contexte autour de session.update
    idx = content.find("session.update")
    if idx > 0:
        print("Contexte:", content[idx-20:idx+400])

# Corriger événements audio
content = content.replace("'response.audio.delta'", "'response.output_audio.delta'")
content = content.replace('"response.audio.delta"', '"response.output_audio.delta"')

with open('/app/server.js', 'w') as f:
    f.write(content)

print("✅ server.js sauvegardé")
PYEOF

echo "=== VÉRIFICATIONS ==="
echo "Modèle OAI:"
grep "wss://api.openai.com" /app/server.js | head -3
echo "Version:"
grep "VoiceImmo WS" /app/server.js | head -2
echo "session.update:"
grep -A 12 "type: 'session.update'" /app/server.js | head -15

echo "=== DÉMARRAGE NODE ==="
exec node /app/server.js
