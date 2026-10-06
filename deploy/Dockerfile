FROM node:20-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3210

VOLUME ["/app/data"]

ENV PORT=3210
ENV HOST=0.0.0.0
ENV DAYMATE_DATA_DIR=/app/data

CMD ["node", "server.js"]
