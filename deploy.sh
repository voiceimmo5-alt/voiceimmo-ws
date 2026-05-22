#!/bin/bash
# ============================================
# Script de déploiement VoiceImmo
# Usage:
#   ./deploy.sh prod v32      → build et tag image prod v32
#   ./deploy.sh staging v32   → build et tag image staging v32
#   ./deploy.sh rollback prod v31  → revenir à v31
# ============================================

ENV=$1    # prod | staging
VERSION=$2

if [ -z "$ENV" ] || [ -z "$VERSION" ]; then
  echo "Usage: ./deploy.sh [prod|staging] [version]"
  exit 1
fi

IMAGE="voiceimmo-${ENV}"
DOCKERFILE="Dockerfile.${ENV}"

echo "🔨 Build ${IMAGE}:${VERSION}..."
docker build -f ${DOCKERFILE} -t ${IMAGE}:${VERSION} -t ${IMAGE}:latest .

if [ $? -ne 0 ]; then
  echo "❌ Build échoué"
  exit 1
fi

echo "🚀 Démarrage ${IMAGE}:${VERSION}..."
docker stop ${IMAGE} 2>/dev/null || true
docker rm ${IMAGE} 2>/dev/null || true

if [ "$ENV" = "prod" ]; then
  PORT=8080
  ENV_FILE=.env.prod
else
  PORT=8081
  ENV_FILE=.env.staging
fi

docker run -d \
  --name ${IMAGE} \
  --restart unless-stopped \
  --env-file ${ENV_FILE} \
  -p ${PORT}:${PORT} \
  --label version=${VERSION} \
  ${IMAGE}:${VERSION}

echo "✅ ${IMAGE}:${VERSION} démarré sur port ${PORT}"
echo "📋 Logs: docker logs -f ${IMAGE}"
