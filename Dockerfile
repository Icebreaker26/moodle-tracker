# Sin dependencias que instalar (ver package.json): la imagen solo necesita Node.
FROM node:20-alpine

WORKDIR /app
COPY . .

# data/ se monta como volumen en tiempo de ejecución (ver docker-compose.yml).
# Nunca se copia del host a la imagen: es donde vive tu token de Moodle.
VOLUME ["/app/data"]

# Dentro del contenedor, 127.0.0.1 es un loopback que Docker no puede exponer:
# el límite real de "solo tu máquina" lo pone docker-compose.yml (127.0.0.1:4173:4173
# en el host), no este bind. Fuera de Docker, server.js sigue sin tocar esto y usa 127.0.0.1.
ENV HOST=0.0.0.0
EXPOSE 4173

# Por defecto levanta el panel. Los demás comandos (login, sync, submit...)
# se corren aparte contra el mismo volumen, ver README.md#docker-opcional.
CMD ["node", "src/cli.js", "serve"]
