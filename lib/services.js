/**
 * Optional host services the plugin borrows at runtime.
 *
 * The plugin publishes tools only, so it never provides a service and never
 * needs an isolate realm; the host services it uses are read through `ctx.get`
 * and stashed here because a tool body receives execution data, not the plugin
 * context. Everything is optional — a missing service degrades to a clear
 * diagnostic instead of failing plugin activation.
 */

/** @type {{ llm?: object, attachments?: object }} */
const host = {}

export function setHostServices(services) {
  host.llm = services.llm
  host.attachments = services.attachments
}

/** Overwrite for tests; returns the previous slot values. */
export function setHostServicesForTest(services) {
  const previous = { llm: host.llm, attachments: host.attachments }
  setHostServices(services)
  return previous
}

export function hostLlm() {
  return host.llm
}

export function hostAttachments() {
  return host.attachments
}
