#!/bin/bash
# Patch runtime : suppression header OpenAI-Beta + modèle stable + session.type
sed -i "s/'OpenAI-Beta': 'realtime=v1',//g" /app/server.js
sed -i "s/, 'OpenAI-Beta': 'realtime=v1'//g" /app/server.js
sed -i "s/gpt-4o-realtime-preview/gpt-realtime/g" /app/server.js
sed -i "s/gpt-realtime-2/gpt-realtime/g" /app/server.js

# Ajouter session.type: 'realtime' dans le session.update (requis par GA API)
# On cherche "modalities: ['text', 'audio']," et on ajoute "type: 'realtime'," avant
sed -i "s/modalities: \['text', 'audio'\],/type: 'realtime', modalities: ['text', 'audio'],/" /app/server.js

echo "=== PATCH APPLIQUÉ ==="
grep -n "gpt-realtime" /app/server.js | head -3
grep -n "OpenAI-Beta" /app/server.js && echo "⚠️ HEADER ENCORE PRÉSENT" || echo "✅ HEADER SUPPRIMÉ"
grep -n "session.type\|type: 'realtime'" /app/server.js | head -3
node /app/server.js
