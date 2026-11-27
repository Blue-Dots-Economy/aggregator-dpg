<#import "template.ftl" as layout>
<#--
  Overrides keycloak.v2's error page so the visitor can sign out and use another
  account. Keycloak shows it when the portal gate refuses the signed-in account,
  or when a second account signs in while another is signed in.

  The button goes to the app's account-switch route (`switchAccountPath`), which
  ends the app session as well as the realm session. switch-account.js reads the
  app's origin from the refused sign-in in this page's URL, because a signals
  client serves several hosts. It uses the origin only if the client lists it
  as a post-logout URI, so a crafted URL cannot send the button elsewhere.
  Otherwise the button uses Keycloak's end-session endpoint with `client_id`
  only.

  A failed logout confirmation (the confirmation page went stale) carries no
  refused sign-in. The button then goes to the post-logout address the
  confirmation page was opened with, which switch-account.js keeps for the tab.
  Keycloak shows that failure once the realm session has ended or the
  confirmation was already used, so there is nothing left to sign out.

  The Back arrow is hidden: going back reopens a form Keycloak has already used.
-->
<@layout.registrationLayout displayMessage=false showBack=false; section>
<!-- template: error.ftl -->

    <#if section="header">
        ${msg("errorTitle")}
    <#elseif section="form">
        <#assign appOrigins = []>
        <#if client?? && client.attributes?? && client.attributes["post.logout.redirect.uris"]??>
            <#list client.attributes["post.logout.redirect.uris"]?split("##") as uri>
                <#assign origin = uri?trim?replace("^(https?://[^/]+).*$", "$1", "r")>
                <#if origin?matches("https?://[^/]+") && !appOrigins?seq_contains(origin)>
                    <#assign appOrigins = appOrigins + [origin]>
                </#if>
            </#list>
        </#if>

        <#--
          `url.resourcesPath` is "<base>/resources/<ver>/login/<theme>", so
          trimming at "/resources/" yields the server's base path ("" or e.g.
          "/auth") without hardcoding either.
        -->
        <#assign kcBase = url.resourcesPath?keep_before("/resources/")>
        <#assign signOutUrl = kcBase + "/realms/" + realm.name?url('UTF-8') + "/protocol/openid-connect/logout">
        <#if client?? && client.clientId?has_content>
            <#assign signOutUrl = signOutUrl + "?client_id=" + client.clientId?url('UTF-8')>
        </#if>

        <div id="kc-error-message" class="bd-error">
            <div class="bd-alert bd-alert-warning" role="alert">
                <span aria-hidden="true">!</span>
                <span>${kcSanitize(message.summary)?no_esc}</span>
            </div>

            <a id="signOutAndSwitch"
               class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} bd-error-primary"
               href="${signOutUrl}"
               data-switch-path="${properties.switchAccountPath!''}"
               data-app-origins="${appOrigins?join(' ')}">
                ${msg("doSignOutAndSwitch")}
            </a>
        </div>
    </#if>
</@layout.registrationLayout>
