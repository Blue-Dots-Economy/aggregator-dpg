<#import "template.ftl" as layout>
<#--
  Overrides keycloak.v2's error page so the visitor can sign out and use another
  account. Keycloak shows it when the portal gate refuses the signed-in account,
  or when a second account signs in while another is signed in.

  The button goes to the app's account-switch route (`switchAccountPath`), which
  ends the app session as well as the realm session. The portal's address is
  the client's last post-logout URI ending in "/login"; the realm lists the
  public URL last. Otherwise the button uses Keycloak's end-session endpoint
  with `client_id` only, because a guessed post-logout URI may be wrong or
  unregistered.

  The Back arrow is hidden: going back reopens a form Keycloak has already used.
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
