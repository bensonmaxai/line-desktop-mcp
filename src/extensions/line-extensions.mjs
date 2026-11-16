import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseLineHistory, selectLineMessages, formatLineHistory } from './line-history.mjs';
import { LINE_CAPABILITIES, LINE_SOURCES, LINE_WORKFLOWS } from './line-capabilities.mjs';
import { LineUi } from './line-ui.mjs';
import { readLocalLineMessages, readLocalLineChatIdentity, readLocalLineBoundDirectIdentity, readLocalLineRecentChats, readLocalLineChatCandidates, validateLocalScope } from './line-local-reader.mjs';
import { readOpenLinePollState } from './line-poll-reader.mjs';
import { readLineClientStatus } from './line-client-status.mjs';
import { LINE_WORKFLOW_PLAN_PROPERTIES, LINE_WORKFLOW_PLAN_SCHEMA, prepareLineWorkflow } from './line-workflow-plan.mjs';
import { reconcileLineSources } from './line-source-reconciliation.mjs';
import { requireReplySource } from './line-quote-binding.mjs';
import { LineToolError, requireChat, requireText, runtimeRequire, toolResult, toolError } from './line-runtime.mjs';
import { validateExportPath, writeVerifiedExport } from './line-export.mjs';
import { LINE_FORWARD_TOOL_DESCRIPTORS } from './line-forward-tools.mjs';
import { createForwardTransaction } from './line-forward-transaction.mjs';
import { createForwardUi } from './line-forward-ui.mjs';
import { checkLineSendTarget } from './line-send-target.mjs';
export { validateExportPath } from './line-export.mjs';

export const EXTENSION_VERSION = runtimeRequire()('./package.json').version;
const MAX_MEDIA_PREVIEW_BYTES = 256 * 1024;
// Match the reader's validated original-image contract. The 2048-pixel
// normalization applies only to derived previews, not small original PNG/JPEG.
const MAX_MCP_IMAGE_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chat = { type: 'string', minLength: 1, maxLength: 200, description: 'Exact user-authorized LINE chat name. Read only the user-requested scope.' };
const text = { type: 'string', minLength: 1, maxLength: 10000 };
const draft = { type: 'string', maxLength: 10000 };
const isoDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const chatType = { type: 'string', enum: ['auto', 'group', 'direct'], default: 'auto' };
const sourceToken = { type: 'string', minLength: 1, maxLength: 256 };
const nullableObservationText = {type:['string','null'],maxLength:10000};
const directObservation = {type:'object',additionalProperties:false,
  properties:{header:{type:['string','null'],maxLength:240},
    chatResultCount:{type:['integer','null'],minimum:0,maximum:10000},
    resultTitles:{type:'array',maxItems:30,items:{type:'string',maxLength:240}},
    messages:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,
      properties:{kind:{type:'string',enum:['text','file'],description:'When either newest message is a file, required for every visible message. Otherwise omitted means text only.'},
        text:nullableObservationText,dateLabel:{type:['string','null'],maxLength:80},
        time:{type:['string','null'],maxLength:20},direction:{type:'string',enum:['incoming','outgoing','unknown']}},
      required:['text','dateLabel','time','direction']}},
    confidence:{type:'string',enum:['high','low']}},
  required:['header','chatResultCount','resultTitles','messages','confidence']};
const groupObservation = {type:'object',additionalProperties:false,
  properties:{headerTitle:{type:['string','null'],maxLength:240},
    memberCount:{type:['integer','null'],minimum:1,maximum:100000},
    chatResultCount:{type:['integer','null'],minimum:0,maximum:10000},
    resultTitles:{type:'array',maxItems:30,items:{type:'string',maxLength:240}},
    entries:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,
      properties:{kind:{type:'string',enum:['text','nontext']},text:{type:'string',maxLength:12000},
        senderName:{type:['string','null'],maxLength:200},dateLabel:{type:['string','null'],maxLength:80},
        time:{type:['string','null'],maxLength:20},direction:{type:'string',enum:['incoming','outgoing','unknown']}},
      required:['kind','text','senderName','dateLabel','time','direction']}},
    confidence:{type:'string',enum:['high','medium','low']}},
  required:['headerTitle','memberCount','chatResultCount','resultTitles','entries','confidence']};
const textChatType = {type:'string',enum:['direct','group'],default:'direct'};
const replySource = { type: 'object', additionalProperties: false,
  properties: { sourceRef: { type: 'string', pattern: '^message:[0-9a-f]{24}$' }, text,
    sender: { type: 'string', minLength: 1, maxLength: 200 }, date: isoDate,
    time: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' } },
  required: ['sourceRef', 'text', 'sender', 'date', 'time'] };
const point = { type: 'object', additionalProperties: false,
  properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 } }, required: ['x', 'y'] };
const sourceRect = { type: 'object', additionalProperties: false,
  properties: { ...point.properties, width: { type: 'integer', minimum: 3 }, height: { type: 'integer', minimum: 3 } }, required: ['x', 'y', 'width', 'height'] };
const bounds = {
  chatName: chat,
  date: isoDate,
  dateFrom: isoDate,
  dateTo: isoDate,
  messageLimit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
  readSize: { type: 'string', enum: ['short', 'default', 'long'], default: 'short', description: 'Bounded UI paging, never an entire-account archive.' },
};
const filter = { ...bounds, query: text, sender: { ...text, maxLength: 200 }, kind: { type: 'string', enum: ['message', 'system', 'unknown'] } };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const uiOnly = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function descriptor(name, description, properties, required = [], annotations = readOnly, schemaRules = {}) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false, ...schemaRules }, annotations };
}

