// JSONP transport for feeds that support a callback param but not CORS
// (WSDOT confirmed: 200s with no Access-Control-Allow-Origin, official JSONP
// support). Returns a fetch-like response so adapters stay transport-blind.
// Browser-only — Node smoke scripts use real fetch, which has no CORS.

let counter = 0;

export function jsonpFetch(url, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    counter += 1;
    const callbackName = `__cityIntuitionJsonp${counter}`;
    const script = document.createElement("script");

    const cleanup = () => {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`jsonp timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    window[callbackName] = (data) => {
      cleanup();
      resolve({ ok: true, status: 200, json: async () => data });
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("jsonp script failed to load"));
    };

    script.src = `${url}${url.includes("?") ? "&" : "?"}callback=${callbackName}`;
    document.head.append(script);
  });
}
