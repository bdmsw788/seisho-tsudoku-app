/* みことばの庭 Push通知専用 Service Worker (キャッシュ非干渉) */

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var payload = {};
  if (event.data) {
    try {
      payload = event.data.json() || {};
    } catch (e) {
      try {
        payload = { body: event.data.text() };
      } catch (e2) {
        payload = {};
      }
    }
  }

  var title = payload.title || "みことばの庭";
  var body = payload.body || "今日の聖書通読の時間です。";
  var tag = payload.tag || "mikotoba-notification";
  var data = payload.data && typeof payload.data === "object" ? payload.data : { url: "/" };
  if (!data.url) data.url = "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: "/icon-180.png",
      tag: tag,
      data: data
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var rawUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : "/";
  var targetUrl = new URL(rawUrl, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        try {
          if (new URL(client.url).origin === self.location.origin && "focus" in client) {
            return client.focus();
          }
        } catch (e) {}
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
