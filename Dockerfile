FROM node:22-slim AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.13-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 poppler-utils && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./server/
COPY --from=web /build/web/dist/ ./web/dist/
ENV OMP_DATA=/data PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1
EXPOSE 8000
CMD ["uvicorn","server.main:app","--host","0.0.0.0","--port","8000","--no-proxy-headers","--no-access-log","--ws","websockets-sansio","--ws-max-size","2048","--ws-max-queue","4"]
