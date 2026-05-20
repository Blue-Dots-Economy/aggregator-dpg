# Custom Keycloak image for aggregator-dpg.
#
# Bakes the OTP SPI provider jar into /opt/keycloak/providers and pre-runs
# `kc.sh build` so the SPI is indexed at image build time, not at every
# container start. The Helm chart references this image as
# ${imageRegistry}/aggregator-dpg/keycloak:<tag>.
#
# Build:
#   docker build -f infra/keycloak/Dockerfile -t aggregator-dpg/keycloak:26.5.5-aggregator infra/keycloak
#
# Notes:
#   * render-realm.sh is intentionally NOT copied in — in Kubernetes the
#     realm-renderer initContainer (see helm/.../charts/keycloak) handles
#     placeholder substitution into a shared emptyDir before the main
#     container starts.
#   * KC_DB=postgres is hard-coded so `kc.sh build` precompiles the postgres
#     persistence layer. Other DB backends would require a different build.

ARG KEYCLOAK_VERSION=26.5.5
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}

USER 0
COPY providers/ /opt/keycloak/providers/
RUN chmod -R a+r /opt/keycloak/providers

USER 1000
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_HTTP_RELATIVE_PATH=/auth

# Index the SPI providers + persistence layer at build time. The main pod
# can then start with `kc.sh start --optimized` (faster cold-boot).
RUN /opt/keycloak/bin/kc.sh build

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]
