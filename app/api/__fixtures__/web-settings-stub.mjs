export const store = { autoResumeSessions: false, autoUpdateOmp: false };
export function loadWebServerSettings() { return { ...store }; }
export function saveWebServerSettings(patch) { Object.assign(store, patch); return { ...store }; }
