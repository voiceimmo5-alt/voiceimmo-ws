#!/bin/bash
# Patch runtime : supprimer header OpenAI-Beta + forcer alias stable gpt-realtime
sed -i "s/'OpenAI-Beta': 'realtime=v1',//g" /app/server.js
sed -i "s/, 'OpenAI-Beta': 'realtime=v1'//g" /app/server.js
sed -i "s/gpt-4o-realtime-preview/gpt-realtime/g" /app/server.js
sed -i "s/gpt-realtime-2/gpt-realtime/g" /app/server.js
echo "=== PATCH APPLIQUÉ ==="
grep -n "gpt-realtime" /app/server.js | head -5
grep -n "OpenAI-Beta" /app/server.js && echo "HEADER ENCORE PRÉSENT" || echo "HEADER SUPPRIMÉ OK"
node /app/server.js
