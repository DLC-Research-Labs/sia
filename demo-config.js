// Optional client-side feed keys. Both are free, per-account rate-limited,
// and designed to ship in the browser — but committing one is the repo
// owner's call, so the WSDOT code below is
// baked deliberately (Cash-approved 2026-07-10; it already ships publicly in
// the dalove demo bundle). Without it the app still
// runs live on Seattle Fire 911; traffic/closures show as off in Sources.
//   WSDOT: wsdot.wa.gov/traffic/api    Ticketmaster: developer.ticketmaster.com
// (localStorage "wsdot-access-code" / "tm-api-key" override these.)
window.WSDOT_ACCESS_CODE = "315f7f84-969a-4332-8479-81d2157bfed0";
window.TM_API_KEY = "";
