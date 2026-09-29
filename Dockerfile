FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY server.mjs ./
RUN ./node_modules/.bin/tsc -p tsconfig.json && mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV SEO_DATA_DIR=/data
ENV SEO_PROJECTS_FILE=/config/seo-projects.json
EXPOSE 4010
CMD ["node", "server.mjs"]