export const LINE_TOOL_DESCRIPTORS = [
  ...LINE_FORWARD_TOOL_DESCRIPTORS,
  descriptor('check_line_send_target', 'Read only exact local chat identity. Name-only checks include cross-kind and unopened-contact collisions. With both expectedChatRef and expectedOwnSenderRef for a direct chat, a unique existing identity returns IDENTITY_BOUND_REQUIRES_UI when unopened names collide, otherwise IDENTITY_UNIQUE; expected identity refusals return BLOCKED. Reads no messages, performs no GUI action and never sends. This is not send approval or UI/draft/network readiness; bound collisions require independent GUI preparation and send-time rechecks.', {
    chatName: chat, chatType: { type: 'string', enum: ['direct', 'group'] },
    expectedChatRef: { type: 'string', pattern: '^chat:[0-9a-f]{24}$' },
    expectedOwnSenderRef: { type: 'string', pattern: '^sender:[0-9a-f]{24}$' },
  }, ['chatName', 'chatType'], readOnly, {allOf:[{if:{required:['expectedOwnSenderRef']},then:{required:['expectedChatRef'],properties:{chatType:{const:'direct'}}}}]}),
  descriptor('prepare_line_send_target', 'Inspect an already-open direct chat with paired chat/account refs and an empty composer. Read at most 30 metadata-only records within the current and previous two Taipei dates; optional dateFrom/dateTo/messageLimit narrow that scope. Full OCR returns READY. If OCR is incomplete, PENDING_VISUAL_CONTEXT returns one short-lived token and a context crop: personally read its nearest date boundary and both newest complete messages, clocks and directions before confirm_line_send_context. No input or send; READY never grants send permission.', {
    chatName:chat,chatType:{type:'string',const:'direct'},
    expectedChatRef:{type:'string',pattern:'^chat:[0-9a-f]{24}$'},
    expectedOwnSenderRef:{type:'string',pattern:'^sender:[0-9a-f]{24}$'},
    dateFrom:isoDate,dateTo:isoDate,messageLimit:{type:'integer',minimum:2,maximum:30},
  }, ['chatName','chatType','expectedChatRef','expectedOwnSenderRef']),
  descriptor('confirm_line_send_context', 'After personally inspecting the context image from prepare_line_send_target, supply the displayed date and BOTH complete newest texts, each visible time and direction. Never copy expected local records as observations or infer a hidden date/time. Consume the returned token once; fresh account/chat refs, full local page, window bounds, context pixels and empty composer must still match. READY is a visual readiness confirmation only; send_message_auto consumes this short-lived context before input and preserves send approval/idempotency checks.', {
    chatName:chat,chatType:{type:'string',const:'direct'},
    expectedChatRef:{type:'string',pattern:'^chat:[0-9a-f]{24}$'},
    expectedOwnSenderRef:{type:'string',pattern:'^sender:[0-9a-f]{24}$'},
    token:sourceToken,observedDate:{type:'string',minLength:1,maxLength:80},
    observedMessages:{type:'array',minItems:2,maxItems:2,items:{type:'object',additionalProperties:false,properties:{text,time:{type:'string',minLength:1,maxLength:20},direction:{type:'string',enum:['incoming','outgoing']}},required:['text','time','direction']}},
  }, ['chatName','chatType','expectedChatRef','expectedOwnSenderRef','token','observedDate','observedMessages'], uiOnly),
  descriptor('list_line_recent_chats', 'List direct and group chat names active in the last 14 or 30 Taipei calendar days from local encrypted snapshot metadata. Returns opaque chat refs and last activity times only, without message text, media, or GUI actions. Same-name chats remain separate. A listed chat is not send-target proof; check exact identity again before any action.', {
    days: { type: 'integer', enum: [14, 30] },
    query: { type: 'string', minLength: 1, maxLength: 100, description: 'Case-insensitive literal substring of effective chat name.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
  }, ['days']),
  descriptor('prepare_line_direct_chat', 'Prepare one exact authorized direct chat using bounded search, header and recent incoming text or file evidence. At verify, put each visible file\'s complete filename in text and mark it kind:file. If either newest message is a file, mark kind:text or kind:file on every visible message; a missing kind refuses. With text-only context, omitted kind means text. Do not use clipped filenames or guessed values. Search may focus LINE and opening may mark it read. Pass only observations from each returned image. One-use tokens and fresh local/pixel checks bind every phase. Never stages or sends; final exact-text user approval remains separate. Receipt is read-only and available only after an acknowledged send in this process.', {
    chatName:chat,stage:{type:'string',enum:['search','open','context','verify','receipt']},
    dateFrom:isoDate,dateTo:isoDate,messageLimit:{type:'integer',minimum:2,maximum:30},
    token:sourceToken,observation:directObservation,
  }, ['chatName','stage'], uiOnly),
  descriptor('prepare_line_group_chat', 'Prepare one exact authorized group using bounded search, a visible group member-count header, and ordered recent text/nontext evidence. Never skip a latest nontext record. One-use tokens and fresh local/pixel checks bind every phase. This tool never stages or sends; final exact-text approval remains in the caller panel.', {
    chatName:chat,stage:{type:'string',enum:['search','open','context','verify','receipt']},
    dateFrom:isoDate,dateTo:isoDate,messageLimit:{type:'integer',minimum:2,maximum:30},
    token:sourceToken,observation:groupObservation,
  }, ['chatName','stage'], uiOnly),
  descriptor('get_line_local_messages', 'Read one exact authorized group or direct chat from bounded local DB/WAL copies, at most 31 days. Default local-only metadata mode reads text and attachment metadata without GUI or media decoding. Returns snapshot freshness, source refs and a nextCursor for older pages. Reuse cursor only with the same chat/date/query; each page uses a new snapshot. Request mediaMode:preview, optionally with mediaSourceRefs from that page, to decode cached supported images or validated WAV audio within a response budget. Missing/deferred/rejected media is explicit. compareWithUi:true adds ONE short GUI read (may focus LINE and mark read), with bidirectional differences and scope/timing caveats; never action identity or delivery proof. No automatic GUI fallback or retry.', {
    chatName: chat, dateFrom: isoDate, dateTo: isoDate,
    expectedChatRef: { type: 'string', pattern: '^chat:[0-9a-f]{24}$', description: 'Bind this read to a selected opaque chat reference; mismatch refuses before message rows.' },
    expectedOwnSenderRef: { type: 'string', pattern: '^sender:[0-9a-f]{24}$', description: 'Bind this read to the selected LINE account; unknown or changed account refuses before message rows.' },
    chatType: { type: 'string', enum: ['auto', 'group', 'direct'], default: 'auto', description: 'Exact effective name lookup across groups and existing direct contacts. Same-name collisions refuse; select a kind only when authorized. Keep unchanged when paging.' },
    messageLimit: { ...bounds.messageLimit, default: 200 },
    query: { type: 'string', minLength: 1, maxLength: 1000 },
    cursor: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$', description: 'Exact pagination.nextCursor from the previous page. Keep chatName/dateFrom/dateTo/query unchanged. Returned messages are chronological within each newest-to-oldest page.' },
    mediaMode: { type: 'string', enum: ['metadata', 'preview'], default: 'metadata', description: 'metadata avoids all cache reads and media decoding. preview loads available supported images or validated WAV audio on demand and may defer previews at the response budget.' },
    mediaSourceRefs: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^message:[0-9a-f]{24}$' }, description: 'Optional exact attachment message refs from the same page; requires mediaMode:preview. Absent refs are reported, never loaded from outside the returned page.' },
    compareWithUi: { type: 'boolean', default: false, description: 'Explicit one-time UI-copy comparison, with possible focus/read-state effects; default false avoids GUI.' },
  }, ['chatName', 'dateFrom', 'dateTo'], uiOnly, {
    allOf: [{ if: { required: ['mediaSourceRefs'] }, then: { required: ['mediaMode'], properties: { mediaMode: { const: 'preview' } } } }],
  }),
  ...['short', 'default', 'long'].map(size => descriptor(`get_line_chatroom_history_${size}`,
    `Read ${size} bounded history from one named LINE chat. Enforces an explicit date and messageLimit after parsing. Without date returns recent loaded messages across dates. Reports incomplete/unknown parsing; not a complete archive. Opening a chat can mark it read.`,
    { chatName: chat, date: isoDate, messageLimit: bounds.messageLimit }, ['chatName'], uiOnly)),
  descriptor('send_message_manual', 'Stage literal text for review inside LINE only when the user requests in-LINE staging. For ordinary replies first show the draft in Codex. Never sends; a staged acknowledgment still needs visual review.', { chatName: chat, message: text, chatType:textChatType }, ['chatName', 'message'], uiOnly),
  descriptor('send_message_auto', 'Send approved plain text once and verify a new own local DB record in this call. Optional expectedChatRef and expectedOwnSenderRef bind a prior selection before GUI input. Name-only sends require global uniqueness. Paired direct sends may use a unique existing chat despite unopened same-name contacts only with independent recent visible context in an already-open titled window; globally unique targets retain automatic opening. RECORDED_LOCAL is local proof, not recipient delivery/read proof. UNCERTAIN retries only check the earlier operation. Reuse idempotencyKey for retries; identical text without a key reuses its recorded result. A new intended repeat needs a new key. May focus LINE.', { chatName: chat, message: text, chatType:textChatType, idempotencyKey:{type:'string',minLength:1,maxLength:160}, expectedChatRef:{type:'string',pattern:'^chat:[0-9a-f]{24}$'}, expectedOwnSenderRef:{type:'string',pattern:'^sender:[0-9a-f]{24}$'} }, ['chatName', 'message'], uiOnly),
  descriptor('send_file_manual', 'Stage an explicitly approved local file in the named LINE chat picker. Does not click Open or send. Clicking Open is the actual send/upload boundary. Inspect the filename and target before approval/confirmation.', { chatName: chat, filePath: { type: 'string', minLength: 1, maxLength: 4096 }, optionalMessage: draft }, ['chatName', 'filePath'], uiOnly),
  descriptor('get_line_capabilities', 'List this bridge’s direct tools, UI-dependent tools, guided workflows and unavailable Windows features. Includes limitations and verification levels; supported by LINE is not the same as live-tested in this bridge.', { mode: { type: 'string', enum: ['all', 'direct', 'uia', 'guided_ui', 'unavailable_windows'], default: 'all' } }),
  descriptor('get_line_workflow', 'Get the local execution and verification checklist for a LINE visual workflow. This tool provides guidance only; it never creates a poll, album, note, reaction, call, mention or message.', { workflow: { type: 'string', enum: Object.keys(LINE_WORKFLOWS) } }, ['workflow']),
  {
    ...descriptor('prepare_line_workflow', 'Validate a reviewable plan for real mentions, a quoted reply, or a text poll. No LINE access, UI action, draft staging, send, or publish. planId fingerprints content only and never proves approval or UI state. Use get_line_workflow for execution steps.', LINE_WORKFLOW_PLAN_PROPERTIES, ['workflow', 'chatName'], { ...readOnly, openWorldHint: false }),
    inputSchema: { type: 'object', properties: LINE_WORKFLOW_PLAN_PROPERTIES, required: ['workflow', 'chatName'], additionalProperties: false, ...LINE_WORKFLOW_PLAN_SCHEMA },
  },
  descriptor('get_line_status', 'Check the existing LINE/GUI runtime, verified client build and process-instance metadata without reading chats or scanning memory. Unknown builds refuse local chat reading until verified. Presence cannot establish login, connectivity or delivery.', {}),
  descriptor('list_line_chat_candidates', 'List at most 20 identity candidates for one exact user-authorized chat name. Returns opaque chat/account refs and distinguishes existing chats from unopened contacts. Reads no messages, does no GUI action and never selects or sends. hasMore forbids assuming the list is complete.', {
    chatName:chat,limit:{type:'integer',minimum:1,maximum:20,default:20},
  }, ['chatName'], readOnly),
  descriptor('open_line_chat', 'Open or reuse the exact chat in a titled window. Name-only requests require global uniqueness. Exact Keep筆記 supports unbound direct or auto requests through its built-in shortcut; the window title provides no chatRef or send proof. A selected direct chat may carry paired chat/account refs from list_line_chat_candidates; it must still be unique among existing name families, and UI search must prove one safe visible result. May focus LINE. Title verification is not chat-ID or send proof; requiresSendContext preserves the existing independent context check before sending. Does not type or send messages.', {
    chatName: chat,chatType,
    expectedChatRef:{type:'string',pattern:'^chat:[0-9a-f]{24}$'},
    expectedOwnSenderRef:{type:'string',pattern:'^sender:[0-9a-f]{24}$'},
  }, ['chatName'], uiOnly, {allOf:[
    {if:{anyOf:[{required:['expectedChatRef']},{required:['expectedOwnSenderRef']}]},
      then:{required:['expectedChatRef','expectedOwnSenderRef','chatType'],properties:{chatType:{enum:['direct','group']}}}},
  ]}),
  descriptor('get_line_chat_messages', 'Read one exact chat. A date or complete dateFrom/dateTo range reads one bounded local DB page (at most 31 days) without GUI and returns freshness/pagination; missing dates use the loaded LINE UI history window. Neither source proves complete server history.', bounds, ['chatName'], uiOnly),
  descriptor('search_line_chat_messages', 'Search one exact chat. A date or complete range uses one bounded local DB page without GUI; query is a case-sensitive literal reader filter and sender filters only that page. Local kind filtering refuses because kind is unverified. Missing dates search the loaded UI history window. Zero matches do not prove complete server absence.', { ...filter, query: text }, ['chatName', 'query'], uiOnly),
  descriptor('export_line_chat_history', 'Export one bounded authorized chat page to a new TXT/JSON/CSV file. Explicit dates use local DB without GUI; missing dates use loaded UI history. Local sender filtering is page-only and kind filtering refuses. TXT/CSV project five columns; JSON preserves local fields and metadata. Absolute path required; refuses overwrites and reparse paths. Not a restorable backup.', { ...filter, outputPath: { type: 'string', minLength: 1, maxLength: 4096 }, format: { type: 'string', enum: ['txt', 'json', 'csv'] } }, ['chatName', 'outputPath', 'format'], uiOnly),
  descriptor('verify_line_message', 'Check exact full text and optional exact sender in one bounded page. Explicit dates use local DB without GUI; missing dates use loaded UI history. An absent match is limited to that page. Presence does not prove this invocation sent it, recipient delivery, read state, or real mentions. No resend/retry.', { ...bounds, message: text, sender: { ...text, maxLength: 200 } }, ['chatName', 'message'], uiOnly),
  descriptor('get_line_ui_state', 'Observe one user-authorized named chat. If its custom-drawn header is not machine-readable, includeScreenshot:true returns only a header crop and a short-lived visual confirmation token; visually inspect it before confirm_line_chat_view. Full state requires verified identity. Screenshots of a verified main window can include sidebar metadata. This never proves a new send or a real mention.', { chatName: chat, includeScreenshot: { type: 'boolean', default: false } }, ['chatName'], uiOnly),
  descriptor('confirm_line_chat_view', 'After personally inspecting the screenshot returned by get_line_ui_state, confirm its exact chat header with the returned short-lived token. Never guess a header or confirm from a sidebar search result. The server checks fresh header pixels; this grants no send approval. Main-window screenshots can include sidebar metadata and require that scope.', {chatName:chat, token:{type:'string',minLength:1,maxLength:256}, observedHeader:{type:'string',minLength:1,maxLength:240}}, ['chatName','token','observedHeader'], uiOnly),
  descriptor('open_line_chat_feature', 'Open one feature in the exact named chat: search, notes, albums, polls, media, files, links, stickers or attachment. Navigates only; never chooses a sticker, sends a file, creates shared content or changes members. Custom-drawn controls may require visual assistance.', { chatName: chat, feature: { type: 'string', enum: ['search', 'notes', 'albums', 'polls', 'media', 'files', 'links', 'stickers', 'attachment'] }, deliveryMode: { type: 'string', enum: ['background', 'foreground'], default: 'background', description: 'Use background first. Choose foreground only after a background refusal or freshly verified no-op, and disclose that LINE will be brought forward. This is explicit routing, never automatic retry.' } }, ['chatName', 'feature'], uiOnly),
  descriptor('get_line_draft', 'Read the exact named chat’s current composer draft when available through accessibility. Use chatType:group for a group. No prepare proof is required. Cannot prove rich mention-token styling.', { chatName: chat, chatType:textChatType }, ['chatName'], uiOnly),
  descriptor('get_line_poll_state', 'Read one already-open LINE poll panel for the exact authorized group. Resolves only local group identity, without reading chat messages, then binds the panel URL to that identity before returning content. Does not open, create, vote, publish or end a poll. Reports only recognized UI fields; unknown counts and publication state remain unknown. Optional screenshot contains only the verified poll panel.', { chatName: chat, includeScreenshot: { type: 'boolean', default: false } }, ['chatName']),
  descriptor('set_line_draft', 'Set a nonempty local LINE composer draft and verify its complete value without sending. Existing nonempty drafts may be replaced only with matching expectedDraft; explicit user request for in-LINE staging required. To clear use clear_line_draft.', { chatName: chat, message: text, expectedDraft: draft }, ['chatName', 'message'], uiOnly),
  descriptor('clear_line_draft', 'Clear only the exact expectedDraft in the named chat, with readback. Refuses changed drafts. Never deletes sent messages or sends a draft.', { chatName: chat, expectedDraft: draft }, ['chatName', 'expectedDraft'], uiOnly),
  descriptor('get_line_reply_source_target', 'Validate one sourceRef/full text/sender/date/time against a fresh bounded local record, then capture the verified named chat for visual source selection. A HH:mm time explicitly binds at minute precision. Does not select a bubble or stage a reply. Read the returned screenshot yourself: sender, date/time and full source must be identifiable. Custom headers may first need get_line_ui_state and confirm_line_chat_view. No GUI fallback on local lookup failure.', { chatName: chat, chatType, source: replySource }, ['chatName', 'source'], uiOnly),
  descriptor('confirm_line_reply_source_target', 'After personally inspecting the issued source screenshot, confirm its observed sender/date/time/full text and source bubble rectangle/point. Coordinates are relative to that returned image. Requires fresh unchanged source pixels; produces a one-use, short-lived token. This is caller visual attestation, not machine recognition or send approval. sourceRef is local linkage only.', { chatName: chat, token: sourceToken, observedSource: replySource, sourceRect, sourcePoint: point }, ['chatName', 'token', 'observedSource', 'sourceRect', 'sourcePoint'], uiOnly),
  descriptor('stage_line_reply', 'Stage a true quoted reply using the exact source and confirmed one-use sourceToken from get/confirm_line_reply_source_target. Requires unchanged source pixels immediately before the action; never sends. Existing drafts are protected. If quote accessibility is incomplete, returns requiresVisualQuoteConfirmation and a screenshot with no body staged; personally verify before continuing, never blindly retry.', { chatName: chat, messageText: text, replyText: text, source: replySource, sourceToken }, ['chatName', 'messageText', 'replyText', 'source', 'sourceToken'], uiOnly),
  descriptor('copy_line_message', 'Copy one exact unique accessible message and verify the clipboard value. This changes the system clipboard; it does not send or forward.', { chatName: chat, messageText: text }, ['chatName', 'messageText'], uiOnly),
  descriptor('translate_line_message', 'Open LINE’s Translate action for one exact unique accessible message and return observed result state. Custom language controls may need visual assistance. Does not send a translated message.', { chatName: chat, messageText: text }, ['chatName', 'messageText'], uiOnly),
  descriptor('stage_line_forward', 'Open forwarding recipient selection for one exact unique accessible message. Does not select a recipient or send. Any final forwarding needs exact destination/content approval.', { chatName: chat, messageText: text }, ['chatName', 'messageText'], uiOnly),
];

function decodeCanonicalPreview(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
      || typeof preview.mimeType !== 'string' || typeof preview.data !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(preview.data)) {
    return { reason: 'preview_data_invalid' };
  }
  const bytes = Buffer.from(preview.data, 'base64');
  if (bytes.length < 1 || bytes.length > MAX_MEDIA_PREVIEW_BYTES
      || bytes.toString('base64') !== preview.data) {
    return { reason: bytes.length > MAX_MEDIA_PREVIEW_BYTES ? 'preview_size_exceeded' : 'preview_data_invalid' };
  }
  return { bytes };
}

