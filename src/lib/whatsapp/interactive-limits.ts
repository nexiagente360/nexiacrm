// ============================================================
// Meta limits for interactive messages — kept in their own module
// because they are the only thing client components need from the
// Cloud API layer.
//
// `meta-api.ts` reads `process.env` and now also imports the media-link
// resolver (service role), so anything that reaches the browser must
// import the constant from here instead. `meta-api.ts` re-exports it, so
// existing server-side imports keep working.
//
// Hard-coded so violations fail at build/save time rather than as a 400
// from the Meta API mid-conversation. See:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
//   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
// ============================================================

export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const
