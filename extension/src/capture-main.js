// Runs in the PAGE's own JS context (world: "MAIN"), injected at document_start —
// i.e. before ESPN's or Yahoo's own scripts run. This is the only place a patch to
// window.WebSocket/fetch/XHR actually intercepts what the page itself opens; a
// content script in the isolated world would patch a different WebSocket object
// than the one the page's own code sees.
//
// We don't yet know whether ESPN/Yahoo push live picks over WebSocket, SSE, or a
// long-lived fetch stream — early network sniffing on both platforms showed no
// discrete HTTP polling once a draft goes live, which rules out plain polling but
// not which push transport is used. So this file instruments all three candidate
// transports and reports everything it sees; the isolated relay script forwards it
// to the extension for inspection in the side panel.
(function () {
  const TAG = '__draftAssistantEvent__';
  const platform = location.hostname.includes('espn.com')
    ? 'espn'
    : location.hostname.includes('yahoo.com')
      ? 'yahoo'
      : 'unknown';

  function emit(kind, detail) {
    window.postMessage({ [TAG]: true, kind, platform, ts: Date.now(), ...detail }, '*');
  }

  // --- WebSocket ---
  const NativeWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    emit('ws-open', { url: String(url) });
    ws.addEventListener('message', (e) => {
      emit('ws-message', {
        url: String(url),
        data: typeof e.data === 'string' ? e.data.slice(0, 4000) : '[binary]',
      });
    });
    ws.addEventListener('close', () => emit('ws-close', { url: String(url) }));
    return ws;
  }
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    PatchedWebSocket[k] = NativeWebSocket[k];
  }
  window.WebSocket = PatchedWebSocket;

  // --- fetch (covers SSE opened via fetch + any XHR-free polling) ---
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const result = nativeFetch.apply(this, args);
    result
      .then((res) => emit('fetch', { url: String(url), status: res.status }))
      .catch(() => {});
    return result;
  };

  // --- XHR (covers classic long/short polling) ---
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__draftAssistantUrl = url;
    return nativeOpen.call(this, method, url, ...rest);
  };
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      emit('xhr', { url: String(this.__draftAssistantUrl || ''), status: this.status });
    });
    return nativeSend.apply(this, args);
  };

  // --- EventSource (SSE) ---
  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    function PatchedEventSource(url, config) {
      const es = new NativeEventSource(url, config);
      emit('sse-open', { url: String(url) });
      es.addEventListener('message', (e) => {
        emit('sse-message', { url: String(url), data: String(e.data).slice(0, 4000) });
      });
      return es;
    }
    PatchedEventSource.prototype = NativeEventSource.prototype;
    window.EventSource = PatchedEventSource;
  }
})();