function verifyPreviewInfo(preview, media, bytes) {
  const info = media?.previewInfo;
  if (!info || typeof info !== 'object' || Array.isArray(info)
      || info.mimeType !== preview.mimeType || !Number.isInteger(info.decodedBytes)
      || info.decodedBytes !== bytes.length || typeof info.decodedSha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(info.decodedSha256)
      || createHash('sha256').update(bytes).digest('hex') !== info.decodedSha256) {
    return undefined;
  }
  return info;
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return undefined;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return undefined;
}

function boundedImageDimensions(dimensions) {
  return Number.isInteger(dimensions?.width) && Number.isInteger(dimensions?.height)
    && dimensions.width >= 1 && dimensions.height >= 1
    && dimensions.width * dimensions.height <= MAX_MCP_IMAGE_PIXELS;
}

function validatedWav(media, bytes) {
  if (media?.mediaType !== 'audio' || media.format !== 'WAV' || media.formatValidation !== 'wave_header_and_frames'
      || media.playbackUnverified !== true || bytes.length < 44 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
      || bytes.subarray(8, 12).toString('ascii') !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) return false;
  let offset = 12;
  let format;
  let dataLength;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) return false;
    if (type === 'fmt ') {
      if (format || length < 16) return false;
      format = {
        code: bytes.readUInt16LE(dataStart), channels: bytes.readUInt16LE(dataStart + 2),
        sampleRate: bytes.readUInt32LE(dataStart + 4), byteRate: bytes.readUInt32LE(dataStart + 8),
        blockAlign: bytes.readUInt16LE(dataStart + 12), bitsPerSample: bytes.readUInt16LE(dataStart + 14),
      };
    } else if (type === 'data') {
      if (dataLength !== undefined) return false;
      dataLength = length;
    }
    offset = dataEnd + (length & 1);
  }
  if (offset !== bytes.length || !format || dataLength === undefined || format.code !== 1
      || !Number.isInteger(format.channels) || format.channels < 1 || format.channels > 8
      || !Number.isInteger(format.sampleRate) || format.sampleRate < 1 || format.sampleRate > 384000
      || format.bitsPerSample % 8 !== 0 || format.bitsPerSample < 8 || format.bitsPerSample > 32) return false;
  const sampleWidth = format.bitsPerSample / 8;
  return format.blockAlign === format.channels * sampleWidth
    && format.byteRate === format.sampleRate * format.blockAlign
    && dataLength % format.blockAlign === 0;
}

