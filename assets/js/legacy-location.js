(function () {
  "use strict";
  var oldBase = "/STATAverse/";
  if (!location.pathname.startsWith(oldBase)) return;
  // Both paths share an origin, so existing notes and practice stay in place.
  // Keep the original query and fragment, including deep lesson links.
  location.replace(
    "/learn/stata/" +
      location.pathname.slice(oldBase.length) +
      location.search +
      location.hash,
  );
})();
