FROM node:22-slim AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
ARG OMP_BUILD_COMMIT=source
RUN npm run build

FROM python:3.13-slim AS http_inspection
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev cmake make && rm -rf /var/lib/apt/lists/*
COPY third_party/libinjection /src
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /build --parallel 2 \
    && cmake --install /build --prefix /out

FROM python:3.13-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 poppler-utils && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./server/
COPY --from=web /build/web/dist/ ./web/dist/
COPY --from=http_inspection /out/libomp_injection.so /usr/local/lib/libomp_injection.so
COPY --from=http_inspection /out/libinjection-LICENSE.txt /usr/local/share/licenses/libinjection/COPYING
ENV OMP_DATA=/data PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1
EXPOSE 8000
CMD ["uvicorn","server.main:app","--host","0.0.0.0","--port","8000","--no-proxy-headers","--no-access-log","--ws","websockets-sansio","--ws-max-size","2048","--ws-max-queue","4"]