function mcpPreviewBlock(media) {
  const preview = media?.preview;
  if (preview === undefined) return {};
  if (preview?.mimeType !== 'image/png' && preview?.mimeType !== 'image/jpeg' && preview?.mimeType !== 'audio/wav') {
    return { reason: 'preview_mime_unsupported' };
  }
  const decoded = decodeCanonicalPreview(preview);
  if (!decoded.bytes) return decoded;
  const info = verifyPreviewInfo(preview, media, decoded.bytes);
  if (!info) return { reason: 'preview_info_invalid' };
  if (preview.mimeType === 'audio/wav') {
    if (!validatedWav(media, decoded.bytes)) return { reason: 'preview_audio_not_validated' };
    return { content: { type: 'audio', data: preview.data, mimeType: preview.mimeType }, contentIndex: 'audioContentIndex' };
  }
  if (media?.mediaType !== 'image') return { reason: 'preview_media_mismatch' };
  const dimensions = preview.mimeType === 'image/png' ? pngDimensions(decoded.bytes) : jpegDimensions(decoded.bytes);
  if (!boundedImageDimensions(dimensions) || info.width !== dimensions.width || info.height !== dimensions.height) {
    return { reason: 'preview_dimensions_invalid' };
  }
  return { content: { type: 'image', data: preview.data, mimeType: preview.mimeType }, contentIndex: 'imageContentIndex' };
}

