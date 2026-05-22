#!/bin/bash
set -e

echo "=== DÉBUT PATCH RUNTIME ==="

# 1. Supprimer header OpenAI-Beta (toutes variantes)
sed -i "s/'OpenAI-Beta': 'realtime=v1',//g" /app/server.js
sed -i "s/, 'OpenAI-Beta': 'realtime=v1'//g" /app/server.js
sed -i 's/"OpenAI-Beta": "realtime=v1",//g' /app/server.js

# 2. Forcer modèle stable
sed -i "s/gpt-4o-realtime-preview/gpt-realtime/g" /app/server.js
sed -i "s/gpt-realtime-2/gpt-realtime/g" /app/server.js
sed -i "s/gpt-realtime-1\.5/gpt-realtime/g" /app/server.js

# 3. Migration GA API : réécriture du session.update via Python
python3 - << 'PYEOF'
import re

with open('/app/server.js', 'r') as f:
    content = f.read()

# Pattern pour trouver le bloc session.update complet
# On remplace tout le JSON envoyé à OAI lors du open
old_patterns = [
    # Pattern avec modalities (ancienne Beta)
    r"oai\.send\(JSON\.stringify\(\{[^}]*type:\s*'session\.update'[^}]*session:\s*\{[^}]*modalities[^}]*\}[^}]*\}\)\);",
    # Pattern avec session.type déjà ajouté
    r"oai\.send\(JSON\.stringify\(\{[^}]*type:\s*'session\.update'[^}]*session:\s*\{[^}]*type:\s*'realtime'[^}]*\}[^}]*\}\)\);"
]

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

# Chercher et remplacer avec regex DOTALL
pattern = r"oai\.send\(JSON\.stringify\(\{\s*type:\s*['\"]session\.update['\"],\s*session:\s*\{.*?\}\s*\}\)\);"
match = re.search(pattern, content, re.DOTALL)
if match:
    print(f"✅ Bloc session.update trouvé (chars {match.start()}-{match.end()})")
    content = content[:match.start()] + new_block + content[match.end():]
    print("✅ Bloc remplacé avec syntaxe GA")
else:
    print("❌ Bloc session.update non trouvé par regex")
    # Afficher ce qu'on a autour de session.update
    idx = content.find("session.update")
    if idx > 0:
        print("Contexte:", repr(content[idx-50:idx+300]))

# Corriger response.audio.delta → response.output_audio.delta  
content = content.replace("'response.audio.delta'", "'response.output_audio.delta'")
content = content.replace('"response.audio.delta"', '"response.output_audio.delta"')
print("✅ Événements audio corrigés")

with open('/app/server.js', 'w') as f:
    f.write(content)
    
print("✅ server.js sauvegardé")
PYEOF

echo "=== VÉRIFICATIONS ==="
echo "Modèle:"
grep -n "gpt-realtime\|realtime-preview" /app/server.js | head -5
echo "Header Beta:"
grep -n "OpenAI-Beta" /app/server.js && echo "⚠️ HEADER PRÉSENT" || echo "✅ HEADER ABSENT"
echo "session.update:"
grep -n -A5 "session.update" /app/server.js | head -20

echo "=== DÉMARRAGE NODE ==="
node /app/server.js
