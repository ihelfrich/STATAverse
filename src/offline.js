export function registerOffline() {
  if ("serviceWorker" in navigator && location.protocol !== "file:")
    navigator.serviceWorker
      .register(new URL("../../service-worker.js", import.meta.url).href)
      .catch(() => {});
}
