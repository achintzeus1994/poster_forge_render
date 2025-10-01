FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates fontconfig zip unzip nodejs npm \
 && rm -rf /var/lib/apt/lists/*

# Install tectonic (LaTeX engine)
RUN curl -L https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40latest/tectonic-x86_64-unknown-linux-gnu.tar.gz \
 | tar xz -C /usr/local/bin --strip-components=1 tectonic

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

CMD ["node","worker.js"]
