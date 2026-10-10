import "../shared/protocol.js";

/**
 * ES-module view of the shared protocol, plus payload typedefs.
 *
 * @typedef {{ type: string, tabId?: number, force?: boolean }} CaptureRequest
 * @typedef {{ ok: true, reportId: string }
 *   | { ok: false, error: string }
 *   | { ok: false, reason: "no-issues" }} CaptureResult
 * @typedef {{ type: string, count: number }} BadgeUpdate
 * @typedef {{ host: string, hostname: string, enabled: boolean, muted: boolean,
 *             stats: { errors: number, warnings: number, failedRequests: number } }} PageStats
 *
 * @typedef {object} ConsoleEntry
 * @property {number} ts
 * @property {"console"|"error"|"rejection"} type
 * @property {"error"|"warn"} level
 * @property {string} message
 * @property {string|null} stack
 * @property {string|null} source
 * @property {number} count
 *
 * @typedef {object} NetworkEntry
 * @property {number} ts
 * @property {"fetch"|"xhr"|"resource"|"webRequest"} initiator
 * @property {string} method
 * @property {string} url
 * @property {number} status          0 when the request never got a response
 * @property {string} [statusText]
 * @property {string|null} [error]
 * @property {number} [durationMs]
 * @property {string} [resourceType]
 * @property {Record<string,string>} [requestHeaders]
 * @property {string|null} [requestBody]
 * @property {Record<string,string>} [responseHeaders]
 * @property {string|null} [responseBody]
 *
 * @typedef {{ ts: number, kind: string, text: string }} Breadcrumb
 *
 * @typedef {object} PageSnapshot
 * @property {boolean} siteEnabled
 * @property {{ url: string, title: string, referrer: string|null, timeOrigin: number, loadTimeMs: number|null }} page
 * @property {object} env
 * @property {{ errors: number, warnings: number, failedRequests: number }} stats
 * @property {ConsoleEntry[]} console
 * @property {NetworkEntry[]} network
 * @property {Breadcrumb[]} breadcrumbs
 */

export const { Msg, HOOK_EVENT } = globalThis.BugDetectorProtocol;
