<#import "template.ftl" as layout>
<#--
  Overrides keycloak.v2's error page to give the visitor a way out.

  Two cases need it. The portal entitlement gate (infra/keycloak/init/apply-portal-gate.py)
  denies on the auth-cookie path too, so someone signed in to the other DPG in
  the same browser is refused here without a token ever being issued. And a
  second sign-in in the same browser while another account is signed in is
  refused with "already authenticated as different user". In both cases the
  realm session is what is replayed, so only signing out lets the visitor name
  a different account.

  The sign-out button goes to the app's own account-switch route when the theme
  names one (`switchAccountPath`). That route ends the app's session as well as
  the realm session and returns to the app's sign-in page. Ending only the realm
  session leaves the app session alive, and the app's sign-in page then sends
  the visitor back to the old account.

  The portal's address is read from the client's registered post-logout
  redirect URIs: the last one ending in "/login". The realm registers the public
  portal URL last, after the local-development entries. This lookup only runs
  for a theme that names a switch route: the portal client has one public host,
  but a signals client can serve several, so its list does not say which host
  the visitor came from.

  Any other case uses Keycloak's own end-session endpoint with `client_id` only.
  No `post_logout_redirect_uri` is guessed, because a wrong one sends the
  visitor to another app, and an unregistered one fails with "Invalid redirect uri".

  The layout's Back arrow is hidden here: going back from this page reopens a
  form or logout confirmation that Keycloak has already used, which fails again
  with "Logout failed".
-->
<@layout.registrationLayout displayMessage=false showBack=false; section>
<!-- template: error.ftl -->

    <#if section="header">
        ${msg("errorTitle")}
    <#elseif section="form">
        <#assign appLogin = "">
        <#if (properties.switchAccountPath!'')?has_content && client?? && client.attributes?? && client.attributes["post.logout.redirect.uris"]??>
            <#list client.attributes["post.logout.redirect.uris"]?split("##") as uri>
                <#if uri?trim?ends_with("/login")>
                    <#assign appLogin = uri?trim>
                </#if>
            </#list>
        </#if>
        <#assign appBase = appLogin?keep_before_last("/login")>

        <#--
          `url.resourcesPath` is "<base>/resources/<ver>/login/<theme>", so
          trimming at "/resources/" yields the server's base path ("" or e.g.
          "/auth") without hardcoding either.
        -->
        <#assign kcBase = url.resourcesPath?keep_before("/resources/")>
        <#assign signOutUrl = kcBase + "/realms/" + realm.name?url('UTF-8') + "/protocol/openid-connect/logout">
        <#if appLogin?has_content>
            <#assign signOutUrl = appBase + properties.switchAccountPath>
        <#elseif client?? && client.clientId?has_content>
            <#assign signOutUrl = signOutUrl + "?client_id=" + client.clientId?url('UTF-8')>
        </#if>

        <div id="kc-error-message" class="bd-error">
            <div class="bd-alert bd-alert-warning" role="alert">
                <span aria-hidden="true">!</span>
                <span>${kcSanitize(message.summary)?no_esc}</span>
            </div>

            <a id="signOutAndSwitch"
               class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} bd-error-primary"
               href="${signOutUrl}">
                ${msg("doSignOutAndSwitch")}
            </a>
        </div>
    </#if>
</@layout.registrationLayout>
