# Lumo API — image Docker (déploiement Render / tout hôte Docker)
#
# Le service Render est un process long-running : on utilise server.js
# (mode local) qui gère les sessions persistantes, la rotation automatique
# de quota et le stream SSE. Aucune dépendance npm : Node >= 18 suffit
# (fetch + WebCrypto natifs).
#
#   docker build -t lumo-api .
#   docker run -p 3000:3000 lumo-api
#
# Render : pointer le service sur le Dockerfile du repo (PORT est injecté
# automatiquement par Render ; défaut 3000).

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# Pas de node_modules à installer — tout est stdlib Node.
COPY package.json ./
COPY server.js ./
COPY lib ./lib

# uid/gid node (non-root) présent dans l'image alpine node
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
