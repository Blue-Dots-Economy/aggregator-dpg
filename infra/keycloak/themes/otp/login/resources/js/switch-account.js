/*
 * Points the error page's sign-out button at the account-switch route of the
 * app whose sign-in was refused. See error.ftl for why the address comes from
 * this page's URL and how it is checked.
 */
(function () {
  var button = document.getElementById('signOutAndSwitch');
  if (!button) return;
  var path = button.getAttribute('data-switch-path');
  var allowed = (button.getAttribute('data-app-origins') || '').split(' ').filter(Boolean);
  if (!path || allowed.length === 0) return;

  var params = new URLSearchParams(window.location.search);
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
  if (!redirectUri) return;

  var origin;
  try {
    origin = new URL(redirectUri).origin;
  } catch (e) {
    return;
  }
  if (allowed.indexOf(origin) === -1) return;

  var target = new URL(path, origin);
  if (state) target.searchParams.set('flow', state);
  button.href = target.toString();
})();
