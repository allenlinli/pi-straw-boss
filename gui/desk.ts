// Desk mode in the page (desk-mode spec S9): a server that runs with STRAW_BOSS_DESK=1 marks the page with <meta name="sb-desk" content="1">, and the page, which reads it once at load,
// leaves out GUI remote access (the settings page's Phone & devices section) and stash (each base's Stash button, the HUD's Stashed button and list). It is presentation only: the server's routes stay.

/** Whether the page carries the desk marker. */
export const deskMode = (doc: Pick<Document, "querySelector"> = document): boolean => doc.querySelector<HTMLMetaElement>('meta[name="sb-desk"]')?.content === "1";

/** This page's mode, read when the page loads (a node test has no page: normal mode). */
export const desk = typeof document !== "undefined" && typeof document.querySelector === "function" && deskMode();

/** Whether the settings page's Phone & devices section is hidden: in desk mode always, otherwise on any page but this computer's own (a paired device comes in by its tailnet name: remote.ts). */
export const phoneHidden = (hostname: string, off = desk) => off || hostname !== "127.0.0.1";

/** Which sections of the settings page this page may show: Phone & devices unless `phoneHidden`, Server (restart, its log) only on this computer's own page, desk window included. The server's own routes say 403 `local_only` to anything else. */
export const settingsAllowed = (hostname: string, off = desk) => ({ phone: !phoneHidden(hostname, off), server: hostname === "127.0.0.1" });
