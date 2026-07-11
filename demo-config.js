// Optional client-side feed keys. Both are free, per-account rate-limited,
// and designed to ship in the browser — but committing one is the repo
// owner's call, so this file ships blank. Without a WSDOT key the app still
// runs live on Seattle Fire 911; traffic/closures show as off in Sources.
//   WSDOT: wsdot.wa.gov/traffic/api    Ticketmaster: developer.ticketmaster.com
// (localStorage "wsdot-access-code" / "tm-api-key" override these.)
window.WSDOT_ACCESS_CODE = "";
window.TM_API_KEY = "";
