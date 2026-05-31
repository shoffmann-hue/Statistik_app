FROM node:20-alpine

WORKDIR /app

# Dependencies installieren
COPY package.json .
RUN npm install --production

# App-Dateien kopieren
COPY server.js .
COPY frontend/ ./frontend/

# Data-Ordner für die Datenbank
RUN mkdir -p /app/data

# Port freigeben
EXPOSE 3000

# Persistenter Volume-Pfad für die Datenbank
VOLUME ["/app/data"]

CMD ["node", "server.js"]
