# The source matching this image is pinned in the openconstructionerp submodule.
# Using the published frontend avoids a roughly 14 GB source-build requirement.
FROM ghcr.io/datadrivenconstruction/openconstructionerp:18.6.4@sha256:7f0f995c7948d887b4cb396d4b1d4a3db799cc9df72e01b81ff83052b61865ce

LABEL org.opencontainers.image.source="https://github.com/tromsobyggtre-beep/norwegian-construction-ai-agent" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      com.tromsobyggtre.erp.source="https://github.com/datadrivenconstruction/OpenConstructionERP" \
      com.tromsobyggtre.erp.revision="a7adbbe01bacac0b44168a279a8a2f286551dd02"

COPY --chown=oe:oe scripts/bootstrap_admin.py /opt/deployment/bootstrap_admin.py
COPY NOTICE /opt/deployment/NOTICE

ENV APP_ENV=production \
    APP_DEBUG=false \
    SERVE_FRONTEND=true \
    SEED_DEMO=false \
    OE_REGISTRATION_MODE=closed \
    ALLOW_RUNTIME_UPGRADE=false \
    OE_DOWNLOAD_EMBEDDING_MODEL=0 \
    OE_DATA_DIR=/data \
    VECTOR_BACKEND=lancedb \
    VECTOR_DATA_DIR=/data/vectors \
    REDIS_URL="" \
    ALLOWED_ORIGINS=""

# Northflank uses the explicit group to make mounted storage writable.
USER oe:oe

EXPOSE 8080
