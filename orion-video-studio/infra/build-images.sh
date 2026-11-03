#!/bin/sh
# Constrói as imagens orion-api, orion-worker e orion-web (mesmo Dockerfile, alvos diferentes).
# Uso: sh infra/build-images.sh
# Rede com inspeção TLS (proxy corporativo): EXTRA_CA_CERT=/caminho/ca.crt sh infra/build-images.sh
# O certificado entra apenas como segredo de build (não fica gravado na imagem).
set -eu
cd "$(dirname "$0")/.."
SECRET=""
if [ -n "${EXTRA_CA_CERT:-}" ]; then
  SECRET="--secret id=extra_ca,src=${EXTRA_CA_CERT}"
fi
for target in api worker web; do
  echo "==> orion-${target}:local"
  # shellcheck disable=SC2086
  docker build -f infra/docker/Dockerfile --target "$target" $SECRET -t "orion-${target}:local" .
done
