// An object, not `export let`: an ESM live binding is read-only from the
// importer, so a test could never reset the count.
export const counters = { sync: 0 };
export function syncInterruptibleSessions() { counters.sync += 1; }
