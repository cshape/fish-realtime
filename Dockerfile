# LiveKit Cloud hosted agent image (the /lk worker only — the web server
# deploys to Render from source, no Docker). Deploy with `lk agent deploy`.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# patches/ must be present before `npm ci`: the postinstall hook
# (patch-package) applies the livekit/agents-js#2033 fishaudio fix.
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --omit=dev

COPY personas.js lk-agent.js ./
COPY public/config.js ./public/config.js

CMD ["node", "lk-agent.js", "start"]
