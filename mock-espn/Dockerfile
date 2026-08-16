FROM node:22-alpine

WORKDIR /app
COPY server.js ./

# No dependencies on purpose: node's http module is enough, and a test fixture
# that needs an npm install is one more thing to break.
USER node
EXPOSE 3001
CMD ["node", "server.js"]
