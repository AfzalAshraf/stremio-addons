# Fast Combo — run anywhere with Docker:
#   docker build -t fast-combo .
#   docker run -d --name fastcombo --restart unless-stopped -p 7000:7000 -v fastcombo-data:/app/data fast-combo
#   docker logs fastcombo      → your control panel link + password (created on the first start)
# (the volume keeps your addon list, key and password when the container is updated)
FROM node:24-alpine
WORKDIR /app
COPY package.json fastcombo.js server.js ./
RUN mkdir -p /app/data && chown node:node /app/data
ENV PORT=7000 NODE_ENV=production
EXPOSE 7000
VOLUME /app/data
USER node
CMD ["node", "server.js"]
