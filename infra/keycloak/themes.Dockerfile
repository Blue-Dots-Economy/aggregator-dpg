# Init-container image that ships the Keycloak `otp` theme plus per-
# network brand values baked into `theme.properties` and `template.ftl`.
#
# Pattern: at pod start, this image runs as an initContainer, copies
# `/custom` into a shared emptyDir, then exits. The main Keycloak
# container mounts the same emptyDir at `/opt/keycloak/themes`, so the
# Keycloak image stays vanilla while every per-deployment string is
# frozen into the theme image hash.
#
# Build (one image per network):
#   docker build -f infra/keycloak/themes.Dockerfile \
#     --build-arg NETWORK=purple_dot \
#     --build-arg BRAND_SHORT_NAME='Purple Dots' \
#     --build-arg BRAND_LONG_NAME='Purple Dot Aggregator Portal' \
#     --build-arg BRAND_PRIMARY_COLOR='#A855F7' \
#     --build-arg BRAND_PRIMARY_DARK='#7C3AED' \
#     --build-arg BRAND_PRIMARY_500='#A855F7' \
#     --build-arg BRAND_PRIMARY_100='#EDE9FE' \
#     --build-arg BRAND_PRIMARY_50='#F5F3FF' \
#     --build-arg BRAND_HERO_BG='#1E1B4B' \
#     --build-arg BRAND_HERO_GRAD='#C4B5FD' \
#     --build-arg HERO_TITLE_LEAD='Welcome to' \
#     --build-arg HERO_TITLE_HIGHLIGHT='Purple Dots' \
#     --build-arg HERO_TITLE_TAIL='discovery & services for people with disabilities.' \
#     --build-arg HERO_SUBTITLE='Sign in to manage beneficiaries, service providers, and onboarding across the network.' \
#     -t registry.your.co/aggregator-kc-theme:purple-v1 .
#
# Or simpler — pass `--build-arg-file config/<network>/keycloak.env`.

FROM busybox:1.38

ARG NETWORK=blue_dot
ARG BRAND_SHORT_NAME=Aggregator
ARG BRAND_LONG_NAME=Aggregator Portal
ARG BRAND_SSO_LABEL=SSO
# Names the app on the login page. The realm is shared with signals, whose
# `signals` child theme sets its own — without this the two are indistinguishable.
ARG BRAND_APP_LABEL=Aggregator Portal
ARG BRAND_PRIMARY_COLOR=#4f46e5
ARG BRAND_PRIMARY_DARK=#4338ca
ARG BRAND_PRIMARY_500=#6366f1
ARG BRAND_PRIMARY_100=#e0e7ff
ARG BRAND_PRIMARY_50=#eef2ff
ARG BRAND_HERO_BG=#0f172a
ARG BRAND_HERO_GRAD=#7dd3fc
ARG HERO_TITLE_LEAD=Welcome to
ARG HERO_TITLE_HIGHLIGHT=the Aggregator
ARG HERO_TITLE_TAIL=portal.
ARG HERO_SUBTITLE=Sign in to manage participants, registrations, and onboarding for your network.
# brand.json-driven values (PR #355). Slug + font stack get baked
# into theme.properties so the runtime never falls back to default.
ARG BRAND_LOGO_SLUG=purple-dot
ARG BRAND_FONT_SANS=Inter, system-ui, sans-serif
ARG BRAND_FONT_HEADING=Plus Jakarta Sans, system-ui, sans-serif
ARG BRAND_FONT_BODY=Inter, system-ui, sans-serif

# Theme source — read from the repo's checked-in theme tree.
COPY infra/keycloak/themes /custom

# Overwrite theme.properties so brand vars are baked literals, not
# `${env.VAR:default}` placeholders. Removes the runtime env dependence
# the compose stack uses; the image hash now uniquely identifies the
# brand.
RUN { \
      printf 'parent=keycloak.v2\n'; \
      printf 'brandShortName=%s\n'      "${BRAND_SHORT_NAME}"; \
      printf 'brandLongName=%s\n'       "${BRAND_LONG_NAME}"; \
      printf 'brandSsoLabel=%s\n'       "${BRAND_SSO_LABEL}"; \
      printf 'brandAppLabel=%s\n'       "${BRAND_APP_LABEL}"; \
      printf 'brandLogoSlug=%s\n'       "${BRAND_LOGO_SLUG}"; \
      printf 'brandFontSans=%s\n'       "${BRAND_FONT_SANS}"; \
      printf 'brandFontHeading=%s\n'    "${BRAND_FONT_HEADING}"; \
      printf 'brandFontBody=%s\n'       "${BRAND_FONT_BODY}"; \
      printf 'heroTitleLead=%s\n'       "${HERO_TITLE_LEAD}"; \
      printf 'heroTitleHighlight=%s\n'  "${HERO_TITLE_HIGHLIGHT}"; \
      printf 'heroTitleTail=%s\n'       "${HERO_TITLE_TAIL}"; \
      printf 'heroSubtitle=%s\n'        "${HERO_SUBTITLE}"; \
      printf 'brandPrimary=%s\n'        "${BRAND_PRIMARY_COLOR}"; \
      printf 'brandPrimaryDark=%s\n'    "${BRAND_PRIMARY_DARK}"; \
      printf 'brandPrimary500=%s\n'     "${BRAND_PRIMARY_500}"; \
      printf 'brandPrimary100=%s\n'     "${BRAND_PRIMARY_100}"; \
      printf 'brandPrimary50=%s\n'      "${BRAND_PRIMARY_50}"; \
      printf 'brandHeroBg=%s\n'         "${BRAND_HERO_BG}"; \
      printf 'brandHeroGrad=%s\n'       "${BRAND_HERO_GRAD}"; \
    } > /custom/otp/login/theme.properties

# Only `otp` is re-baked. The `signals` child theme's properties keep their
# `${env.SIGNALS_*:default}` form, with the checked-in defaults being signals'
# real values — signals branding does not vary per network today, so there is
# nothing per-image to freeze. Add a second printf block here if that changes.

# Init-container entrypoint: copy the themes into the shared volume the main
# Keycloak container mounts at /opt/keycloak/themes, then exit. Using
# `cp -aT` so symlinks (e.g. ../themes/...) and timestamps survive.
#
# Stages the WHOLE tree, not just `otp`: `signals` (which the signals-ui client
# selects via its `login_theme` attribute) sits alongside it, and copying only
# `otp` would leave that override pointing at a theme absent from disk. Both are
# listed so a missing one fails the init container loudly instead of silently
# falling back to the realm default.
CMD ["sh", "-c", "set -e; mkdir -p /shared; cp -aT /custom /shared && ls /shared/otp/login /shared/signals/login >/dev/null && echo 'themes staged at /shared: otp, signals'"]
