#!/bin/bash
# Patch runtime : supprimer header OpenAI-Beta du server.js
sed -i "s/'OpenAI-Beta': 'realtime=v1',//g" /app/server.js
sed -i "s/, 'OpenAI-Beta': 'realtime=v1'//g" /app/server.js
echo "=== PATCH APPLIQUÉ ==="
grep -n "OpenAI-Beta" /app/server.js && echo "HEADER ENCORE PRÉSENT" || echo "HEADER SUPPRIMÉ OK"
node /app/server.js
