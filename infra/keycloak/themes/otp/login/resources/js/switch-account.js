/*
 * Points the error page's sign-out button at the app the person was using.
 * See error.ftl for where the address comes from and how it is checked.
 *
 * Loaded on every page: the logout confirmation page records its post-logout
 * address here, for the error page shown if that confirmation fails.
 */
(function () {
  var STORED_POST_LOGOUT = 'bd.postLogoutRedirectUri';
  var params = new URLSearchParams(window.location.search);
  var button = document.getElementById('signOutAndSwitch');

  if (!button) {
    // Keycloak shows the confirmation page only after checking this address
    // against the client's registered list; an invalid one gets the error page.
    var postLogout = params.get('post_logout_redirect_uri');
    if (postLogout) {
      try {
        sessionStorage.setItem(STORED_POST_LOGOUT, postLogout);
      } catch (e) {
        // Storage unavailable: a failed confirmation keeps the plain sign-out link.
      }
      // Back after a sign-out restores this page from the browser cache with its
      // button already used and disabled, which leaves no way forward.
      window.addEventListener('pageshow', function (event) {
        var confirm = document.querySelector('input[name="confirmLogout"]');
        if (event.persisted && confirm && confirm.disabled) window.location.replace(postLogout);
      });
    }
    return;
  }

  var allowed = (button.getAttribute('data-app-origins') || '').split(' ').filter(Boolean);
  if (allowed.length === 0) return;

  function originOf(uri) {
    try {
      return new URL(uri).origin;
    } catch (e) {
      return null;
    }
  }

  var redirectUri = params.get('redirect_uri');
  var state = params.get('state');
  var clientData = params.get('client_data');
  if (clientData) {
    try {
      var flow = JSON.parse(atob(clientData.replace(/-/g, '+').replace(/_/g, '/')));
      redirectUri = flow.ru || redirectUri;
      state = flow.st || state;
    } catch (e) {
      // Unreadable flow data: keep the server-rendered sign-out link.
    }
  }

  if (!redirectUri) {
    // No refused sign-in: a logout confirmation failed. Keycloak shows this once
    // the realm session has ended or the confirmation was already used, so go
    // straight to the app's sign-in page.
    var stored = null;
    try {
      stored = sessionStorage.getItem(STORED_POST_LOGOUT);
    } catch (e) {
      return;
    }
    if (stored && allowed.indexOf(originOf(stored)) !== -1) button.href = stored;
    return;
  }

  var path = button.getAttribute('data-switch-path');
  var origin = originOf(redirectUri);
  if (!path || allowed.indexOf(origin) === -1) return;

  var target = new URL(path, origin);
  if (state) target.searchParams.set('flow', state);
  button.href = target.toString();
})();