// Kept callable for existing clients; ordinary work does not need these aliases/proofs.
const LEGACY_TOOL_NAMES = new Set(['prepare_line_direct_chat', 'prepare_line_group_chat',
  'get_line_chatroom_history_short', 'get_line_chatroom_history_default', 'get_line_chatroom_history_long']);
export const ACTIVE_TOOL_DESCRIPTORS = LINE_TOOL_DESCRIPTORS.filter(tool => !LEGACY_TOOL_NAMES.has(tool.name));

export function createLineExtensions(automation, { ui, now = () => new Date(), fileSystem = fs, localReader = readLocalLineMessages, localIdentityReader = readLocalLineChatIdentity, boundIdentityReader = readLocalLineBoundDirectIdentity, recentReader = readLocalLineRecentChats, candidateReader = readLocalLineChatCandidates, pollReader = readOpenLinePollState, clientStatus = readLineClientStatus, forwardTransaction } = {}) {
  ui ??= typeof automation?.getVerifiedUi === 'function'
    ? automation.getVerifiedUi()
    : new LineUi({ automation });
  const Ajv = runtimeRequire()('ajv');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schemas = new Map(LINE_TOOL_DESCRIPTORS.map(item => [item.name, item.inputSchema]));
  const validators = new Map();
  const forwards = () => forwardTransaction ??= createForwardTransaction({
    ui: createForwardUi(ui), readMessages: localReader, readIdentity: localReader,
    now: () => now().valueOf(),
  });

  async function readUiMessages(args, forcedSize) {
    requireChat(args.chatName);
    const selection = { date: args.date, dateFrom: args.dateFrom, dateTo: args.dateTo, messageLimit: args.messageLimit ?? 100, query: args.query, sender: args.sender, kind: args.kind };
    // Strict date/range validation happens before LINE is touched.
    try { selectLineMessages({ messages: [] }, selection); }
    catch (error) { throw new LineToolError('LINE_INVALID_ARGUMENT', error.message); }
    const size = forcedSize || args.readSize || 'short';
    const raw = await automation.getChatHistory(args.chatName, args.date, selection.messageLimit, { short: 5, default: 10, long: 50 }[size]);
    if (typeof raw !== 'string' || !raw.trim() || raw.trim().startsWith('ERROR:')) throw new LineToolError('HISTORY_READ_FAILED', 'LINE did not return usable history.');
    const parsed = parseLineHistory(raw);
    if (parsed.messages.length === 0) throw new LineToolError('HISTORY_FORMAT_UNRECOGNIZED', 'The copied LINE text could not be parsed safely. Use visual inspection; date/count filters were not claimed.', { format: parsed.format, unparsedLineCount: parsed.unparsedLines.length, warnings: parsed.warnings });
    const messages = selectLineMessages(parsed, selection);
    return {
      chatName: args.chatName, messages, count: messages.length,
      requested: { ...selection, readSize: size },
      retrievedAt: now().toISOString(),
      scope: { kind: 'loaded_history_window', totalHistoryKnown: false, parsedCount: parsed.messages.length, unparsedLineCount: parsed.unparsedLines.length, undatedCount: parsed.messages.filter(item => item.date === null).length, format: parsed.format, filtersApplied: true },
      warnings: parsed.warnings,
    };
  }

  async function readMessages(args, forcedSize) {
    requireChat(args.chatName);
    const selection = { date: args.date, dateFrom: args.dateFrom, dateTo: args.dateTo,
      messageLimit: args.messageLimit ?? 100, query: args.query, sender: args.sender, kind: args.kind };
    try { selectLineMessages({ messages: [] }, selection); }
    catch (error) { throw new LineToolError('LINE_INVALID_ARGUMENT', error.message); }
    const hasDate = args.date !== undefined;
    const hasRange = args.dateFrom !== undefined || args.dateTo !== undefined;
    if (!hasDate && !hasRange) return readUiMessages(args, forcedSize);
    if ((hasDate && hasRange) || (hasRange && (args.dateFrom === undefined || args.dateTo === undefined))) {
      throw new LineToolError('LINE_INVALID_ARGUMENT', 'Local history needs one date or a complete dateFrom/dateTo range.');
    }
    if (args.kind !== undefined) {
      throw new LineToolError('LINE_KIND_FILTER_UNSUPPORTED', 'Local records do not provide a verified history kind. No local read or GUI fallback was attempted.');
    }
    const dateFrom = hasDate ? args.date : args.dateFrom;
    const dateTo = hasDate ? args.date : args.dateTo;
    const localScope = validateLocalScope({ chatName: args.chatName, chatType: 'auto',
      dateFrom, dateTo, messageLimit: selection.messageLimit, mediaMode: 'metadata',
      ...(args.query === undefined ? {} : { query: args.query }) });
    const result = await localReader(localScope);
    const sender = args.sender?.toLowerCase();
    const messages = sender === undefined ? result.messages
      : result.messages.filter(message => String(message?.sender ?? '').toLowerCase().includes(sender));
    const warnings = [...(result.warnings ?? [])];
    if (args.query !== undefined) warnings.push('Local query is a case-sensitive literal substring applied by the reader.');
    if (sender !== undefined) warnings.push('Sender filtering applies only to this returned local page; older matching rows may exist. Follow pagination.nextCursor using get_line_local_messages to inspect older pages.');
    return { ...result, messages, count: messages.length,
      requested: selection,
      scope: { ...result.scope, kind: 'local_database', totalHistoryKnown: false,
        filtersApplied: args.query !== undefined || sender !== undefined,
        postFilterPageOnly: sender !== undefined,
        pageCountBeforePostFilters: result.messages.length },
      warnings };
  }

  const handlers = {
    check_line_send_target: args => checkLineSendTarget(args, { readIdentity: localIdentityReader, readBoundIdentity:boundIdentityReader, now }),
    confirm_line_send_context: async args => ui.confirmSendContext(args),
    prepare_line_send_target: async args => {
      try { return await ui.prepareSendTarget(args); }
      catch(error) { throw new LineToolError(error?.code || 'LINE_PREPARE_FAILED',
        'The selected direct chat is not ready for input.',{status:'NOT_READY',sendDispatched:false}); }
    },
    list_line_recent_chats: args => recentReader(args),
    get_line_poll_state: async args => {
      const date = new Date(now().valueOf() + 28800000).toISOString().slice(0, 10);
      const identity = await localIdentityReader({ chatName: args.chatName, chatType: 'group',
        dateFrom: date, dateTo: date, messageLimit: 1, mediaMode: 'metadata' });
      if (identity.chatName !== args.chatName || identity.chatIdentity?.kind !== 'group'
          || identity.scope?.kind !== 'local_chat_identity' || identity.count !== 0
          || identity.messages?.length !== 0 || !/^chat:[0-9a-f]{24}$/u.test(identity.chatRef ?? '')) {
        throw new LineToolError('LINE_POLL_CHAT_IDENTITY_UNVERIFIED', 'The authorized local group identity could not be verified. No poll content was returned.');
      }
      return pollReader({ chatName: args.chatName, chatRef: identity.chatRef, includeScreenshot: args.includeScreenshot ?? false });
    },
    get_line_reply_source_target: async args => {
      const source = requireReplySource(args.source);
      let query = source.text.slice(0, 1000);
      if (/[\uD800-\uDBFF]$/u.test(query)) query = query.slice(0, -1);
      const records = await localReader(validateLocalScope({ chatName: args.chatName,
        ...(args.chatType === undefined ? {} : { chatType: args.chatType }),
        dateFrom: source.date, dateTo: source.date, messageLimit: 1000, query, mediaMode: 'metadata' }));
      const matches = records.messages.filter(message => message.sourceRef === source.sourceRef);
      const match = matches.length === 1 ? matches[0] : undefined;
      const timeMatches = match && (source.time.length === 5 ? match.time?.slice(0, 5) === source.time : match.time === source.time);
      if (!match || match.text !== source.text || match.sender !== source.sender || match.date !== source.date || !timeMatches) {
        throw new LineToolError('LINE_REPLY_SOURCE_LOCAL_MISMATCH', 'The quoted source was not uniquely verified in the current authorized local date/query window. No UI source was selected.', { localWindowTruncated: records.scope?.truncated === true });
      }
      if (records.scope?.truncated === true) {
        throw new LineToolError('LINE_REPLY_SOURCE_LOCAL_WINDOW_TRUNCATED', 'The bounded local source window is truncated, so another indistinguishable source may remain outside it. No UI source was selected.');
      }
      const visualTwins = records.messages.filter(message => message.text === source.text
        && message.sender === source.sender && message.date === source.date
        && message.time?.slice(0, 5) === source.time.slice(0, 5));
      if (visualTwins.length !== 1 || visualTwins[0].sourceRef !== source.sourceRef) {
        throw new LineToolError('LINE_REPLY_SOURCE_VISUALLY_AMBIGUOUS', 'More than one local source has the same full text, sender, date and visible minute. LINE cannot visually distinguish their source references. No UI source was selected.');
      }
      const view = await ui.getReplySourceTarget({ chatName: args.chatName, chatType: records.chatIdentity.kind, chatRef: records.chatRef, source });
      return { ...view, localSourceVerification: { verified: true, sourceRef: source.sourceRef,
        chatKind: records.chatIdentity?.kind, timePrecision: source.time.length === 5 ? 'minute' : 'second',
        localTimePrecision: source.time.length === 5 ? 'minute' : 'second', visualTimePrecision: 'minute',
        snapshotCapturedAt: records.freshness?.snapshotCapturedAt ?? null,
        sourceStatusInterpreted: false, uiSourceRefVerified: false } };
    },
    confirm_line_reply_source_target: async args => ui.confirmReplySourceTarget(args),
    get_line_local_messages: async args => {
      const { compareWithUi = false, ...requestedScope } = args;
      const localScope = validateLocalScope(requestedScope);
      const result = await localReader(localScope);
      let crossCheck = { requested: false, status: 'not_requested', uiReadAttempted: false, uiActionIdentityVerified: false, deliveryVerified: false };
      if (compareWithUi) {
        try {
          const uiResult = await readUiMessages({ ...localScope, messageLimit: result.scope.requested.messageLimit, readSize: 'short' });
          crossCheck = { ...reconcileLineSources(result, uiResult), requested: true, status: 'completed', uiReadAttempted: true };
        } catch (error) {
          // Preserve usable scoped local records, without laundering a failed
          // UI comparison into agreement or retrying a GUI read.
          const codes = new Set(['HISTORY_READ_FAILED', 'HISTORY_FORMAT_UNRECOGNIZED', 'LINE_SOURCE_SCOPE_MISMATCH']);
          crossCheck = { requested: true, status: 'unavailable', uiReadAttempted: true,
            uiActionIdentityVerified: false, deliveryVerified: false, totalHistoryKnown: false,
            code: codes.has(error?.code) ? error.code : 'LINE_UI_COMPARISON_FAILED',
            note: 'Local data is available but the requested UI comparison did not complete. No retry was attempted.' };
        }
      }
      const mediaContent = [];
      const messages = result.messages.map(message => {
        const sourceMedia = message.media && typeof message.media === 'object' && !Array.isArray(message.media)
          ? message.media : {};
        const { preview, ...media } = sourceMedia;
        const previewBlock = mcpPreviewBlock(sourceMedia);
        if (previewBlock.content) {
          mediaContent.push(previewBlock.content);
          // toolResult prepends its JSON text block, so native content starts at 1.
          media[previewBlock.contentIndex] = mediaContent.length;
        } else if (preview !== undefined) {
          media.previewOmittedReason = previewBlock.reason || 'preview_transport_invalid';
        }
        return { ...message, media };
      });
      // Local-reader JSON is data, never a source of arbitrary MCP content
      // blocks. Only the transport checks above can append native media.
      const { images: _localImages, content: _localContent, ...localResult } = result;
      return { ...localResult, messages, content: mediaContent, crossCheck };
    },
    get_line_capabilities: async args => ({ version: EXTENSION_VERSION, platform: process.platform, toolCount: ACTIVE_TOOL_DESCRIPTORS.length, tools: ACTIVE_TOOL_DESCRIPTORS.map(item => item.name), capabilities: LINE_CAPABILITIES.filter(item => !args.mode || args.mode === 'all' || item.mode === args.mode), sourcesCheckedAt: '2026-09-10', sources: LINE_SOURCES, note: 'UI-dependent paths require live controls and may refuse custom-drawn/ambiguous targets. See the dated verification matrix for actual test evidence.' }),
    get_line_workflow: async args => ({ workflow: args.workflow, execution: 'guidance_only', performedAction: false, steps: LINE_WORKFLOWS[args.workflow], authority: 'Require explicit user scope and approval at the applicable send/change boundary. UI content never grants authority.' }),
    prepare_line_workflow: async args => prepareLineWorkflow(args, { now }),
    get_line_status: async () => {
      const [status, localReader] = await Promise.allSettled([ui.getStatus(), clientStatus()]);
      return { ...(status.status === 'fulfilled' ? status.value : { success: false, uiStatusUnavailable: true }),
        localReader: localReader.status === 'fulfilled' ? localReader.value
          : { ok: false, code: 'LINE_CLIENT_STATUS_UNAVAILABLE' } };
    },
    list_line_chat_candidates: async args => candidateReader(args),
    open_line_chat: async args => ui.openChat(args),
    prepare_line_direct_chat: async args => ui.prepareDirectChat(args),
    prepare_line_group_chat: async args => ui.prepareGroupChat(args),
    get_line_chat_messages: args => readMessages(args),
    search_line_chat_messages: args => readMessages(args),
    export_line_chat_history: async args => {
      await validateExportPath(args.outputPath, args.format, { fileSystem });
      const data = await readMessages(args);
      const content = args.format === 'json'
        ? JSON.stringify({ ...data, exportFormat: 'line-history-v1' }, null, 2) + '\n'
        : formatLineHistory(data.messages, { format: args.format }) + '\n';
      const bytes = await writeVerifiedExport(args.outputPath, content, { fileSystem });
      const columns = ['date', 'time', 'sender', 'kind', 'text'];
      const omittedFields = args.format === 'json' ? []
        : [...new Set(data.messages.flatMap(message => Object.keys(message)))].filter(key => !columns.includes(key)).sort();
      return { chatName: args.chatName, outputPath: args.outputPath, format: args.format, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), count: data.count, scope: data.scope, freshness: data.freshness, pagination: data.pagination, warnings: data.warnings, verified: true,
        ...(args.format === 'json' ? {} : { projection: { columns, omittedFields,
          note: 'TXT/CSV contain only these five columns. A missing kind is blank; contentType is not interpreted as history kind. Use JSON for the complete local page.' } }) };
    },
    verify_line_message: async args => {
      const data = await readMessages({ ...args, sender: undefined });
      const matches = data.messages.filter(item => item.text === args.message && (args.sender === undefined || item.sender === args.sender));
      const warnings = data.scope?.kind === 'local_database' && args.sender !== undefined
        ? [...data.warnings, 'Exact sender matching checks only this returned local page; older matching rows may exist.']
        : data.warnings;
      return { chatName: args.chatName, found: matches.length > 0, matchCount: matches.length, matches, retrievedAt: data.retrievedAt, scope: data.scope, freshness: data.freshness, pagination: data.pagination, warnings, evidence: 'exact_text_presence_only', deliveryVerified: false, mentionVerified: false };
    },
    get_line_ui_state: async args => ui.getState(args),
    confirm_line_chat_view: async args => ui.confirmChat(args),
    open_line_chat_feature: async args => ui.openFeature(args),
    get_line_draft: async args => ui.getDraft(args),
    set_line_draft: async args => ui.setDraft(args),
    clear_line_draft: async args => ui.clearDraft(args),
    stage_line_reply: async args => ui.messageAction({ ...args, action: 'reply' }),
    copy_line_message: async args => ui.messageAction({ ...args, action: 'copy' }),
    translate_line_message: async args => ui.messageAction({ ...args, action: 'translate' }),
    stage_line_forward: async args => ui.messageAction({ ...args, action: 'forward' }),
    prepare_line_forward: args => forwards().prepare(args),
    confirm_line_forward: args => forwards().confirm(args),
    verify_line_forward: args => forwards().verify(args),
    cancel_line_forward: args => forwards().cancel(args),
    send_message_manual: args => sendText(args, false),
    send_message_auto: args => sendText(args, true),
    send_file_manual: async args => {
      requireChat(args.chatName);
      requireText(args.filePath, 'filePath', 4096);
      if (!path.isAbsolute(args.filePath)) throw new LineToolError('LINE_INVALID_ARGUMENT', 'filePath must be absolute.');
      const stat = await fs.stat(args.filePath);
      if (!stat.isFile()) throw new LineToolError('LINE_INVALID_ARGUMENT', 'filePath must name a regular file.');
      const result = await ui.stageFile({ chatName: args.chatName, filePath: args.filePath, optionalMessage: args.optionalMessage || '' });
      if (result?.success !== true) throw new LineToolError('LINE_STAGE_FAILED', result?.error || 'File staging failed.');
      return { success: true, chatName: args.chatName, filePath: args.filePath, staged: true, sent: false, requiresOpenApproval: true, deliveryVerified: false, timestamp: now().toISOString() };
    },
  };

  async function sendText(args, autoSend) {
    requireChat(args.chatName);
    requireText(args.message, 'message');
    const result = await ui.sendText({ chatName: args.chatName, message: args.message,
      autoSend, ...(args.chatType === 'group' ? { chatType: 'group' } : {}), ...(args.idempotencyKey ? {idempotencyKey:args.idempotencyKey} : {}),
      ...(args.expectedChatRef ? { expectedChatRef: args.expectedChatRef } : {}),
      ...(args.expectedOwnSenderRef ? { expectedOwnSenderRef: args.expectedOwnSenderRef } : {}) });
    if (result?.success !== true) throw new LineToolError('LINE_SEND_OR_STAGE_FAILED', result?.error || 'Text operation failed; inspect LINE before retrying.', { operationMayHaveCompleted: autoSend });
    if(result.status) return {...result, mentionVerified:false, timestamp:now().toISOString(),
      note:autoSend?(result.reused?'Reused the earlier operation; no new message was dispatched by this call. Recipient delivery and read state are not established.':'New own message verified in local DB. Recipient delivery and read state are not established.'):'Draft staged. Nothing sent.'};
    return { success: true, chatName: args.chatName, message: args.message,
      ...(args.chatType === 'group' ? {chatType:'group'} : {}),
      staged: !autoSend, sendDispatched: autoSend, deliveryVerified: false, mentionVerified: false,
      ...(typeof result.receiptAvailable === 'boolean' ? {receiptAvailable:result.receiptAvailable} : {}),
      timestamp: now().toISOString(), note: autoSend ? 'Dispatch completed. Verify the chat before claiming delivery or retrying.' : 'Draft staged. Nothing sent.' };
  }

  for (const size of ['short', 'default', 'long']) {
    handlers[`get_line_chatroom_history_${size}`] = async args => {
      const data = await readMessages(args, size);
      return { ...data, date: args.date ?? null, messageLimit: args.messageLimit ?? 100, history: formatLineHistory(data.messages, { format: 'txt' }), chatRoomUpdatedAt: data.retrievedAt };
    };
  }

  return {
    tools: ACTIVE_TOOL_DESCRIPTORS,
    handles: name => Object.hasOwn(handlers, name),
    async call(name, args = {}) {
      try {
        if (!Object.hasOwn(handlers, name)) throw new LineToolError('LINE_UNKNOWN_TOOL', `Unknown LINE extension tool: ${name}`);
        let validate = validators.get(name);
        if (!validate) { validate = ajv.compile(schemas.get(name)); validators.set(name, validate); }
        if (!validate(args)) throw new LineToolError('LINE_INVALID_ARGUMENT', ajv.errorsText(validate.errors));
        const value = await handlers[name](args);
        const { images = [], content = [], ...body } = value;
        return toolResult(body, [...images, ...(Array.isArray(content) ? content : [])]);
      } catch (error) { return toolError(error); }
    },
  };
}
