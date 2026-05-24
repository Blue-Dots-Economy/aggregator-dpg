<#macro registrationLayout displayInfo=false displayMessage=true displayRequiredFields=false showAnotherWayIfPresent=true bodyClass="">
    <#-- Loop variable `section` is bound by the caller's `<@layout.registrationLayout; section>` syntax. -->
<!DOCTYPE html>
<html lang="${locale.currentLanguageTag!'en'}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="robots" content="noindex,nofollow">
    <title>${msg("loginTitle",(realm.displayName!''))}</title>

    <link rel="icon" type="image/svg+xml" href="${url.resourcesPath}/img/favicon.svg">

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap">
    <link rel="stylesheet" href="${url.resourcesPath}/css/blue-dots.css">
    <#-- Palette overrides come after the static CSS so per-network env
         vars win over the file's :root defaults. Static file stays
         network-agnostic; this block carries the colour swap. -->
    <style>
      :root {
        --bd-primary:     ${properties.brandPrimary!'#4f46e5'};
        --bd-primary-600: ${properties.brandPrimaryDark!'#4338ca'};
        --bd-primary-500: ${properties.brandPrimary500!'#6366f1'};
        --bd-primary-100: ${properties.brandPrimary100!'#e0e7ff'};
        --bd-primary-50:  ${properties.brandPrimary50!'#eef2ff'};
        --bd-hero-bg:     ${properties.brandHeroBg!'#0f172a'};
        --bd-hero-grad:   ${properties.brandHeroGrad!'#7dd3fc'};
      }
      .bd-hero { background: var(--bd-hero-bg) !important; }
      .bd-hero-glow {
        background:
          radial-gradient(700px 500px at 75% 25%, var(--bd-primary-500) 0%, transparent 60%),
          radial-gradient(600px 480px at 15% 85%, var(--bd-primary) 0%, transparent 60%) !important;
        opacity: 0.22;
      }
      .bd-hero-grad {
        background: none !important;
        background-clip: initial !important;
        -webkit-background-clip: initial !important;
        color: var(--bd-hero-grad) !important;
      }
    </style>

    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
</head>
<body class="bd-body">
    <div class="bd-shell">
        <aside class="bd-hero" aria-hidden="true">
            <canvas id="bd-hero-canvas" class="bd-hero-canvas"></canvas>
            <div class="bd-hero-glow"></div>
            <div class="bd-hero-copy">
                <h1 class="bd-hero-title">
                    ${properties.heroTitleLead!'Welcome to'} <span class="bd-hero-grad">${properties.heroTitleHighlight!'the Aggregator'}</span><br>
                    ${properties.heroTitleTail!'portal.'}
                </h1>
                <p class="bd-hero-sub">
                    ${properties.heroSubtitle!'Sign in to manage participants, registrations, and onboarding for your network.'}
                </p>
            </div>
        </aside>

        <main class="bd-pane">
            <div class="bd-card">
                <header class="bd-brand">
                    <#-- Logo dots + lines pull from the active palette so a
                         purple_dot deployment doesn't leak indigo into the
                         brand mark. `currentColor` lets us drive every stop
                         from a single `color` value set on the wrapper. -->
                    <svg class="bd-logo-svg" width="56" height="56" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="color: ${properties.brandPrimary!'#2563EB'};">
                        <rect x="0.6" y="0.6" width="46.8" height="46.8" rx="13" fill="${properties.brandPrimary50!'#EFF4FF'}" stroke="currentColor" stroke-opacity="0.10" stroke-width="1"/>
                        <g stroke="currentColor" stroke-opacity="0.30" stroke-width="0.9" stroke-linecap="round">
                            <line x1="24" y1="24" x2="8" y2="12"/>
                            <line x1="24" y1="24" x2="40" y2="10"/>
                            <line x1="24" y1="24" x2="42" y2="26"/>
                            <line x1="24" y1="24" x2="34" y2="40"/>
                            <line x1="24" y1="24" x2="14" y2="38"/>
                            <line x1="24" y1="24" x2="6" y2="26"/>
                            <line x1="8" y1="12" x2="6" y2="26"/>
                            <line x1="42" y1="26" x2="34" y2="40"/>
                            <line x1="40" y1="10" x2="42" y2="26"/>
                        </g>
                        <circle cx="8" cy="12" r="2.6" fill="currentColor"/>
                        <circle cx="40" cy="10" r="2.0" fill="currentColor"/>
                        <circle cx="42" cy="26" r="3.2" fill="currentColor"/>
                        <circle cx="34" cy="40" r="2.4" fill="currentColor"/>
                        <circle cx="14" cy="38" r="2.8" fill="currentColor"/>
                        <circle cx="6" cy="26" r="2.0" fill="currentColor"/>
                        <circle cx="24" cy="24" r="9.4" fill="currentColor" fill-opacity="0.35" opacity="0.55"/>
                        <circle cx="24" cy="24" r="5.4" fill="${properties.brandPrimaryDark!'#1D4ED8'}"/>
                        <circle cx="22.6" cy="22.6" r="1.2" fill="rgba(255,255,255,0.7)"/>
                    </svg>
                    <div class="bd-brand-text">
                        <strong>${properties.brandShortName!'Aggregator'}</strong>
                        <span>${properties.brandLongName!'Aggregator Portal'}</span>
                    </div>
                </header>

                <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                    <div class="bd-alert bd-alert-${message.type}">
                        <#if message.type = 'success'><span aria-hidden="true">✓</span></#if>
                        <#if message.type = 'warning'><span aria-hidden="true">!</span></#if>
                        <#if message.type = 'error'><span aria-hidden="true">×</span></#if>
                        <#if message.type = 'info'><span aria-hidden="true">i</span></#if>
                        <span>${kcSanitize(message.summary)?no_esc}</span>
                    </div>
                </#if>

                <a href="javascript:history.back()" class="bd-back" aria-label="Back">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <line x1="19" y1="12" x2="5" y2="12"></line>
                        <polyline points="12 19 5 12 12 5"></polyline>
                    </svg>
                    Back
                </a>

                <h2 class="bd-title"><#nested "header"></h2>
                <p class="bd-subtitle">${msg("loginAccountSubtitle")}</p>

                <div class="bd-form-area">
                    <#nested "form">
                </div>

                <#if displayInfo>
                    <div class="bd-info">
                        <#nested "info">
                    </div>
                </#if>

                <#if auth?has_content && auth.showTryAnotherWayLink() && showAnotherWayIfPresent>
                    <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" class="bd-try-another">
                        <input type="hidden" name="tryAnotherWay" value="on"/>
                        <button type="submit" class="bd-link-btn">${msg("doTryAnotherWay")}</button>
                    </form>
                </#if>

                <p class="bd-terms">
                    By continuing you agree to the
                    <a href="#" class="bd-link">Privacy Policy</a> and
                    <a href="#" class="bd-link">Terms</a>.
                </p>

                <footer class="bd-foot">
                    <span class="bd-pill">
                        <span class="bd-pill-dot" aria-hidden="true"></span>
                        Invite-only · ${properties.brandShortName!'Aggregator'} ${properties.brandSsoLabel!'SSO'}
                    </span>
                    <a href="#" class="bd-link bd-link-strong">Need help?</a>
                </footer>
            </div>

            <span class="bd-version" aria-hidden="true">v2.4.0 · build 7281</span>
        </main>
    </div>
    <script src="${url.resourcesPath}/js/blue-dots.js" defer></script>
</body>
</html>
</#macro>
