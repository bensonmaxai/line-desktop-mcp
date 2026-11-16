import { randomBytes } from 'node:crypto';

import {
  elementTarget,
  snapshot,
  withCuaClient,
} from './cua-line-client.mjs';
import {
  LineToolError,
  requireChat,
  requireChoice,
  requireInteger,
  requireText,
} from './line-runtime.mjs';
import {
  findOcrLabel,
  fingerprintLineRegion,
  purepngDimensions,
  recognizeLineImage,
} from './line-ocr.mjs';
import {
  requireReplySource,
  requireReplySourceSelection,
  sameReplySource,
  selectAccessibleReplyBubble,
} from './line-quote-binding.mjs';
import { withLineOperation } from '../automation/line-operation-lock.mjs';
import { withLineUiMetrics } from './line-ui-metrics.mjs';
import { readLocalLineGuiChatIdentity, readLocalLineGuiCandidateIdentity,
  readLocalLineGuiGroupCandidateIdentity, readLocalLineMessages, readKeepOpenIdentity } from './line-local-reader.mjs';
import { openKeepChat } from './line-keep-open.mjs';
import { DirectChatProof } from './line-direct-proof.mjs';
import { GroupChatProof } from './line-group-proof.mjs';
import { sendPlainText, openExactChat, readPlainIdentity } from './line-plain-send.mjs';
import { prepareBoundDirect, confirmBoundDirectContext } from './line-bound-direct.mjs';
import { searchDirectCandidate, selectDirectCandidate, hasDirectGeometrySnapshot } from './line-direct-navigation.mjs';
import { searchDirectCandidate as searchGroupCandidate,
  selectDirectCandidate as selectGroupCandidate } from './line-group-navigation.mjs';

/** The driver-reported application name used to bind every LINE window. */
export const LINE_APP_NAME = 'LINE.exe';

/** Public, intentionally small feature vocabulary. */
export const LINE_FEATURES = Object.freeze([
  'search',
  'notes',
  'stickers',
  'attachment',
  'albums',
  'polls',
  'media',
  'photos',
  'files',
  'links',
]);

const ACTIONS = Object.freeze(['copy', 'reply', 'translate', 'forward']);
const REPLY_CHAT_TYPES = Object.freeze(['direct', 'group']);
const GROUP_FRAME_ATTEMPTS = 8;
const GROUP_FRAME_DEADLINE_MS = 15_000;
const GROUP_FRAME_DELAY_MS = 600;
const GROUP_CONTEXT_DELAYS_MS = Object.freeze([350, 650, 450, 750, 550, 850, 600]);

// These are fixed labels and shortcuts documented in the local LINE runbook.
// They are exact alternatives for localized LINE Desktop builds, never
// substring searches or visual guesses.
const FEATURE_SPECS = Object.freeze({
  search: {
    kind: 'main-header-button',
    labels: ['搜尋', 'Search'],
    allowEdit: true,
  },
  notes: {
    kind: 'shortcut',
    keys: ['ctrl', 'n'],
    labels: ['記事本', 'Notes'],
  },
  stickers: {
    kind: 'shortcut',
    keys: ['ctrl', 'e'],
    labels: ['貼圖', 'Stickers'],
  },
  attachment: {
    kind: 'shortcut',
    keys: ['ctrl', 'o'],
    labels: ['開啟', 'Open'],
  },
  albums: { kind: 'menu', labels: ['相簿', 'Albums'] },
  polls: { kind: 'menu', labels: ['投票', 'Polls'] },
  media: {
    kind: 'menu',
    labels: ['照片及影片', '照片・影片', 'Photos & videos'],
  },
  photos: {
    kind: 'menu',
    labels: ['照片及影片', '照片・影片', 'Photos & videos'],
  },
  files: { kind: 'menu', labels: ['檔案', 'Files'] },
  links: { kind: 'menu', labels: ['連結', 'Links'] },
});

const MORE_LABELS = Object.freeze(['更多', 'More']);
const ACTION_LABELS = Object.freeze({
  copy: ['複製', 'Copy'],
  reply: ['回覆', 'Reply'],
  translate: ['翻譯', 'Translate'],
  forward: ['轉傳', 'Forward'],
});
const TRANSLATION_LABELS = Object.freeze(['翻譯', 'Translation']);
const FORWARD_LABELS = Object.freeze(['轉傳', 'Forward']);

const HEADER_MARKERS = new Set([
  'header',
  'chat-header',
  'chatheader',
  'chat-pane-header',
  'chatpaneheader',
  'titlebar',
  'title-bar',
]);
const COMPOSER_MARKERS = new Set([
  'composer',
  'chat-composer',
  'chatcomposer',
  'message-composer',
  'messagecomposer',
  'message-input',
  'messageinput',
]);
const MESSAGE_MARKERS = new Set([
  'message',
  'chat-message',
  'chatmessage',
  'message-bubble',
  'messagebubble',
]);
const QUOTE_MARKERS = new Set([
  'reply-quote',
  'replyquote',
  'quoted-message',
  'quotedmessage',
  'reply-context',
  'replycontext',
]);
const MENU_ITEM_MARKERS = new Set(['menuitem', 'menu-item']);
const BUTTON_MARKERS = new Set(['button', 'menu-button', 'menubutton']);
const WINDOW_ROOT_MARKERS = new Set(['window', 'application']);
const TRANSLATION_MARKERS = new Set([
  'translation',
  'translation-result',
  'translationresult',
  'translated-message',
  'translatedmessage',
]);
const FORWARD_DIALOG_MARKERS = new Set([
  'forward-dialog',
  'forwarddialog',
  'forward-recipient-dialog',
  'forwardrecipientdialog',
]);
const RECIPIENT_MARKERS = new Set([
  'recipient-selector',
  'recipientselector',
  'recipient-list',
  'recipientlist',
]);
const SURFACE_MARKERS = new Set([
  'dialog',
  'window',
  'pane',
  'header',
  'heading',
  'tab',
]);
const MODAL_MARKERS = new Set(['dialog', 'modal', 'modal-dialog', 'modaldialog']);
const BACKGROUND_DELIVERY_TOOLS = new Set(['click', 'right_click', 'hotkey', 'press_key']);
const FEATURE_DELIVERY_MODES = Object.freeze(['background', 'foreground']);
const VISUAL_CONFIRMATION_TTL_MS = 120_000;

/**
 * Semantic, fail-closed adapter for the parts of LINE Desktop that expose a
 * stable CUA accessibility contract. It deliberately does not infer a chat
 * from a sidebar/search result or fall back to pixels/foreground input.
 */
export class LineUi {
  constructor({
    automation,
    withClient = withCuaClient,
    readChatIdentity = readLocalLineGuiChatIdentity,
    readNamedIdentity = readPlainIdentity,
    readKeepIdentity = readKeepOpenIdentity,
    readDirectCandidate = readLocalLineGuiCandidateIdentity,
    readDirectMessages = readLocalLineMessages,
    readGroupCandidate = readLocalLineGuiGroupCandidateIdentity,
    readGroupMessages = readLocalLineMessages,
    runOperation = withLineOperation,
    recognizeImage = recognizeLineImage,
    findImageLabel = findOcrLabel,
    fingerprintRegion = fingerprintLineRegion,
    imageDimensions = purepngDimensions,
    randomToken = () => randomBytes(24).toString('base64url'),
    now = () => Date.now(),
  } = {}) {
    if (!automation || typeof automation !== 'object') {
      throw new TypeError('automation must be the existing LINE automation object.');
    }
    if (typeof withClient !== 'function') {
      throw new TypeError('withClient must be a function.');
    }
    if (typeof runOperation !== 'function') {
      throw new TypeError('runOperation must be a function.');
    }
    if (typeof readChatIdentity !== 'function') throw new TypeError('readChatIdentity must be a function.');
    if (typeof recognizeImage !== 'function' || typeof findImageLabel !== 'function'
      || typeof fingerprintRegion !== 'function' || typeof imageDimensions !== 'function'
      || typeof randomToken !== 'function' || typeof now !== 'function') {
      throw new TypeError('OCR helpers must be functions.');
    }
    this.automation = automation;
    this.withClient = withClient;
    this.readChatIdentity = readChatIdentity;
    this.readNamedIdentity = readNamedIdentity;
    this.readKeepIdentity = readKeepIdentity;
    this.runOperation = runOperation;
    this.ocr = { recognizeImage, findImageLabel, imageDimensions };
    this.visual = {
      fingerprintRegion,
      imageDimensions,
      randomToken,
      now,
      pending: new Map(),
      confirmed: new Map(),
      pendingReplySources: new Map(),
      confirmedReplySources: new Map(),
    };
    this.readDirectCandidate = readDirectCandidate;
    this.readDirectMessages = readDirectMessages;
    this.readGroupCandidate = readGroupCandidate;
    this.readGroupMessages = readGroupMessages;
    this.direct = new DirectChatProof({
      readCandidate: readDirectCandidate, readMessages: readDirectMessages, now, randomToken,
      search: chatName => this.withClient(api => searchDirectCandidate(api, this.automation, chatName, this.visual)),
      select: record => this.withClient(async api => {
        const selected = await selectDirectCandidate(api, this.automation, record, this.visual);
        return { ...selected, ...await captureDirectProofView(selected.state, selected.window, this.visual, 'header') };
      }),
      capture: (record, mode) => this.withClient(async api => {
        const fresh = await inspectExactMainWindow(api, record.target);
        const view = await captureDirectProofView(fresh.state, fresh.window, this.visual, mode);
        if (!sameHeaderFingerprint(record.headerFingerprint, view.headerFingerprint)
          || (mode === 'verify' && !sameHeaderFingerprint(record.bodyFingerprint, view.bodyFingerprint))) {
          throw new LineToolError('LINE_DIRECT_VIEW_CHANGED', 'The observed LINE view changed. Request a fresh check.', {sendDispatched:false});
        }
        return {target:fresh.target, window:fresh.window, ...view};
      }),
    });
    this.group = new GroupChatProof({
      readCandidate: readGroupCandidate, readMessages: readGroupMessages, now, randomToken,
      search: chatName => this.withClient(api => searchGroupCandidate(api, this.automation, chatName, this.visual)),
      select: record => this.withClient(async api => {
        const selected = await selectGroupCandidate(api, this.automation, record, this.visual);
        return { ...selected, ...await captureDirectProofView(selected.state, selected.window, this.visual, 'header') };
      }),
      capture: (record, mode, checkLocal) => this.withClient(async api => {
        if (mode === 'verify') {
          const matched = await reacquireExactGroupFrame(api, record, this.visual);
          return {target:matched.target, window:matched.window,
            headerFingerprint:matched.headerFingerprint, bodyFingerprint:matched.bodyFingerprint,
            capturedAt:matched.capturedAt};
        }
        if (mode === 'context') {
          return captureRecurringGroupContextFrame(api, record, this.visual, checkLocal);
        }
        const fresh = await inspectExactMainWindow(api, record.target);
        const view = await captureDirectProofView(fresh.state, fresh.window, this.visual, mode);
        if (!sameHeaderFingerprint(record.headerFingerprint, view.headerFingerprint)) {
          throw new LineToolError('LINE_GROUP_VIEW_CHANGED', 'The observed group view changed. Request a fresh check.', {sendDispatched:false});
        }
        return {target:fresh.target, window:fresh.window, ...view};
      }),
    });
  }

  async prepareDirectChat(args) {
    return this.#run('ui-direct-chat-proof', () => this.direct.dispatch(args));
  }

  async prepareGroupChat(args) {
    return this.#run('ui-group-chat-proof', () => this.group.dispatch(args));
  }

  async getStatus() {
    return this.#run('ui-get-status', async () => this.withClient(async api => {
      const windows = await listLineWindows(api);
      const visibleWindows = windows.filter(isVisibleLineWindow);
      return {
        success: true,
        appName: LINE_APP_NAME,
        lineWindowCount: windows.length,
        visibleLineWindowCount: visibleWindows.length,
        lineTitledWindowCount: visibleWindows.filter(window => window.title === 'LINE').length,
        capabilities: capabilityMetadata(api),
        backendVersion: api?.serverVersion ?? null,
      };
    }));
  }

  async openChat({ chatName, chatType, expectedChatRef, expectedOwnSenderRef } = {}) {
    requireChat(chatName);
    return this.#run('ui-open-chat', async () => {
      const deadline = Date.now() + 30000;
      const check = () => { if (Date.now() >= deadline) throw new LineToolError('LINE_OPEN_TIMEOUT', 'Opening the named chat timed out.'); };
      if (chatName === 'Keep筆記') {
        if ((chatType !== undefined && !['auto', 'direct'].includes(chatType))
            || expectedChatRef !== undefined || expectedOwnSenderRef !== undefined) {
          throw new LineToolError('LINE_INVALID_ARGUMENT', 'Keep memo opening requires an unbound direct or auto request.');
        }
        if (await this.readKeepIdentity() !== true) {
          throw new LineToolError('LINE_CHAT_IDENTITY_UNVERIFIED', 'The self memo identity could not be verified.');
        }
        return this.withClient(async rawApi => {
          const api = { ...rawApi, call(name, args) { check(); return rawApi.call(name, args); } };
          await openKeepChat(this, api, check);
          return { success: true, chatName, verification: 'exact-top-level-window-title', chatType: 'direct' };
        }, { deadline });
      }
      const identity = await this.readNamedIdentity({ chatName,
        ...(chatType===undefined?{}:{chatType}),
        ...(expectedChatRef===undefined?{}:{expectedChatRef}),
        ...(expectedOwnSenderRef===undefined?{}:{expectedOwnSenderRef}) });
      return this.withClient(async rawApi => {
        const api = { ...rawApi, call(name, args) { check(); return rawApi.call(name, args); } };
        const inspected = await openExactChat(this, api, chatName, identity.kind, check);
        return { ...chatResult(chatName, inspected), chatType: identity.kind, chatRef: identity.chatRef,
          ...(identity.ownSenderRef===undefined?{}:{ownSenderRef:identity.ownSenderRef,
            uiIdentityVerified:false,requiresSendContext:identity.requiresSendContext}) };
      }, { deadline });
    });
  }

  async getState({ chatName, includeScreenshot = false } = {}) {
    requireChat(chatName);
    requireBoolean(includeScreenshot, 'includeScreenshot');
    return this.#run('ui-get-state', async () => this.withClient(async api => {
      const resolved = await this.#findChatState(api, chatName, { screenshot: includeScreenshot });
      if (resolved.pending) return resolved.pending;
      const inspected = resolved.inspected;
      return {
        ...chatResult(chatName, inspected),
        raw: withoutImages(inspected.state),
        ...(includeScreenshot ? { images: Array.isArray(inspected.state.images) ? inspected.state.images : [] } : {}),
      };
    }));
  }

  async confirmChat({ chatName, token, observedHeader } = {}) {
    requireChat(chatName);
    requireText(token, 'token', 256);
    requireText(observedHeader, 'observedHeader', 240);
    const headerMatch = chatHeaderTextMatch(observedHeader, chatName);
    if (!headerMatch) {
      throw new LineToolError(
        'LINE_CHAT_CONFIRMATION_INVALID',
        'observedHeader must be the exact requested chat header, optionally followed by one member-count suffix.',
      );
    }
    return this.#run('ui-confirm-chat-view', async () => this.withClient(async api => {
      this.#pruneVisualRecords();
      const pending = this.visual.pending.get(token);
      if (!pending || pending.chatName !== chatName) {
        throw new LineToolError('LINE_CHAT_CONFIRMATION_INVALID', 'The visual chat-confirmation token is unknown, expired, or belongs to another chat.');
      }
      const identity = await this.#requireChatIdentity(chatName);
      if (!sameLocalChatIdentity(pending.identity, identity)) {
        this.visual.pending.delete(token);
        throw new LineToolError('LINE_CHAT_CONFIRMATION_STALE', 'The local chat identity changed. Request a new header view.');
      }
      const observedKind = headerMatch.groupMemberCount === undefined ? 'direct' : 'group';
      if (observedKind !== identity.kind) {
        throw new LineToolError('LINE_CHAT_CONFIRMATION_INVALID', 'The observed header kind does not match the unique local chat identity.');
      }
      const fresh = await inspectExactMainWindow(api, pending.target);
      const fingerprint = await captureHeaderFingerprint(fresh.state, fresh.window, this.visual, { includeImage: false });
      if (!fingerprint || !sameHeaderFingerprint(pending.fingerprint, fingerprint)) {
        throw new LineToolError(
          'LINE_CHAT_CONFIRMATION_STALE',
          'The active LINE header pixels changed before confirmation. Request a new header view instead of guessing.',
        );
      }
      this.visual.pending.delete(token);
      this.visual.confirmed.set(chatName, {
        chatName,
        identity,
        target: fresh.target,
        fingerprint,
        chatType: identity.kind,
        expiresAt: this.#expiresAt(),
      });
      return {
        success: true,
        chatName,
        verification: 'caller-confirmed-fresh-header-crop',
        confidence: 'medium',
        expiresAt: new Date(this.visual.confirmed.get(chatName).expiresAt).toISOString(),
      };
    }));
  }

  /**
   * Return one fresh, verified-chat screenshot for a caller to visually locate
   * a reply source. This does not claim that the local sourceRef is present in
   * LINE UI, and does not choose or click a bubble.
   */
  async getReplySourceTarget({ chatName, chatType, chatRef, source } = {}) {
    requireChat(chatName);
    requireChoice(chatType, 'chatType', REPLY_CHAT_TYPES);
    if (typeof chatRef !== 'string' || !/^chat:[0-9a-f]{24}$/u.test(chatRef)) {
      throw new LineToolError('LINE_INVALID_ARGUMENT', 'The reply source must include its scoped local chatRef.');
    }
    const expectedSource = requireReplySource(source);
    return this.#run('ui-get-reply-source-target', async () => this.#withVerifiedChat(
      chatName,
      async (api, inspected) => {
        if (inspected.identity.chatRef !== chatRef) {
          throw new LineToolError('LINE_REPLY_SOURCE_STALE', 'The message source and current local chat identity differ. No reply action was taken.');
        }
        const guard = this.#chatGuard(chatName, inspected, { expectedChatType: chatType });
        const state = await snapshot(api, inspected.target, { screenshot: true });
        await assertChatGuard(api, inspected.target, state, guard);
        return this.#createPendingReplySourceTarget(chatName, expectedSource, inspected, guard, state);
      },
      { expectedChatType: chatType },
    ));
  }

  /** Internal forward adapter entry point: retain the existing unique local
   * chat identity and fresh UI guard without exposing private proof records. */
  async withForwardSourceChat(binding, callback) {
    const source = binding?.source;
    requireChat(source?.chatName);
    requireChoice(source?.chatType, 'chatType', REPLY_CHAT_TYPES);
    if (typeof callback !== 'function') throw new TypeError('callback must be a function.');
    return this.#withVerifiedChat(source.chatName, async (api, inspected) => {
      if (inspected.identity.chatRef !== source.chatRef) {
        throw new LineToolError('LINE_FORWARD_SOURCE_STALE', 'The source chat identity changed. No forwarding action was taken.');
      }
      let current = inspected;
      if (inspected.proof.kind === 'exact-top-level-window-title') {
        await activateForegroundFeature(this.automation, inspected);
        const refreshed = await inspectDetachedChat(api, source.chatName, { screenshot: true });
        if (!refreshed || !sameTarget(refreshed.target, inspected.target)) {
          throw new LineToolError('LINE_FORWARD_SOURCE_STALE', 'The exact detached source chat changed after activation.');
        }
        current = { ...refreshed, identity: inspected.identity,
          proof: { ...refreshed.proof, chatType: inspected.identity.kind } };
      }
      const guard = this.#chatGuard(source.chatName, current, { expectedChatType: source.chatType });
      const state = await snapshot(api, current.target, { screenshot: true });
      await assertChatGuard(api, current.target, state, guard);
      return callback(api, { ...current, state, guard });
    }, { expectedChatType: source.chatType });
  }

  /**
   * Bind a caller-observed source identity to a single point and rectangle in
   * the previously returned screenshot. Both the header and source crop must
   * still match a fresh screenshot before the token can be used once.
   */
  async confirmReplySourceTarget({
    chatName,
    token,
    observedSource,
    sourceRect,
    sourcePoint,
  } = {}) {
    requireChat(chatName);
    requireText(token, 'token', 256);
    const observed = requireReplySource(observedSource, 'observedSource');
    return this.#run('ui-confirm-reply-source-target', async () => this.withClient(async api => {
      this.#pruneVisualRecords();
      const pending = this.visual.pendingReplySources.get(token);
      if (!pending || pending.chatName !== chatName) {
        throw new LineToolError('LINE_REPLY_SOURCE_CONFIRMATION_INVALID', 'The reply-source token is unknown, expired, or belongs to another chat.');
      }
      const identity = await this.#requireChatIdentity(chatName);
      if (!sameLocalChatIdentity(pending.identity, identity)) {
        this.visual.pendingReplySources.delete(token);
        throw new LineToolError('LINE_REPLY_SOURCE_STALE', 'The local chat identity changed before source confirmation. Request a fresh source view.');
      }
      assertReplySourceChatTypeBinding(pending);
      if (!sameReplySource(pending.source, observed)) {
        throw new LineToolError(
          'LINE_REPLY_SOURCE_CONFIRMATION_INVALID',
          'The observed reply source must exactly equal the source attached to this screenshot token.',
        );
      }

      const cropSelection = requireReplySourceSelection(
        { sourceRect, sourcePoint },
        { imageSize: pending.cropBounds, messageBounds: pending.cropBounds },
      );
      // Public coordinates belong to the returned crop. Keep the original
      // screenshot coordinates private and translate exactly once at this edge.
      const selection = {
        sourceRect: {
          ...cropSelection.sourceRect,
          x: cropSelection.sourceRect.x + pending.messageBounds.x,
          y: cropSelection.sourceRect.y + pending.messageBounds.y,
        },
        sourcePoint: {
          x: cropSelection.sourcePoint.x + pending.messageBounds.x,
          y: cropSelection.sourcePoint.y + pending.messageBounds.y,
        },
      };
      const originalFingerprint = await captureReplySourceFingerprint(
        pending.image,
        selection.sourceRect,
        this.visual,
      );
      if (!originalFingerprint) {
        this.visual.pendingReplySources.delete(token);
        throw new LineToolError('LINE_REPLY_SOURCE_UNVERIFIED', 'The reply-source screenshot crop could not be safely fingerprinted. Request a new source view.');
      }

      let current;
      try {
        if (pending.guard.kind === 'detached-title') {
          current = await inspectDetachedChat(api, chatName);
          if (!current || !sameTarget(current.target, pending.target)) {
            throw new LineToolError('LINE_REPLY_SOURCE_STALE', 'The exact titled reply-source window changed. Request a fresh source view.');
          }
        } else {
          current = await inspectExactMainWindow(api, pending.target);
        }
      } catch (error) {
        this.visual.pendingReplySources.delete(token);
        throw error;
      }
      const freshState = await snapshot(api, current.target, { screenshot: true });
      await assertChatGuard(api, current.target, freshState, pending.guard);
      const freshView = replySourceVisualView(freshState, current.window, pending.guard, this.visual);
      if (!freshView || !sameRegion(pending.messageBounds, freshView.messageBounds)) {
        this.visual.pendingReplySources.delete(token);
        throw new LineToolError('LINE_REPLY_SOURCE_STALE', 'The LINE message area changed before reply-source confirmation. Request a fresh source view.');
      }
      // Re-validate against the fresh message area before comparing pixels.
      requireReplySourceSelection(selection, { imageSize: freshView.imageBounds, messageBounds: freshView.messageBounds });
      const freshFingerprint = await captureReplySourceFingerprint(
        freshView.image,
        selection.sourceRect,
        this.visual,
      );
      if (!freshFingerprint || !sameReplySourceFingerprint(originalFingerprint, freshFingerprint)) {
        this.visual.pendingReplySources.delete(token);
        throw new LineToolError('LINE_REPLY_SOURCE_STALE', 'The selected LINE source pixels changed before confirmation. Request a fresh source view.');
      }

      // Accessibility can strengthen a visually selected point when it exposes
      // message bubbles. Its absence is normal for the current custom-drawn UI;
      // it never downgrades the caller-confirmed visual source to a text match.
      selectAccessibleReplyBubble(
        accessibleReplyMessageCandidates(freshState, pending.source.text, freshView),
        selection.sourcePoint,
      );

      this.visual.pendingReplySources.delete(token);
      const expiresAt = this.#expiresAt();
      this.visual.confirmedReplySources.set(token, {
        chatName,
        chatType: pending.chatType,
        identity,
        source: pending.source,
        target: current.target,
        guard: pending.guard,
        messageBounds: freshView.messageBounds,
        sourceRect: selection.sourceRect,
        sourcePoint: selection.sourcePoint,
        fingerprint: freshFingerprint,
        expiresAt,
      });
      return {
        success: true,
        chatName,
        replySourceTarget: {
          token,
          expiresAt: new Date(expiresAt).toISOString(),
          sourceRect: cropSelection.sourceRect,
          sourcePoint: cropSelection.sourcePoint,
        },
        localSourceRef: pending.source.sourceRef,
        uiSourceRefVerified: false,
        sourceIdentityVerification: 'caller-confirmed-fresh-visual-source-region',
        confidence: 'medium',
      };
    }));
  }

  async getDraft({ chatName, chatType = 'direct' } = {}) {
    requireChat(chatName);
    requireChoice(chatType, 'chatType', REPLY_CHAT_TYPES);
    return this.#run('ui-get-draft', async () => this.#withVerifiedChat(
      chatName,
      async (api, inspected) => {
        const { composer } = await readComposer(
          api,
          inspected.target,
          composerOptions(inspected, this.#chatGuard(chatName, inspected)),
        );
        return {
          ...chatResult(chatName, inspected),
          ...(chatType === 'group' ? { chatType: 'group' } : {}),
          draft: composer.value,
          verification: {
            chat: inspected.proof.kind,
            draft: composer.verification,
          },
        };
      },
      { expectedChatType: chatType },
    ));
  }

  async setDraft({ chatName, message, expectedDraft } = {}) {
    requireChat(chatName);
    requireText(message, 'message', 10_000);
    requireOptionalDraft(expectedDraft, 'expectedDraft');
    return this.#run('ui-set-draft', async () => this.#withVerifiedChat(
      chatName,
      async (api, inspected) => {
        const composerConfig = composerOptions(inspected, this.#chatGuard(chatName, inspected));
        const write = await writeDraft(
          api,
          inspected.target,
          message,
          expectedDraft,
          composerConfig,
        );
        return {
          ...chatResult(chatName, inspected),
          changed: write.changed,
          verification: {
            chat: inspected.proof.kind,
            draft: write.changed ? write.composerVerification : 'already-matched',
          },
          ...(write.raw ? { raw: withoutImages(write.raw) } : {}),
        };
      },
    ));
  }

  async clearDraft({ chatName, expectedDraft } = {}) {
    requireChat(chatName);
    requireText(expectedDraft, 'expectedDraft', 10_000, { empty: true });
    return this.#run('ui-clear-draft', async () => this.#withVerifiedChat(
      chatName,
      async (api, inspected) => {
        const composerConfig = composerOptions(inspected, this.#chatGuard(chatName, inspected));
        const write = await writeDraft(
          api,
          inspected.target,
          '',
          expectedDraft,
          composerConfig,
        );
        return {
          ...chatResult(chatName, inspected),
          cleared: write.changed,
          verification: {
            chat: inspected.proof.kind,
            draft: write.changed ? write.composerVerification : 'already-empty',
          },
          ...(write.raw ? { raw: withoutImages(write.raw) } : {}),
        };
      },
    ));
  }

  async openFeature({ chatName, feature, deliveryMode = 'background' } = {}) {
    requireChat(chatName);
    requireChoice(feature, 'feature', LINE_FEATURES);
    requireChoice(deliveryMode, 'deliveryMode', FEATURE_DELIVERY_MODES);
    return this.#run('ui-open-feature', async () => this.#withVerifiedChat(
      chatName,
      async (api, inspected) => {
        // Foreground delivery is an explicit caller choice. The guarded
        // facade activates the exact LINE target; openFeature immediately
        // rechecks the same PID/header before it can navigate anything.
        if (deliveryMode === 'foreground') await activateForegroundFeature(this.automation, inspected);
        return openFeature(
          api,
          inspected,
          chatName,
          feature,
          this.ocr,
          this.visual.imageDimensions,
          deliveryMode,
          this.#chatGuard(chatName, inspected),
        );
      },
    ));
  }

  async messageAction({ chatName, messageText, action, replyText, source, sourceToken } = {}) {
    requireChat(chatName);
    requireText(messageText, 'messageText', 10_000);
    requireChoice(action, 'action', ACTIONS);
    if (replyText !== undefined) {
      if (action !== 'reply') {
        throw new LineToolError('LINE_INVALID_ARGUMENT', 'replyText is only valid for a reply action.');
      }
      requireText(replyText, 'replyText', 10_000);
    }
    const hasReplySource = source !== undefined || sourceToken !== undefined;
    let expectedSource;
    if (hasReplySource) {
      if (action !== 'reply') {
        throw new LineToolError('LINE_INVALID_ARGUMENT', 'source and sourceToken are only valid for a reply action.');
      }
      expectedSource = requireReplySource(source);
      requireText(sourceToken, 'sourceToken', 256);
      if (expectedSource.text !== messageText) {
        throw new LineToolError('LINE_INVALID_ARGUMENT', 'messageText must exactly equal source.text for a visually bound reply.');
      }
    }

    return this.#run('ui-message-action', async () => {
      const expectedChatType = expectedSource
        ? this.#peekConfirmedReplySourceChatType(chatName, expectedSource, sourceToken)
        : undefined;
      return this.#withVerifiedChat(
        chatName,
        async (api, inspected) => {
          let guard = this.#chatGuard(chatName, inspected);
          const sourceBinding = expectedSource
            ? this.#takeConfirmedReplySource(chatName, expectedSource, sourceToken, inspected)
            : undefined;
          if (sourceBinding) guard = sourceBinding.guard;
          return runMessageAction(
            api,
            inspected,
            chatName,
            messageText,
            action,
            replyText,
            composerOptions(inspected, guard),
            this.ocr,
            this.visual,
            sourceBinding,
          );
        },
        { expectedChatType },
      );
    });
  }

  async confirmSendContext(args) {
    return this.#run('ui-confirm-send-context', () => confirmBoundDirectContext(this,args));
  }

  async prepareSendTarget(args) {
    return this.#run('ui-prepare-send-target', () => prepareBoundDirect(this,args));
  }

  async sendText({ chatName, message, autoSend = false, chatType = 'direct', idempotencyKey, expectedChatRef, expectedOwnSenderRef } = {}) {
    requireChat(chatName);
    requireText(message, 'message', 10_000);
    requireBoolean(autoSend, 'autoSend');
    requireChoice(chatType, 'chatType', REPLY_CHAT_TYPES);
    if(idempotencyKey!==undefined) requireText(idempotencyKey,'idempotencyKey',160);
    if(expectedChatRef!==undefined && !/^chat:[0-9a-f]{24}$/u.test(expectedChatRef)) throw new LineToolError('LINE_INVALID_ARGUMENT', 'expectedChatRef must be an opaque chat reference.');
    if(expectedOwnSenderRef!==undefined && !/^sender:[0-9a-f]{24}$/u.test(expectedOwnSenderRef)) throw new LineToolError('LINE_INVALID_ARGUMENT', 'expectedOwnSenderRef must be an opaque sender reference.');
    return this.#run('ui-send-text', () => sendPlainText(this, { chatName, message, autoSend, chatType, idempotencyKey, expectedChatRef, expectedOwnSenderRef }));
  }

  async readLegacyHistory({ chatName, pageUpTimes = 10 } = {}) {
    requireChat(chatName);
    requireInteger(pageUpTimes, 'pageUpTimes', 1, 50);
    return this.#run('ui-read-legacy-history', async () => this.#withVerifiedChat(
      chatName,
      async (api, inspected) => {
        // The raw AHK history helpers acquire the unique visible top-level
        // window titled LINE. They cannot bind a detached chat window.
        if (inspected.window?.title !== 'LINE') {
          throw new LineToolError(
            'LINE_HISTORY_TARGET_UNVERIFIED',
            'Legacy history reading requires an exactly verified main LINE window; the detached chat was left unchanged.',
            { operationMayHaveCompleted: false },
          );
        }
        const inner = this.automation?.automation;
        if (typeof inner?.pageUp !== 'function' || typeof inner?.copyAllChatToClipboard !== 'function') {
          throw new LineToolError(
            'LINE_AUTOMATION_UNAVAILABLE',
            'The guarded inner LINE history helpers are unavailable.',
            { operationMayHaveCompleted: false },
          );
        }

        const guard = this.#chatGuard(chatName, inspected);
        await assertFreshChatGuard(api, inspected.target, guard);
        await inner.pageUp.call(inner, pageUpTimes);
        // This fresh proof is both the post-page check and the immediate
        // pre-copy check. Drift here prevents clipboard access entirely.
        await assertFreshChatGuard(api, inspected.target, guard);
        const history = await inner.copyAllChatToClipboard.call(inner);
        // Never return copied text unless the same chat still proves exact.
        await assertFreshChatGuard(api, inspected.target, guard);
        return history;
      },
    ));
  }

  async stageFile({ chatName, filePath, optionalMessage } = {}) {
    requireChat(chatName);
    requireText(filePath, 'filePath', 4096);
    if (optionalMessage !== undefined) requireText(optionalMessage, 'optionalMessage', 10_000, { empty: true });
    return this.#run('ui-stage-file', async () => this.#withVerifiedChat(
      chatName,
      async (api, inspected) => stageFile(
        api,
        this.automation,
        inspected,
        chatName,
        filePath,
        optionalMessage,
        composerOptions(inspected, this.#chatGuard(chatName, inspected)),
      ),
    ));
  }

  async #run(kind, fn) {
    return withLineUiMetrics(() => this.runOperation(kind, fn));
  }

  async #withVerifiedChat(chatName, callback, { screenshot = false, expectedChatType } = {}) {
    return this.withClient(async api => {
      const inspected = await this.#findVerifiedChat(api, chatName, { screenshot, expectedChatType });
      return callback(api, inspected);
    });
  }

  async #findVerifiedChat(api, chatName, { screenshot = false, expectedChatType } = {}) {
    const initialWindows = await listLineWindows(api);
    const identity = await this.#identityForWindow(chatName, initialWindows);
    if (expectedChatType !== undefined && identity.kind !== expectedChatType) {
      throw new LineToolError('LINE_REPLY_SOURCE_CHAT_TYPE_MISMATCH', 'The requested reply chat kind differs from the unique local chat identity.');
    }
    // Establish uniqueness before inspecting chat content or delivering input.
    const alreadyOpen = await inspectDetachedChat(api, chatName, { screenshot, lineWindows: initialWindows });
    if (alreadyOpen) {
      return { ...alreadyOpen, identity, proof: { ...alreadyOpen.proof, chatType: identity.kind } };
    }

    const candidate = await inspectMainChat(api, chatName, { screenshot, ocr: this.ocr, lineWindows: initialWindows });
    const accepted = await this.#acceptMainCandidate(api, chatName, candidate, identity);
    if (accepted) {
      assertReplySourceChatType(accepted, identity.kind);
      return accepted;
    }
    // A reply-source type comes from the freshly scoped local reader.
    if (expectedChatType !== undefined) assertReplySourceChatType(candidate, expectedChatType);

    throw new LineToolError(
      'LINE_CHAT_UNVERIFIED',
      'Open the exact authorized chat using a guided LINE UI workflow, then request a header view if needed. Unverified first-result navigation is disabled.',
      candidate ? chatProofDetails(candidate.state, chatName) : {},
    );
  }

  async #findChatState(api, chatName, { screenshot = false } = {}) {
    const initialWindows = await listLineWindows(api);
    const identity = await this.#identityForWindow(chatName, initialWindows);
    const alreadyOpen = await inspectDetachedChat(api, chatName, { screenshot, lineWindows: initialWindows });
    if (alreadyOpen) return { inspected: { ...alreadyOpen, identity } };

    const candidate = await inspectMainChat(api, chatName, { screenshot, ocr: this.ocr, lineWindows: initialWindows });
    const accepted = await this.#acceptMainCandidate(api, chatName, candidate, identity);
    if (accepted) {
      assertReplySourceChatType(accepted, identity.kind);
      return { inspected: accepted };
    }
    // A screenshot request is the visual fallback: do not activate/search a
    // possibly different conversation just to manufacture a proof. Return the
    // current structurally proven main header crop; the caller must attest it
    // exactly matches chatName before any later chat-scoped action is allowed.
    if (screenshot && candidate) {
      return { pending: await this.#createPendingVisualState(chatName, { ...candidate, identity }) };
    }

    throw new LineToolError(
      'LINE_CHAT_UNVERIFIED',
      'Open the exact authorized chat using a guided LINE UI workflow, then request a header view if needed. Unverified first-result navigation is disabled.',
      candidate ? chatProofDetails(candidate.state, chatName) : {},
    );
  }

  async #identityForWindow(chatName, windows) {
    // Exact window titles need only the named identity; OCR also checks name families.
    return windows.some(window => isVisibleLineWindow(window) && window.title === chatName)
      ? this.readNamedIdentity({ chatName })
      : this.#requireChatIdentity(chatName);
  }

  async #requireChatIdentity(chatName) {
    const result = await this.readChatIdentity({ chatName });
    if (result?.chatName !== chatName || !/^chat:[0-9a-f]{24}$/u.test(result?.chatRef ?? '')
      || !REPLY_CHAT_TYPES.includes(result?.chatIdentity?.kind)
      || result.chatIdentity.displayName !== chatName || result.chatIdentity.uiIdentityVerified !== false
      || result.chatIdentity.guiDisplayNameUnique !== true || result.scope?.kind !== 'local_gui_chat_identity'
      || result.count !== 0 || !Array.isArray(result.messages) || result.messages.length !== 0) {
      throw new LineToolError('LINE_CHAT_IDENTITY_UNVERIFIED', 'A complete unique local chat identity is required before inspecting or operating LINE.');
    }
    return Object.freeze({ chatRef: result.chatRef, kind: result.chatIdentity.kind });
  }

  async #acceptMainCandidate(api, chatName, candidate, identity) {
    if (!candidate) return undefined;
    if (candidate.proof) return { ...candidate, identity };

    this.#pruneVisualRecords();
    const confirmed = this.visual.confirmed.get(chatName);
    if (!confirmed || !sameTarget(confirmed.target, candidate.target)) return undefined;
    if (!sameLocalChatIdentity(confirmed.identity, identity)) {
      this.visual.confirmed.delete(chatName);
      throw new LineToolError('LINE_CHAT_CONFIRMATION_STALE', 'The local chat identity changed after header confirmation. Request a new header view.');
    }
    if (!REPLY_CHAT_TYPES.includes(confirmed.chatType)) {
      this.visual.confirmed.delete(chatName);
      return undefined;
    }
    const fresh = await inspectExactMainWindow(api, candidate.target);
    const fingerprint = await captureHeaderFingerprint(fresh.state, fresh.window, this.visual, { includeImage: false });
    if (!fingerprint || !sameHeaderFingerprint(confirmed.fingerprint, fingerprint)) {
      this.visual.confirmed.delete(chatName);
      return undefined;
    }
    return {
      ...fresh,
      identity,
      fingerprint,
      proof: {
        kind: 'cached-caller-confirmed-main-header-crop',
        confidence: 'medium',
        chatType: confirmed.chatType,
      },
    };
  }

  #chatGuard(chatName, inspected, options) {
    if (inspected.groupRecord) return {kind:'scoped-group-context',chatName,target:inspected.target,
      chatType:'group',identity:inspected.identity,verify:inspected.groupVerify,
      isFresh:()=>this.group.getVerified(chatName) === inspected.groupRecord};
    if (inspected.directRecord) return {kind:'scoped-direct-context',chatName,target:inspected.target,
      chatType:'direct',identity:inspected.identity,verify:inspected.directVerify};
    const expectedChatType = inspected.proof.kind === 'exact-top-level-window-title'
      ? undefined : inspected.identity.kind;
    return { ...createChatGuard(chatName, inspected, this.ocr, this.visual, { expectedChatType, ...options }),
      identity: inspected.identity };
  }

  async #createPendingVisualState(chatName, candidate) {
    const fingerprint = await captureHeaderFingerprint(candidate.state, candidate.window, this.visual, { includeImage: true });
    if (!fingerprint?.image) {
      throw new LineToolError(
        'LINE_CHAT_UNVERIFIED',
        'LINE did not expose a bounded structural header crop for visual confirmation.',
        chatProofDetails(candidate.state, chatName),
      );
    }
    this.#pruneVisualRecords();
    const token = this.#newVisualToken();
    const expiresAt = this.#expiresAt();
    this.visual.pending.set(token, {
      chatName,
      identity: candidate.identity,
      target: candidate.target,
      fingerprint: withoutHeaderImage(fingerprint),
      expiresAt,
    });
    return {
      success: true,
      chatName,
      verification: 'visual-header-confirmation-pending',
      confidence: 'pending',
      visualVerification: {
        token,
        expiresAt: new Date(expiresAt).toISOString(),
      },
      images: [fingerprint.image],
    };
  }

  async #createPendingReplySourceTarget(chatName, source, inspected, guard, state) {
    assertReplySourceChatTypeBinding({ chatType: guard?.chatType, guard });
    const view = replySourceVisualView(state, inspected.window, guard, this.visual);
    const image = view ? await captureReplyViewImage(view, this.visual) : undefined;
    if (!image) {
      throw new LineToolError(
        'LINE_REPLY_SOURCE_UNVERIFIED',
        'LINE did not expose one bounded message area between the verified chat header and composer. Use a fresh guided visual workflow instead of guessing a reply point.',
      );
    }
    this.#pruneVisualRecords();
    const token = this.#newVisualToken();
    const expiresAt = this.#expiresAt();
    const cropBounds = { x: 0, y: 0, width: view.messageBounds.width, height: view.messageBounds.height };
    this.visual.pendingReplySources.set(token, {
      chatName,
      identity: inspected.identity,
      chatType: guard.chatType,
      source,
      target: inspected.target,
      guard,
      image: view.image,
      imageBounds: view.imageBounds,
      messageBounds: view.messageBounds,
      cropBounds,
      expiresAt,
    });
    return {
      success: true,
      chatName,
      replySourceTarget: {
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        imageBounds: cropBounds,
        messageBounds: cropBounds,
        selectionRequired: ['sourceRect', 'sourcePoint'],
      },
      localSourceRef: source.sourceRef,
      uiSourceRefVerified: false,
      sourceIdentityVerification: 'visual-selection-pending',
      confidence: 'pending',
      images: [image],
    };
  }

  #takeConfirmedReplySource(chatName, source, sourceToken, inspected) {
    this.#pruneVisualRecords();
    const binding = this.visual.confirmedReplySources.get(sourceToken);
    const expectedChatType = this.#peekConfirmedReplySourceChatType(chatName, source, sourceToken);
    try {
      assertReplySourceChatType(inspected, expectedChatType);
    } catch (error) {
      this.visual.confirmedReplySources.delete(sourceToken);
      throw error;
    }
    if (!sameLocalChatIdentity(binding.identity, inspected.identity) || !sameTarget(binding.target, inspected.target)) {
      this.visual.confirmedReplySources.delete(sourceToken);
      throw new LineToolError('LINE_REPLY_SOURCE_STALE', 'The verified LINE chat target changed after source confirmation. No reply action was taken.');
    }
    // A source-target token is deliberately consumed before its right-click
    // path begins. Even a transport refusal must never reuse a point selected
    // from a prior screenshot.
    this.visual.confirmedReplySources.delete(sourceToken);
    return binding;
  }

  #peekConfirmedReplySourceChatType(chatName, source, sourceToken) {
    this.#pruneVisualRecords();
    const binding = this.visual.confirmedReplySources.get(sourceToken);
    if (!binding || binding.chatName !== chatName) {
      throw new LineToolError('LINE_REPLY_SOURCE_CONFIRMATION_INVALID', 'The reply-source token is unknown, expired, already used, or belongs to another chat.');
    }
    if (!sameReplySource(binding.source, source)) {
      throw new LineToolError('LINE_REPLY_SOURCE_CONFIRMATION_INVALID', 'The reply source does not exactly match the source confirmed for this token.');
    }
    assertReplySourceChatTypeBinding(binding);
    return binding.chatType;
  }

  #newVisualToken() {
    const token = this.visual.randomToken();
    if (typeof token !== 'string' || !token || token.length > 256
      || this.visual.pending.has(token)
      || this.visual.pendingReplySources.has(token)
      || this.visual.confirmedReplySources.has(token)) {
      throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'The visual-confirmation token generator did not return one fresh bounded token.');
    }
    return token;
  }

  #expiresAt() {
    const now = Number(this.visual.now());
    if (!Number.isFinite(now)) {
      throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'The visual-confirmation clock did not return a finite timestamp.');
    }
    return now + VISUAL_CONFIRMATION_TTL_MS;
  }

  #pruneVisualRecords() {
    const now = Number(this.visual.now());
    if (!Number.isFinite(now)) {
      throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'The visual-confirmation clock did not return a finite timestamp.');
    }
    for (const [token, record] of this.visual.pending) {
      if (!Number.isFinite(record?.expiresAt) || record.expiresAt <= now) this.visual.pending.delete(token);
    }
    for (const [chatName, record] of this.visual.confirmed) {
      if (!Number.isFinite(record?.expiresAt) || record.expiresAt <= now) this.visual.confirmed.delete(chatName);
    }
    for (const [token, record] of this.visual.pendingReplySources) {
      if (!Number.isFinite(record?.expiresAt) || record.expiresAt <= now) this.visual.pendingReplySources.delete(token);
    }
    for (const [token, record] of this.visual.confirmedReplySources) {
      if (!Number.isFinite(record?.expiresAt) || record.expiresAt <= now) this.visual.confirmedReplySources.delete(token);
    }
  }
}

function sameLocalChatIdentity(left, right) {
  return Boolean(left && right && left.chatRef === right.chatRef && left.kind === right.kind);
}

async function activateForegroundFeature(automation, inspected) {
  if (typeof automation?.activateLine !== 'function') {
    throw new LineToolError('LINE_AUTOMATION_UNAVAILABLE', 'Existing LINE automation does not implement activateLine.');
  }
  let activation;
  try {
    activation = await automation.activateLine({ ...inspected.target, title: inspected.window.title });
  } catch (error) {
    throw new LineToolError(
      'LINE_FOCUS_UNAVAILABLE',
      'LINE foreground activation was not verified by the existing automation.',
      { previousCode: error?.code ?? error?.name ?? null },
    );
  }
  if (activation?.success !== true) {
    throw new LineToolError('LINE_FOCUS_UNAVAILABLE', 'LINE foreground activation was not verified by the existing automation.');
  }
}

async function inspectDetachedChat(api, chatName, { screenshot = false, lineWindows } = {}) {
  requireApi(api);
  const windows = lineWindows ?? await listLineWindows(api);
  const visible = windows.filter(isVisibleLineWindow);
  const detached = visible.filter(window => window.title === chatName);

  if (detached.length > 1) {
    throw new LineToolError(
      'LINE_CHAT_UNVERIFIED',
      'More than one visible LINE window has the requested chat title, so the target is ambiguous.',
      { candidateCount: detached.length },
    );
  }
  if (detached.length === 1) {
    const target = targetFromWindow(detached[0]);
    const state = await snapshot(api, target, { screenshot });
    const stateTitle = stateWindowTitle(state);
    if (stateTitle !== undefined && stateTitle !== chatName) {
      throw new LineToolError(
        'LINE_CHAT_UNVERIFIED',
        'The detached LINE window title changed before its state could be inspected.',
        { operationMayHaveCompleted: false },
      );
    }
    return {
      target,
      state,
      lineWindows: windows,
      window: detached[0],
      proof: {
        kind: 'exact-top-level-window-title',
        confidence: 'high',
      },
    };
  }

  return undefined;
}

/**
 * Inspect the one structurally-proven main chat window. Unlike a detached
 * chat, the visible title is normally just LINE, so this deliberately returns
 * an unproven candidate instead of treating sidebar/search text as identity.
 */
async function inspectMainChat(api, chatName, { screenshot = false, ocr, lineWindows } = {}) {
  requireApi(api);
  lineWindows ??= await listLineWindows(api);
  const visible = lineWindows.filter(isVisibleLineWindow);
  const main = await findUniqueMainChatWindow(api, visible);
  if (!main) return undefined;

  const { window: mainWindow, target, state: initialState } = main;
  let state = initialState;
  let proof = findChatHeaderProof(state, chatName, { requireContentHeaderBand: true });
  if (!proof && ocr) {
    // The first tree-only snapshot is enough on accessible builds. Ask for a
    // fresh screenshot only when the header is otherwise unobservable.
    state = await snapshot(api, target, { screenshot: true });
    proof = await findMainHeaderOcrProof(state, chatName, mainWindow, ocr);
  }
  return { target, state, lineWindows, window: mainWindow, proof };
}

/** Re-read one previously identified main window before a visual cache use. */
async function inspectExactMainWindow(api, expectedTarget) {
  const windows = await listLineWindows(api);
  const exact = windows.filter(window => isVisibleLineWindow(window)
    && window.title === 'LINE'
    && sameTarget(targetFromWindow(window), expectedTarget));
  if (exact.length !== 1) {
    throw new LineToolError(
      'LINE_CHAT_CONFIRMATION_STALE',
      'The LINE main window changed or is no longer uniquely visible. Request a new header view.',
      { candidateCount: exact.length },
    );
  }
  const target = targetFromWindow(exact[0]);
  const state = await snapshot(api, target, { screenshot: true });
  if (findMainChatBands(state).length !== 1) {
    throw new LineToolError(
      'LINE_CHAT_CONFIRMATION_STALE',
      'LINE no longer exposes the structurally proven main chat header. Request a new header view.',
    );
  }
  return { target, state, lineWindows: windows, window: exact[0] };
}

async function findUniqueMainChatWindow(api, visibleWindows) {
  const titleCandidates = visibleWindows.filter(window => window.title === 'LINE');
  const candidates = [];
  for (const window of titleCandidates) {
    const target = targetFromWindow(window);
    const state = await snapshot(api, target);
    // A popup menu can also be titled LINE. The main chat is the one whose
    // UIA tree proves the composer lives below a full-width content body and
    // a distinct header band; title or rectangle size alone is not identity.
    if (findMainChatBands(state).length === 1) candidates.push({ window, target, state });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function listLineWindows(api) {
  const result = await api.call('list_windows', {});
  if (!Array.isArray(result?.windows)) {
    throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'CUA did not return a windows array.');
  }
  return result.windows.filter(window => window?.app_name === LINE_APP_NAME);
}

function isVisibleLineWindow(window) {
  return window?.app_name === LINE_APP_NAME
    && window.is_on_screen === true
    && window.minimized !== true;
}

function targetFromWindow(window) {
  if (!Number.isInteger(window?.pid) || !Number.isInteger(window?.window_id)) {
    throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'CUA returned a LINE window without a numeric pid and window_id.');
  }
  if (window.app_name !== LINE_APP_NAME) {
    throw new LineToolError('LINE_UI_TARGET_INVALID', 'The selected window is not the exact LINE.exe application target.');
  }
  return { pid: window.pid, window_id: window.window_id };
}

function sameTarget(first, second) {
  return Number.isInteger(first?.pid)
    && Number.isInteger(first?.window_id)
    && first.pid === second?.pid
    && first.window_id === second?.window_id;
}

function stateWindowTitle(state) {
  for (const key of ['title', 'window_title']) {
    if (typeof state?.[key] === 'string') return state[key];
  }
  if (typeof state?.window?.title === 'string') return state.window.title;
  return undefined;
}

function chatResult(chatName, inspected) {
  return {
    success: true,
    chatName,
    verification: inspected.proof.kind,
    confidence: inspected.proof.confidence,
  };
}

function capabilityMetadata(api) {
  const tools = api?.tools instanceof Set ? api.tools : new Set();
  return {
    listWindows: tools.has('list_windows'),
    windowState: tools.has('get_window_state'),
    accessibilityClick: tools.has('click'),
    rightClick: tools.has('right_click'),
    setValue: tools.has('set_value'),
    hotkey: tools.has('hotkey'),
    clipboardRead: tools.has('clipboard_read'),
  };
}

function requireApi(api) {
  if (!api || typeof api.call !== 'function') {
    throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'CUA client did not provide a callable public API.');
  }
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new LineToolError('LINE_INVALID_ARGUMENT', `${name} must be a boolean.`);
  }
}

function requireOptionalDraft(value, name) {
  if (value !== undefined) requireText(value, name, 10_000, { empty: true });
}

function normalized(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]+/g, '-')
    : '';
}

function semanticValues(element) {
  return [
    element?.role,
    element?.semantic_role,
    element?.semanticRole,
    element?.automation_id,
    element?.automationId,
    element?.region,
    element?.landmark,
    element?.control_type,
    element?.controlType,
  ].map(normalized).filter(Boolean);
}

function hasMarker(element, markers) {
  return semanticValues(element).some(value => markers.has(value));
}

function exactLabels(element) {
  return [element?.label, element?.name]
    .filter(value => typeof value === 'string')
    .map(value => value.trim());
}

function hasExactLabel(element, labels) {
  return exactLabels(element).some(label => labels.includes(label));
}

function elementIndex(element) {
  return Number.isInteger(element?.element_index) ? element.element_index : undefined;
}

function parentIndex(element) {
  return Number.isInteger(element?.parent_index) ? element.parent_index : undefined;
}

function findChatHeaderProof(state, chatName, { requireContentHeaderBand = false } = {}) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  const matching = elements.flatMap(element => {
    const match = chatHeaderLabelMatch(exactLabels(element), chatName);
    return match ? [{ element, match }] : [];
  });
  const byIndex = new Map(elements
    .filter(element => elementIndex(element) !== undefined)
    .map(element => [elementIndex(element), element]));
  const bands = requireContentHeaderBand ? findMainChatBands(state) : [];
  const headerMatches = matching.filter(candidate => {
    if (!(hasMarker(candidate.element, HEADER_MARKERS)
      || hasHeaderAncestor(candidate.element, byIndex))) return false;
    return !requireContentHeaderBand || elementBelongsToMainHeaderBand(candidate.element, byIndex, bands);
  });
  if (headerMatches.length !== 1) return undefined;
  return {
    kind: headerMatches[0].match.groupMemberCount === undefined
      ? 'exact-chat-pane-header'
      : 'exact-chat-pane-group-header',
    confidence: 'high',
    element: headerMatches[0].element,
    ...(headerMatches[0].match.groupMemberCount === undefined
      ? {}
      : { groupMemberCount: headerMatches[0].match.groupMemberCount }),
  };
}

function elementBelongsToMainHeaderBand(element, byIndex, bands) {
  if (bands.length !== 1) return false;
  const band = bands[0];
  const header = findContentHeaderContainer({ elements: [...byIndex.values()] }, band);
  if (!header) return false;
  const headerIndex = elementIndex(header);
  const headerFrame = elementFrame(header);
  if (headerIndex === undefined || !headerFrame) return false;

  let current = element;
  const visited = new Set();
  for (let depth = 0; depth < 12; depth += 1) {
    if (elementIndex(current) === headerIndex) return true;
    const frame = elementFrame(current);
    if (frame && rectInside(frame, headerFrame)) return true;
    const parent = parentIndex(current);
    if (parent === undefined || visited.has(parent)) return false;
    visited.add(parent);
    current = byIndex.get(parent);
    if (!current) return false;
  }
  return false;
}

function chatHeaderLabelMatch(labels, chatName) {
  const matches = labels
    .map(label => ({ label, match: chatHeaderTextMatch(label, chatName) }))
    .filter(candidate => candidate.match);
  return matches.length === 1 ? matches[0].match : undefined;
}

function chatHeaderTextMatch(label, chatName) {
  if (typeof label !== 'string' || typeof chatName !== 'string') return undefined;
  const exact = chatName.normalize('NFC');
  const actual = label.normalize('NFC');
  if (actual === exact) return {};
  const match = new RegExp(`^${escapeRegExp(exact)}\\s+\\((\\d+)\\)$`, 'u').exec(actual);
  if (!match) return undefined;
  const groupMemberCount = Number(match[1]);
  return Number.isSafeInteger(groupMemberCount) ? { groupMemberCount } : undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasHeaderAncestor(element, byIndex) {
  let current = element;
  const visited = new Set();
  for (let depth = 0; depth < 12; depth += 1) {
    if (hasMarker(current, HEADER_MARKERS)) return true;
    const parent = parentIndex(current);
    if (parent === undefined || visited.has(parent)) return false;
    visited.add(parent);
    current = byIndex.get(parent);
    if (!current) return false;
  }
  return false;
}

function chatProofDetails(state, chatName) {
  const candidates = state.elements.filter(element => chatHeaderLabelMatch(exactLabels(element), chatName));
  return {
    exactLabelCandidateCount: candidates.length,
    explicitHeaderCandidateCount: candidates.filter(element => hasMarker(element, HEADER_MARKERS)).length,
  };
}

/**
 * A main LINE window currently exposes its active-chat header as custom Qt
 * drawing, while the global chat search is an unrelated Edit in the left
 * pane. This fallback uses one exact OCR result only when UIA proves a header
 * band above the right content body that contains the composer. It does not
 * use a screen ratio, sidebar text, or a generic Edit as chat identity.
 */
async function findMainHeaderOcrProof(state, chatName, window, ocr) {
  const bands = findMainChatBands(state);
  if (bands.length !== 1) return undefined;

  const recognized = await recognizeGroundedWindowImage(state, ocr);
  if (!recognized) return undefined;
  const label = findUniqueMainHeaderLabel(recognized, chatName, ocr.findImageLabel);
  if (!label) return undefined;

  const band = headerBandInScreenshot(bands[0], window, recognized);
  if (!band || !rectInside(label, band)) return undefined;
  return {
    kind: label.groupMemberCount === undefined
      ? 'grounded-ocr-main-chat-header'
      : 'grounded-ocr-main-group-chat-header',
    confidence: 'medium',
    ...(label.groupMemberCount === undefined ? {} : { groupMemberCount: label.groupMemberCount }),
  };
}

function findContentHeaderBands(state) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  const byIndex = new Map(elements
    .filter(element => elementIndex(element) !== undefined)
    .map(element => [elementIndex(element), element]));
  const candidates = [];

  for (const editor of elements) {
    if (!isViewportEdit(editor, elements)) continue;
    const editorFrame = elementFrame(editor);
    if (!editorFrame) continue;
    const ancestors = ancestorChain(editor, byIndex);
    for (let bodyAt = 0; bodyAt < ancestors.length; bodyAt += 1) {
      const body = ancestors[bodyAt];
      const bodyFrame = elementFrame(body);
      if (!bodyFrame || !isStructuralContainer(body) || !rectInside(editorFrame, bodyFrame)) continue;
      for (let paneAt = bodyAt + 1; paneAt < ancestors.length; paneAt += 1) {
        const pane = ancestors[paneAt];
        const paneFrame = elementFrame(pane);
        if (!paneFrame || !isStructuralContainer(pane)) continue;
        if (!formsHeaderBand(paneFrame, bodyFrame)) continue;
        candidates.push({
          paneIndex: elementIndex(pane),
          bodyIndex: elementIndex(body),
          pane,
          body,
          paneFrame,
          bodyFrame,
        });
      }
    }
  }

  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.paneIndex}:${candidate.bodyIndex}`;
    unique.set(key, candidate);
  }
  return [...unique.values()];
}

/**
 * The composer has nested full-width containers. The actual chat body begins
 * immediately below the unique direct header container; rejecting lower
 * composer wrappers prevents a false "header band" hundreds of pixels tall.
 */
function findMainChatBands(state) {
  return findContentHeaderBands(state).filter(band => {
    const header = findContentHeaderContainer(state, band);
    const headerFrame = elementFrame(header);
    return !!headerFrame
      && Math.abs(band.bodyFrame.y - (headerFrame.y + headerFrame.height)) <= 2;
  });
}

/** Return the one direct header container above a structurally proven body. */
function findContentHeaderContainer(state, band) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  const candidates = elements.filter(element => {
    const frame = elementFrame(element);
    return parentIndex(element) === band.paneIndex
      && normalized(element?.role) === 'group'
      && frame
      && Math.abs(frame.x - band.paneFrame.x) <= 1
      && Math.abs(frame.width - band.paneFrame.width) <= 1
      // Qt also exposes a one-pixel separator as a direct pane child. It is
      // not the title container and cannot bound a meaningful header crop.
      && frame.height >= 16
      && frame.y >= band.paneFrame.y
      && frame.y + frame.height <= band.bodyFrame.y;
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isViewportEdit(element, elements) {
  const index = elementIndex(element);
  return normalized(element?.role) === 'edit'
    && index !== undefined
    && elements.some(child => (
      parentIndex(child) === index
      && normalized(child?.role) === 'group'
      && hasExactLabel(child, ['qt_scrollarea_viewport'])
    ));
}

function ancestorChain(element, byIndex) {
  const ancestors = [];
  const visited = new Set();
  let parent = parentIndex(element);
  while (parent !== undefined && !visited.has(parent) && ancestors.length < 25) {
    visited.add(parent);
    const value = byIndex.get(parent);
    if (!value) break;
    ancestors.push(value);
    parent = parentIndex(value);
  }
  return ancestors;
}

function isStructuralContainer(element) {
  return hasMarker(element, new Set(['group', 'pane', 'window', 'application']));
}

function elementFrame(element) {
  const frame = element?.frame;
  const x = Number(frame?.x);
  const y = Number(frame?.y);
  const width = Number(frame?.w ?? frame?.width);
  const height = Number(frame?.h ?? frame?.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function formsHeaderBand(pane, body) {
  const tolerance = 1;
  return Math.abs(pane.x - body.x) <= tolerance
    && Math.abs(pane.width - body.width) <= tolerance
    && body.y > pane.y + tolerance
    && body.y + body.height <= pane.y + pane.height + tolerance;
}

function rectInside(inner, outer, tolerance = 1) {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

async function recognizeGroundedWindowImage(state, ocr, window) {
  const images = Array.isArray(state?.images) ? state.images : [];
  let selected;
  let expected;
  let popupClientArea = false;
  if (window) {
    expected = windowBoundsFrame(window);
    // Qt popup HWND bounds include a two-pixel non-client edge that the CUA
    // screenshot omits. Accept only that measured inset on small popup menus.
    popupClientArea = expected?.width <= 500 && expected?.height <= 500;
    const matchesWindowImage = dimensions => dimensions
      && (popupClientArea
        ? dimensions.width <= expected.width && dimensions.width >= expected.width - 2
          && dimensions.height <= expected.height && dimensions.height >= expected.height - 2
        : dimensions.width === expected.width && dimensions.height === expected.height);
    const roots = (Array.isArray(state?.elements) ? state.elements : []).filter(element => {
      const frame = elementFrame(element);
      return normalized(element?.role) === 'window' && frame && expected
        && ['x', 'y', 'width', 'height'].every(key => Math.abs(frame[key] - expected[key]) <= 1);
    });
    if (roots.length !== 1) return undefined;
    const matching = images.filter(image => {
      try {
        const dimensions = ocr.imageDimensions(image);
        return matchesWindowImage(dimensions);
      } catch {
        return false;
      }
    });
    if (matching.length !== 1) return undefined;
    selected = matching[0];
  } else {
    if (images.length !== 1) return undefined;
    selected = images[0];
  }
  if (!selected || typeof selected !== 'object') return undefined;
  try {
    const recognized = await ocr.recognizeImage(selected,
      popupClientArea ? { upscaleFactor: 3 } : undefined);
    return validGroundedOcr(recognized)
      && (!expected || (recognized.width === ocr.imageDimensions(selected).width
        && recognized.height === ocr.imageDimensions(selected).height))
      ? recognized : undefined;
  } catch {
    // OCR is only a conservative fallback. Its unavailability cannot turn an
    // unknown chat or control into a success.
    return undefined;
  }
}

function validGroundedOcr(value) {
  return value?.coordinateSpace === 'input-png-pixels'
    && value?.scaleFactor === 1
    && Number.isInteger(value?.width) && value.width > 0
    && Number.isInteger(value?.height) && value.height > 0
    && Array.isArray(value?.lines);
}

function headerBandInScreenshot(band, window, ocr) {
  const bounds = window?.bounds;
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;

  const widthDifference = width - ocr.width;
  const heightDifference = height - ocr.height;
  if (!Number.isInteger(widthDifference) || !Number.isInteger(heightDifference)
    || widthDifference < 0 || heightDifference < 0
    || widthDifference % 2 !== 0 || heightDifference % 2 !== 0) return undefined;

  const insetX = widthDifference / 2;
  const insetY = heightDifference / 2;
  return {
    x: band.paneFrame.x - x - insetX,
    y: band.paneFrame.y - y - insetY,
    width: band.paneFrame.width,
    height: band.bodyFrame.y - band.paneFrame.y,
  };
}

/**
 * Build a narrow title/count crop from the proven right-pane header. The crop
 * is deliberately derived from the direct Qt text-group frames, not from the
 * full header, so transient toolbar hover/focus paint cannot invalidate a
 * visual confirmation for an otherwise unchanged chat.
 */
async function captureHeaderFingerprint(state, window, visual, { includeImage } = {}) {
  const bands = findMainChatBands(state);
  if (bands.length !== 1) return undefined;
  const header = findContentHeaderContainer(state, bands[0]);
  const headerFrame = elementFrame(header);
  const titleFrames = header ? findHeaderTitleFrames(state, header, headerFrame) : undefined;
  const images = Array.isArray(state?.images) ? state.images : [];
  if (!headerFrame || !titleFrames || images.length !== 1 || !images[0] || typeof images[0] !== 'object') {
    return undefined;
  }

  let dimensions;
  try {
    dimensions = visual.imageDimensions(images[0]);
  } catch {
    return undefined;
  }
  if (!validImageDimensions(dimensions) || !matchesReportedScreenshotDimensions(state, dimensions)) return undefined;

  const rootFrame = findScreenshotRootFrame(state, window, bands[0]);
  const region = rootFrame
    ? titleRegionInScreenshot(titleFrames, headerFrame, rootFrame, dimensions)
    : undefined;
  if (!region) return undefined;

  const fingerprint = await visual.fingerprintRegion(images[0], region, { includeImage: includeImage === true });
  return validHeaderFingerprint(fingerprint, region, includeImage === true, visual.imageDimensions)
    ? fingerprint
    : undefined;
}

function findHeaderTitleFrames(state, header, headerFrame) {
  const headerIndex = elementIndex(header);
  if (headerIndex === undefined) return undefined;
  const candidates = (Array.isArray(state?.elements) ? state.elements : [])
    .filter(element => parentIndex(element) === headerIndex && normalized(element?.role) === 'group')
    .map(element => ({ element, frame: elementFrame(element) }))
    .filter(candidate => candidate.frame
      && rectInside(candidate.frame, headerFrame)
      && candidate.frame.height >= 8
      && candidate.frame.height <= headerFrame.height - 6
      // Current LINE title/count text sits in the left title area. This keeps
      // toolbar buttons and their hover paint out of the confirmation crop.
      && candidate.frame.x < headerFrame.x + headerFrame.width * 0.55);
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => left.frame.x - right.frame.x || left.frame.y - right.frame.y);
  const first = candidates[0];
  if (first.frame.x > headerFrame.x + headerFrame.width * 0.35) return undefined;

  const rowTolerance = 2;
  const gap = Math.max(8, Math.ceil(first.frame.height));
  const frames = [first.frame];
  let right = first.frame.x + first.frame.width;
  for (const candidate of candidates.slice(1)) {
    if (Math.abs(candidate.frame.y - first.frame.y) > rowTolerance
      || Math.abs(candidate.frame.height - first.frame.height) > rowTolerance
      || candidate.frame.x > right + gap) break;
    frames.push(candidate.frame);
    right = Math.max(right, candidate.frame.x + candidate.frame.width);
  }
  return frames.length > 0 ? frames : undefined;
}

function validImageDimensions(value) {
  return Number.isInteger(value?.width) && value.width > 0
    && Number.isInteger(value?.height) && value.height > 0;
}

function matchesReportedScreenshotDimensions(state, dimensions) {
  for (const [key, value] of [
    ['screenshot_width', dimensions.width],
    ['screenshot_height', dimensions.height],
  ]) {
    if (state?.[key] !== undefined && state[key] !== value) return false;
  }
  return true;
}

function findScreenshotRootFrame(state, window, band) {
  const expected = windowBoundsFrame(window);
  if (!expected) return undefined;
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  const byIndex = new Map(elements
    .filter(element => elementIndex(element) !== undefined)
    .map(element => [elementIndex(element), element]));
  const ancestors = ancestorChain(band.pane, byIndex);
  const candidates = ancestors
    .map(element => elementFrame(element))
    .filter(frame => frame
      && rectInside(band.paneFrame, frame)
      && Math.abs(frame.width - expected.width) <= 8
      && Math.abs(frame.height - expected.height) <= 8);
  if (candidates.length !== 1) return undefined;
  return candidates[0];
}

function windowBoundsFrame(window) {
  const x = Number(window?.bounds?.x);
  const y = Number(window?.bounds?.y);
  const width = Number(window?.bounds?.width);
  const height = Number(window?.bounds?.height);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height }
    : undefined;
}

function titleRegionInScreenshot(titleFrames, headerFrame, rootFrame, dimensions) {
  const titleBounds = unionFrames(titleFrames);
  if (!titleBounds) return undefined;
  const logical = {
    x: Math.max(headerFrame.x, titleBounds.x - 2),
    y: Math.max(headerFrame.y, titleBounds.y - 2),
    width: 0,
    height: 0,
  };
  const right = Math.min(headerFrame.x + headerFrame.width, titleBounds.x + titleBounds.width + 2);
  const bottom = Math.min(headerFrame.y + headerFrame.height, titleBounds.y + titleBounds.height + 2);
  logical.width = right - logical.x;
  logical.height = bottom - logical.y;
  if (logical.width <= 0 || logical.height <= 0 || !rectInside(logical, headerFrame)) return undefined;

  const crop = frameInScreenshot(logical, rootFrame, dimensions);
  const headerCrop = frameInScreenshot(headerFrame, rootFrame, dimensions);
  if (!crop || !headerCrop || !rectInside(crop, headerCrop, 0)) return undefined;
  return crop;
}

function unionFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const frame of frames) {
    if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) return undefined;
    left = Math.min(left, frame.x);
    top = Math.min(top, frame.y);
    right = Math.max(right, frame.x + frame.width);
    bottom = Math.max(bottom, frame.y + frame.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function frameInScreenshot(frame, rootFrame, dimensions) {
  if (!rectInside(frame, rootFrame, 1)) return undefined;
  const scaleX = dimensions.width / rootFrame.width;
  const scaleY = dimensions.height / rootFrame.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return undefined;
  // Qt's UIA frame can extend one logical pixel beyond the actual capture.
  // Clip that already-validated rounding fringe; never expand the crop.
  const left = Math.max(0, Math.floor((frame.x - rootFrame.x) * scaleX));
  const top = Math.max(0, Math.floor((frame.y - rootFrame.y) * scaleY));
  const right = Math.min(dimensions.width, Math.ceil((frame.x + frame.width - rootFrame.x) * scaleX));
  const bottom = Math.min(dimensions.height, Math.ceil((frame.y + frame.height - rootFrame.y) * scaleY));
  if (![left, top, right, bottom].every(Number.isFinite)
    || left < 0 || top < 0 || right > dimensions.width || bottom > dimensions.height
    || right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function validHeaderFingerprint(value, region, includeImage, imageDimensions) {
  if (!value || typeof value !== 'object'
    || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || value.width !== region.width || value.height !== region.height
    || !sameRegion(value.region, region)) return false;
  if (!includeImage) return value.image === undefined;
  if (!value.image || value.image.type !== 'image' || value.image.mimeType !== 'image/png'
    || typeof value.image.data !== 'string') return false;
  // The helper returns a cropped PNG; deriving its dimensions a second time
  // ensures an injected/broken helper cannot smuggle the full main screenshot.
  try {
    const crop = imageDimensions(value.image);
    return crop?.width === region.width && crop?.height === region.height;
  } catch {
    return false;
  }
}

function sameHeaderFingerprint(first, second) {
  return first?.sha256 === second?.sha256
    && first?.width === second?.width
    && first?.height === second?.height
    && sameRegion(first?.region, second?.region);
}

function sameRegion(first, second) {
  return ['x', 'y', 'width', 'height'].every(key => first?.[key] === second?.[key]);
}

function groupViewChanged() {
  return new LineToolError('LINE_GROUP_VIEW_CHANGED',
    'The proven group view changed before the action.', {sendDispatched:false});
}

function sameGroupWindow(first, second) {
  return second?.app_name === first?.app_name && second?.title === first?.title
    && second?.is_on_screen === true && second?.minimized !== true
    && sameTarget(first, second)
    && ['x', 'y', 'width', 'height'].every(key => first?.bounds?.[key] === second?.bounds?.[key]);
}

function sameFingerprintGeometry(first, second) {
  return first?.width === second?.width && first?.height === second?.height
    && sameRegion(first?.region, second?.region);
}

// Check the complete header and body rectangle on every frame. Only the body
// SHA may differ while the bounded animation reacquisition is in progress.
async function captureExactGroupFrame(api, record, state, visual, mode = 'verify') {
  const windows = await listLineWindows(api);
  const exact = windows.filter(window => isVisibleLineWindow(window)
    && window.title === 'LINE' && sameTarget(targetFromWindow(window), record.target));
  if (exact.length !== 1 || !sameGroupWindow(record.window, exact[0])) throw groupViewChanged();
  let view;
  try {
    view = await captureDirectProofView(state, exact[0], visual, mode);
  } catch {
    throw groupViewChanged();
  }
  if (!sameHeaderFingerprint(record.headerFingerprint, view.headerFingerprint)
    || (mode === 'verify' && !sameFingerprintGeometry(record.bodyFingerprint, view.bodyFingerprint))) {
    throw groupViewChanged();
  }
  return {target:record.target, window:exact[0], state, ...view};
}

async function reacquireExactGroupFrame(api, record, visual, checkLocal) {
  const deadline = performance.now() + GROUP_FRAME_DEADLINE_MS;
  for (let attempt = 0; attempt < GROUP_FRAME_ATTEMPTS; attempt += 1) {
    if (performance.now() >= deadline) throw groupViewChanged();
    if (checkLocal) await checkLocal();
    if (performance.now() >= deadline) throw groupViewChanged();
    let fresh;
    try {
      fresh = await inspectExactMainWindow(api, record.target);
    } catch {
      throw groupViewChanged();
    }
    if (performance.now() >= deadline) throw groupViewChanged();
    if (!sameGroupWindow(record.window, fresh.window)) throw groupViewChanged();
    const observed = await captureExactGroupFrame(api, record, fresh.state, visual);
    if (performance.now() >= deadline) throw groupViewChanged();
    if (sameHeaderFingerprint(record.bodyFingerprint, observed.bodyFingerprint)) return observed;
    if (attempt + 1 < GROUP_FRAME_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, GROUP_FRAME_DELAY_MS));
      if (performance.now() >= deadline) throw groupViewChanged();
    }
  }
  throw groupViewChanged();
}

// Context selection is observational: it never uses a screenshot token for
// input. A one-off transition frame cannot become the later verify target.
async function captureRecurringGroupContextFrame(api, record, visual, checkLocal) {
  if (typeof checkLocal !== 'function') {
    throw new LineToolError('LINE_GROUP_PROOF_LOCAL_UNAVAILABLE',
      'The group context cannot be sampled without its local-evidence guard.', {sendDispatched:false});
  }
  const deadline = performance.now() + GROUP_FRAME_DEADLINE_MS;
  const seen = new Set();
  let bodyGeometry;
  for (let attempt = 0; attempt < GROUP_FRAME_ATTEMPTS; attempt += 1) {
    if (performance.now() >= deadline) throw groupViewChanged();
    await checkLocal();
    if (performance.now() >= deadline) throw groupViewChanged();
    let fresh;
    try {
      fresh = await inspectExactMainWindow(api, record.target);
    } catch {
      throw groupViewChanged();
    }
    if (performance.now() >= deadline || !sameGroupWindow(record.window, fresh.window)) {
      throw groupViewChanged();
    }
    const observed = await captureExactGroupFrame(api, record, fresh.state, visual, 'group-context-sample');
    if (performance.now() >= deadline) throw groupViewChanged();
    if (bodyGeometry && !sameFingerprintGeometry(bodyGeometry, observed.bodyFingerprint)) {
      throw groupViewChanged();
    }
    bodyGeometry ??= observed.bodyFingerprint;
    if (seen.has(observed.bodyFingerprint.sha256)) {
      // Render only the winning, already fingerprinted screenshot. The full
      // context PNG is not needed for any discarded animation frame.
      let crop;
      try {
        crop = await visual.fingerprintRegion(
          observed.state.images[0], observed.contextRegion, {includeImage:true});
      } catch {
        throw groupViewChanged();
      }
      if (performance.now() >= deadline
          || !validHeaderFingerprint(crop, observed.contextRegion, true, visual.imageDimensions)) {
        throw groupViewChanged();
      }
      const {contextRegion: _contextRegion, ...winner} = observed;
      return {...winner, contextImage:crop.image};
    }
    seen.add(observed.bodyFingerprint.sha256);
    if (attempt + 1 < GROUP_FRAME_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, GROUP_CONTEXT_DELAYS_MS[attempt]));
      if (performance.now() >= deadline) throw groupViewChanged();
    }
  }
  throw groupViewChanged();
}

function withoutHeaderImage(value) {
  const { image: _image, ...fingerprint } = value;
  return fingerprint;
}

/** Observe only one structurally bounded right pane; this grants no input. */
export async function captureDirectProofView(state, window, visual, mode) {
  const unavailable = () => new LineToolError('LINE_DIRECT_VIEW_UNAVAILABLE',
    'The bounded LINE header and message area could not be captured.', {sendDispatched:false});
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  if (!hasDirectGeometrySnapshot(state) || elements.some(element => hasMarker(element, MODAL_MARKERS)
    || ['menu', 'menuitem', 'menu-item'].includes(normalized(element?.role)))) throw unavailable();
  const header = await captureHeaderFingerprint(state, window, visual, {includeImage:mode === 'header'});
  if (!header) throw unavailable();
  const result = {headerFingerprint:withoutHeaderImage(header), capturedAt:new Date(visual.now()).toISOString()};
  if (mode === 'header') return {...result, headerImage:header.image};
  if (!['context', 'verify', 'receipt', 'group-context-sample'].includes(mode)) throw unavailable();
  const bands = findMainChatBands(state);
  const composer = findMainComposerCandidate(state);
  const composerFrame = elementFrame(composer?.element);
  if (bands.length !== 1 || !composerFrame) throw unavailable();
  const band = bands[0];
  const rootFrame = findScreenshotRootFrame(state, window, band);
  const images = state.images;
  if (!rootFrame || !Array.isArray(images) || images.length !== 1
    || !rectInside(composerFrame, band.bodyFrame)) throw unavailable();
  const dimensions = visual.imageDimensions(images[0]);
  if (!validImageDimensions(dimensions) || !matchesReportedScreenshotDimensions(state, dimensions)) throw unavailable();
  const bottom = composerFrame.y - 2;
  const body = {x:band.bodyFrame.x, y:band.bodyFrame.y, width:band.bodyFrame.width, height:bottom-band.bodyFrame.y};
  if (body.height < 40) throw unavailable();
  const bodyRegion = frameInScreenshot(body, rootFrame, dimensions);
  if (!bodyRegion) throw unavailable();
  const bodyFingerprint = await visual.fingerprintRegion(images[0], bodyRegion, {includeImage:false});
  if (!validHeaderFingerprint(bodyFingerprint, bodyRegion, false, visual.imageDimensions)) throw unavailable();
  result.bodyFingerprint = bodyFingerprint;
  if (mode === 'verify') return result;
  const headerFrame = elementFrame(findContentHeaderContainer(state, band));
  if (!headerFrame) throw unavailable();
  const contextRegion = frameInScreenshot({x:body.x,y:headerFrame.y,width:body.width,height:bottom-headerFrame.y},rootFrame,dimensions);
  if (!contextRegion) throw unavailable();
  if (mode === 'group-context-sample') return {...result, contextRegion};
  const crop = await visual.fingerprintRegion(images[0], contextRegion, {includeImage:true});
  if (!validHeaderFingerprint(crop, contextRegion, true, visual.imageDimensions)) throw unavailable();
  return {...result, [mode === 'receipt' ? 'receiptImage' : 'contextImage']:crop.image};
}

/**
 * The current LINE Desktop message list is custom-drawn, but UIA still
 * exposes a structural right-pane body and rich composer. That gives a bounded
 * screenshot region where a caller may visually select a message bubble. The
 * region intentionally excludes every header, sidebar, composer, dialog, and
 * menu surface; it is not an inferred screen ratio.
 */
function replySourceVisualView(state, window, guard, visual, { includeComposer = false } = {}) {
  const images = Array.isArray(state?.images) ? state.images : [];
  if (images.length !== 1 || !images[0] || typeof images[0] !== 'object') return undefined;
  let dimensions;
  try {
    dimensions = visual.imageDimensions(images[0]);
  } catch {
    return undefined;
  }
  if (!validImageDimensions(dimensions) || !matchesReportedScreenshotDimensions(state, dimensions)) return undefined;
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  if (elements.some(element => hasMarker(element, MODAL_MARKERS)
    || ['menu', 'menuitem', 'menu-item'].includes(normalized(element?.role)))) return undefined;
  const bands = guard?.kind === 'detached-title'
    ? findContentHeaderBands(state).filter(band => normalized(band.pane?.role) === 'group'
      && band.paneFrame.width === window?.bounds?.width
      && band.bodyFrame.height > window.bounds.height / 2
      && findContentHeaderContainer(state, band))
    : findMainChatBands(state);
  if (bands.length !== 1) return undefined;
  const band = bands[0];
  const rootFrame = findScreenshotRootFrame(state, window, band);
  if (!rootFrame) return undefined;
  let logicalMessageBounds = band.bodyFrame;
  if (!includeComposer) {
    let composer;
    try {
      composer = findComposer(state, {
        allowDetachedFallback: guard?.kind === 'detached-title',
        allowMainStructuralFallback: isVerifiedMainChatGuard(guard),
        guard,
      });
    } catch {
      return undefined;
    }
    const composerFrame = elementFrame(composer?.element);
    if (!composerFrame || !rectInside(composerFrame, band.bodyFrame)) return undefined;
    const bottom = composerFrame.y - 2;
    if (bottom - band.bodyFrame.y < 40) return undefined;
    logicalMessageBounds = {
      x: band.bodyFrame.x,
      y: band.bodyFrame.y,
      width: band.bodyFrame.width,
      height: bottom - band.bodyFrame.y,
    };
  }
  const messageBounds = frameInScreenshot(logicalMessageBounds, rootFrame, dimensions);
  if (!messageBounds) return undefined;
  return {
    image: images[0],
    dimensions,
    imageBounds: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
    messageBounds,
    rootFrame,
  };
}

async function captureReplyViewImage(view, visual) {
  try {
    const crop = await visual.fingerprintRegion(view.image, view.messageBounds, { includeImage: true });
    return validHeaderFingerprint(crop, view.messageBounds, true, visual.imageDimensions)
      ? crop.image : undefined;
  } catch {
    return undefined;
  }
}

async function captureReplySourceFingerprint(image, region, visual) {
  let fingerprint;
  try {
    fingerprint = await visual.fingerprintRegion(image, region, { includeImage: false });
  } catch {
    return undefined;
  }
  return validReplySourceFingerprint(fingerprint, region) ? fingerprint : undefined;
}

function validReplySourceFingerprint(value, region) {
  return !!value && typeof value === 'object'
    && /^[a-f0-9]{64}$/u.test(value.sha256)
    && value.width === region.width
    && value.height === region.height
    && sameRegion(value.region, region)
    && value.image === undefined;
}

function sameReplySourceFingerprint(first, second) {
  return first?.sha256 === second?.sha256
    && first?.width === second?.width
    && first?.height === second?.height
    && sameRegion(first?.region, second?.region);
}

function accessibleReplyMessageCandidates(state, messageText, view) {
  return state.elements
    .filter(element => hasExactLabel(element, [messageText]) && hasMarker(element, MESSAGE_MARKERS))
    .map(element => {
      const frame = elementFrame(element);
      const bounds = frame ? frameInScreenshot(frame, view.rootFrame, view.dimensions) : undefined;
      return { element, bounds };
    })
    .filter(candidate => candidate.bounds && rectInside(candidate.bounds, view.messageBounds));
}

function findUniqueMainHeaderLabel(ocr, chatName, findLabel) {
  const direct = findUniqueOcrLabel(ocr, [chatName], findLabel);
  if (direct) return direct;

  const target = normalizedHeaderText(chatName);
  if (!target || /\s/u.test(chatName) || !/\p{Script=Han}/u.test(chatName)) return undefined;
  const matches = [];
  for (let first = 0; first < ocr.lines.length; first += 1) {
    let text = '';
    const lines = [];
    for (let last = first; last < ocr.lines.length; last += 1) {
      const line = ocr.lines[last];
      if (!line || typeof line.text !== 'string') break;
      text = text ? `${text}\n${line.text}` : line.text;
      lines.push(line);
      const headerMatch = normalizedMainHeaderTextMatch(text, target);
      if (!headerMatch) continue;
      const bounds = unionOcrBounds(lines);
      if (bounds) matches.push({
        label: chatName,
        text,
        lines: [...lines],
        ...bounds,
        ...(headerMatch.groupMemberCount === undefined ? {} : { groupMemberCount: headerMatch.groupMemberCount }),
      });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizedMainHeaderTextMatch(value, target) {
  const actual = normalizedHeaderText(value);
  if (actual === target) return {};
  const match = new RegExp(`^${escapeRegExp(target)}\\((\\d+)\\)$`, 'u').exec(actual);
  if (!match) return undefined;
  const groupMemberCount = Number(match[1]);
  return Number.isSafeInteger(groupMemberCount) ? { groupMemberCount } : undefined;
}

function normalizedHeaderText(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/[\s\u00a0]+/gu, '') : '';
}

function unionOcrBounds(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const line of lines) {
    const x = Number(line?.x);
    const y = Number(line?.y);
    const width = Number(line?.width);
    const height = Number(line?.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function composerOptions(inspected, guard) {
  return {
    // A detached titled chat has one narrow rich-editor fallback. The main
    // window uses a different fallback, scoped to the one structurally proven
    // chat body and only after a main-chat guard has been constructed.
    allowDetachedFallback: inspected.proof.kind === 'exact-top-level-window-title',
    allowMainStructuralFallback: inspected.window?.title === 'LINE'
      && isVerifiedMainChatGuard(guard),
    guard,
  };
}

function isVerifiedMainChatGuard(guard) {
  return guard?.kind === 'scoped-direct-context' || guard?.kind === 'scoped-group-context'
    || guard?.kind === 'semantic-main-header'
    || guard?.kind === 'ocr-main-header'
    || guard?.kind === 'visual-main-header-crop';
}

function replyChatTypeFromProof(proof) {
  switch (proof?.kind) {
    case 'scoped-direct-context':
    case 'exact-chat-pane-header':
    case 'grounded-ocr-main-chat-header':
      return 'direct';
    case 'exact-chat-pane-group-header':
    case 'grounded-ocr-main-group-chat-header':
    case 'scoped-group-context':
      return 'group';
    case 'exact-top-level-window-title':
    case 'cached-caller-confirmed-main-header-crop':
      return REPLY_CHAT_TYPES.includes(proof.chatType) ? proof.chatType : undefined;
    default:
      return undefined;
  }
}

function assertReplySourceChatType(inspected, expectedChatType) {
  const observedChatType = replyChatTypeFromProof(inspected?.proof);
  if (!observedChatType) {
    throw new LineToolError(
      'LINE_REPLY_SOURCE_CHAT_TYPE_UNVERIFIED',
      'LINE could not prove whether the exact named reply chat is direct or group. No reply-source action was taken.',
    );
  }
  if (observedChatType !== expectedChatType) {
    throw new LineToolError(
      'LINE_REPLY_SOURCE_CHAT_TYPE_MISMATCH',
      'LINE proved a different chat type for the exact named reply chat. No reply-source action was taken.',
    );
  }
}

function assertReplySourceChatTypeBinding(binding) {
  if (!REPLY_CHAT_TYPES.includes(binding?.chatType) || binding.guard?.chatType !== binding.chatType) {
    throw new LineToolError(
      'LINE_UI_BACKEND_PROTOCOL',
      'The reply-source token did not retain one verified direct/group chat type.',
    );
  }
}

function createChatGuard(chatName, inspected, ocr, visual, { expectedChatType } = {}) {
  const target = inspected?.target;
  const proofKind = inspected?.proof?.kind;
  if (!target || typeof proofKind !== 'string') {
    throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'A verified chat result did not include a target and proof kind.');
  }
  if (expectedChatType !== undefined) assertReplySourceChatType(inspected, expectedChatType);
  const boundChatType = expectedChatType === undefined ? undefined : expectedChatType;
  if (proofKind === 'exact-top-level-window-title') {
    return { kind: 'detached-title', chatName, target, ...(boundChatType === undefined ? {} : { chatType: boundChatType }) };
  }
  if (proofKind.startsWith('exact-chat-pane-')) {
    return { kind: 'semantic-main-header', chatName, target, ...(boundChatType === undefined ? {} : { chatType: boundChatType }) };
  }
  if (proofKind.startsWith('grounded-ocr-main-')) {
    return { kind: 'ocr-main-header', chatName, target, window: inspected.window, ocr, ...(boundChatType === undefined ? {} : { chatType: boundChatType }) };
  }
  if (proofKind === 'cached-caller-confirmed-main-header-crop') {
    return {
      kind: 'visual-main-header-crop',
      chatName,
      target,
      window: inspected.window,
      fingerprint: inspected.fingerprint,
      visual,
      ...(boundChatType === undefined ? {} : { chatType: boundChatType }),
    };
  }
  throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', `Unsupported verified-chat proof kind ${proofKind}.`);
}

function chatGuardNeedsScreenshot(guard) {
  return guard?.kind === 'bound-direct-context' || guard?.kind === 'scoped-direct-context' || guard?.kind === 'scoped-group-context'
    || guard?.kind === 'ocr-main-header' || guard?.kind === 'visual-main-header-crop';
}

async function assertChatGuard(api, target, state, guard) {
  if (!guard) return state;
  if (!sameTarget(target, guard.target)) {
    throw new LineToolError('LINE_CHAT_STALE', 'The selected LINE target changed before the action. No action was taken.');
  }
  if (guard.kind === 'bound-direct-context') {
    return guard.verify(state);
  } else if (guard.kind === 'scoped-group-context') {
    return guard.verify(state, guard.headerOnly === true);
  } else if (guard.kind === 'scoped-direct-context') {
    await guard.verify(state, guard.headerOnly === true);
    return state;
  } else if (guard.kind === 'semantic-main-header') {
    const proof = findChatHeaderProof(state, guard.chatName, { requireContentHeaderBand: true });
    if (proof && (guard.chatType === undefined || replyChatTypeFromProof(proof) === guard.chatType)) return state;
  } else if (guard.kind === 'ocr-main-header') {
    const proof = await findMainHeaderOcrProof(state, guard.chatName, guard.window, guard.ocr);
    if (proof && (guard.chatType === undefined || replyChatTypeFromProof(proof) === guard.chatType)) return state;
  } else if (guard.kind === 'visual-main-header-crop') {
    const fingerprint = await captureHeaderFingerprint(state, guard.window, guard.visual, { includeImage: false });
    if (fingerprint && sameHeaderFingerprint(guard.fingerprint, fingerprint)) return state;
  } else if (guard.kind === 'detached-title') {
    const windows = await listLineWindows(api);
    const matches = windows.filter(window => isVisibleLineWindow(window)
      && window.title === guard.chatName
      && sameTarget(targetFromWindow(window), guard.target));
    if (matches.length === 1) return state;
  } else {
    throw new LineToolError('LINE_UI_BACKEND_PROTOCOL', 'The chat guard had an unknown verification kind.');
  }
  throw new LineToolError(
    'LINE_CHAT_STALE',
    'LINE no longer proves this exact chat in the immediate pre-action state. No action was taken.',
  );
}

function findComposer(state, {
  allowDetachedFallback = false,
  allowMainStructuralFallback = false,
  guard,
} = {}) {
  const candidates = state.elements.filter(element => hasMarker(element, COMPOSER_MARKERS));
  if (candidates.length === 1) {
    const element = candidates[0];
    const value = elementValue(element);
    if (value !== undefined) {
      return { element, value, verification: 'exact-composer-value' };
    }
    const main = allowMainStructuralFallback ? findMainComposerFallback(state, guard) : undefined;
    if (main?.element === element) return main;
    const detached = allowDetachedFallback ? findDetachedComposerFallback(state) : undefined;
    if (detached?.element === element) return detached;
    throw new LineToolError('LINE_DRAFT_UNREADABLE', 'LINE did not expose the full composer value for readback.');
  }

  if (candidates.length === 0 && allowMainStructuralFallback) {
    const main = findMainComposerFallback(state, guard);
    if (main) return main;
  }

  if (candidates.length === 0 && allowDetachedFallback) {
    const detached = findDetachedComposerFallback(state);
    if (detached) return detached;
  }

  throw new LineToolError(
    'LINE_COMPOSER_UNVERIFIED',
    `Expected one explicit LINE composer, found ${candidates.length}. A generic Edit control may be global search and is not accepted.`,
    { candidateCount: candidates.length },
  );
}

/**
 * Current main-window Qt evidence exposes the composer as an unlabeled Edit
 * with a qt_scrollarea_viewport child. That shape is safe only inside the one
 * structurally proven chat body, after the active-chat guard was validated.
 * It deliberately cannot match the left-pane/global-search Edit.
 */
function findMainComposerFallback(state, guard) {
  if (!isVerifiedMainChatGuard(guard)) return undefined;
  return findMainComposerCandidate(state);
}

// Geometry-only observation. This locator never grants permission to input.
function findMainComposerCandidate(state) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  if (elements.some(element => hasMarker(element, MODAL_MARKERS))) {
    return undefined;
  }
  const bands = findMainChatBands(state);
  if (bands.length !== 1) return undefined;
  const band = bands[0];
  const bodyIndex = band.bodyIndex;
  if (!Number.isInteger(bodyIndex)) return undefined;
  const byIndex = new Map(elements
    .filter(element => elementIndex(element) !== undefined)
    .map(element => [elementIndex(element), element]));
  const candidates = elements.filter(element => {
    const index = elementIndex(element);
    const frame = elementFrame(element);
    return normalized(element?.role) === 'edit'
      && index !== undefined
      && frame
      && rectInside(frame, band.bodyFrame)
      && hasAncestorIndex(element, bodyIndex, byIndex)
      && elements.some(child => hasExactLabel(child, ['qt_scrollarea_viewport'])
        && hasAncestorIndex(child, index, byIndex)
        && hasAncestorIndex(child, bodyIndex, byIndex));
  });
  if (candidates.length !== 1) return undefined;

  const element = candidates[0];
  const value = elementValue(element);
  if (value !== undefined) {
    return { element, value, verification: 'main-composer-value-readback' };
  }
  if (exactLabels(element).length === 0) {
    return { element, value: '', verification: 'main-composer-empty-structure' };
  }
  return undefined;
}

function hasAncestorIndex(element, expectedIndex, byIndex) {
  let current = element;
  const visited = new Set();
  for (let depth = 0; depth < 25; depth += 1) {
    const parent = parentIndex(current);
    if (parent === expectedIndex) return true;
    if (parent === undefined || visited.has(parent)) return false;
    visited.add(parent);
    current = byIndex.get(parent);
    if (!current) return false;
  }
  return false;
}

/**
 * Live CUA evidence for a detached LINE chat window: its rich composer is
 * exactly one Edit with a direct Group child named qt_scrollarea_viewport.
 * A separate Search Edit can coexist without this rich-editor child.
 * An empty composer serializes with neither label nor value. This condition is
 * deliberately narrower than accepting an arbitrary Edit or an absent value.
 */
function findDetachedComposerFallback(state) {
  const edits = state.elements.filter(element => normalized(element.role) === 'edit');
  if (state.elements.some(element => normalized(element.role) === 'dialog')) {
    return undefined;
  }
  const richEditors = edits.filter(edit => {
    const index = elementIndex(edit);
    return index !== undefined && state.elements.some(child => (
      parentIndex(child) === index
      && normalized(child.role) === 'group'
      && hasExactLabel(child, ['qt_scrollarea_viewport'])
    ));
  });
  if (richEditors.length !== 1) return undefined;
  const element = richEditors[0];

  const value = elementValue(element);
  if (value !== undefined) {
    return { element, value, verification: 'detached-composer-value-readback' };
  }
  if (exactLabels(element).length === 0) {
    return { element, value: '', verification: 'detached-composer-empty-structure' };
  }
  // A nonempty label without a value has not been proven to be complete draft
  // text. Leave it alone instead of treating it as empty or overwriting it.
  return undefined;
}

function elementValue(element) {
  return typeof element?.value === 'string' ? element.value : undefined;
}

async function readComposer(api, target, options) {
  const initial = await snapshot(api, target, { screenshot: chatGuardNeedsScreenshot(options?.guard) });
  const state = await assertChatGuard(api, target, initial, options?.guard);
  return { state, composer: findComposer(state, options) };
}

/** Every CUA input gets a fresh snapshot before and after it. */
async function runUiInput(api, target, resolve, toolName, args = {}, {
  screenshot = false,
  allowTargetClosedAfter = false,
  guard,
  postGuard = guard,
  deliveryMode,
} = {}) {
  const initial = await snapshot(api, target, { screenshot: screenshot || chatGuardNeedsScreenshot(guard) });
  const before = await assertChatGuard(api, target, initial, guard);
  const resolved = await resolve(before);
  if (guard?.kind === 'scoped-group-context' && guard.isFresh() !== true) {
    throw new LineToolError('LINE_GROUP_PROOF_EXPIRED', 'Group proof expired. Nothing was sent.', {sendDispatched:false});
  }
  // A feature resolver can explicitly prove that its fresh pre-input state is
  // already open. No CUA input was delivered, so preserve that distinction
  // instead of treating it as a selector failure or replaying an action.
  if (resolved?.skipInput === true) {
    return { target, before, after: before, result: undefined, resolved, inputSkipped: true };
  }
  const pixel = resolved?.pixel;
  const element = resolved?.element ?? (pixel ? undefined : resolved);
  let actionTarget;
  if (pixel) {
    if (!isWindowScreenshotPoint(pixel)) {
      throw new LineToolError('LINE_UI_SELECTOR_UNAVAILABLE', `No grounded LINE screenshot point was available for ${toolName}.`);
    }
    actionTarget = { ...target, x: pixel.x, y: pixel.y };
  } else {
    if (!element || typeof element !== 'object') {
      throw new LineToolError('LINE_UI_SELECTOR_UNAVAILABLE', `No exact LINE element was available for ${toolName}.`);
    }
    actionTarget = elementTarget(target, before, element);
  }
  const result = await api.call(toolName, {
    ...actionTarget,
    ...args,
    ...(BACKGROUND_DELIVERY_TOOLS.has(toolName) ? { delivery_mode: deliveryMode ?? 'background' } : {}),
  });
  try {
    const observedAfter = await snapshot(api, target, { screenshot: screenshot || chatGuardNeedsScreenshot(guard) });
    // A matching composer value cannot establish which chat received input.
    // Post-input failures are uncertain even when the pre-input guard passed.
    const after = await assertChatGuard(api, target, observedAfter, postGuard);
    return { target, before, after, result, resolved };
  } catch (afterError) {
    if (!allowTargetClosedAfter || guard) {
      throw new LineToolError(
        'LINE_UI_POSTCONDITION_UNAVAILABLE',
        `CUA ${toolName} returned, but the resulting LINE state could not be verified. Inspect LINE before retrying.`,
        { operationMayHaveCompleted: true, previousCode: afterError?.code ?? afterError?.name ?? null },
      );
    }
    return { target, before, after: undefined, afterError, result, resolved };
  }
}

async function assertFreshChatGuard(api, target, guard) {
  const state = await snapshot(api, target, { screenshot: chatGuardNeedsScreenshot(guard) });
  return assertChatGuard(api, target, state, guard);
}

function isWindowScreenshotPoint(value) {
  return Number.isFinite(value?.x) && Number.isFinite(value?.y)
    && value.x >= 0 && value.y >= 0;
}

async function writeDraft(api, target, desiredValue, expectedDraft, composerConfig) {
  const write = await runUiInput(api, target, state => {
    const composer = findComposer(state, composerConfig);
    assertDraftMayChange(composer.value, expectedDraft);
    if (composer.value === desiredValue) {
      return { skipInput: true, composerVerification: composer.verification };
    }
    return { element: composer.element };
  }, 'set_value', { value: desiredValue }, { guard: composerConfig?.guard });

  if (write.inputSkipped) {
    return { changed: false, raw: undefined, composerVerification: write.resolved.composerVerification };
  }

  let after;
  try {
    after = findComposer(write.after, composerConfig);
  } catch (error) {
    throw new LineToolError(
      'LINE_DRAFT_WRITE_UNVERIFIED',
      'LINE accepted a composer write but did not expose a full post-write value.',
      { operationMayHaveCompleted: true, previousCode: error?.code },
    );
  }
  if (after.value !== desiredValue) {
    throw new LineToolError(
      'LINE_DRAFT_WRITE_UNVERIFIED',
      'LINE composer readback did not equal the requested draft. Inspect the current draft before retrying.',
      { operationMayHaveCompleted: true },
    );
  }
  return { changed: true, raw: write.result, composerVerification: after.verification };
}

async function stageFile(api, automation, inspected, chatName, filePath, optionalMessage, composerConfig) {
  const stageFileManual = automation?.automation?.stageFileManual;
  if (typeof stageFileManual !== 'function') {
    throw new LineToolError(
      'LINE_AUTOMATION_UNAVAILABLE',
      'The guarded inner LINE file-staging helper is unavailable.',
    );
  }

  const initial = await readComposer(api, inspected.target, composerConfig);
  assertDraftMayChange(initial.composer.value, '');
  let draft;
  let draftMayBeStaged = false;
  if (optionalMessage !== undefined && optionalMessage !== '') {
    try {
      draft = await writeDraft(api, inspected.target, optionalMessage, '', composerConfig);
      draftMayBeStaged = draft.changed === true;
    } catch (error) {
      if (error?.operationMayHaveCompleted === true) {
        throw partialStageError(error, { draftMayBeStaged: true, pickerMayBeOpen: false });
      }
      throw error;
    }
  }

  // The inner helper crosses into the Windows file picker. Re-read the exact
  // main chat immediately before that handoff; there is no stable CUA token to
  // preserve past the native picker boundary.
  try {
    await assertFreshChatGuard(api, inspected.target, composerConfig?.guard);
  } catch (error) {
    if (draftMayBeStaged) throw partialStageError(error, { draftMayBeStaged, pickerMayBeOpen: false });
    throw error;
  }

  // This is intentionally the inner Windows helper, not the outer facade:
  // the caller already holds this operation lock and has verified this exact
  // main chat. The guarded helper only stages the picker path and never clicks
  // Open.
  let result;
  try {
    result = await stageFileManual.call(automation.automation, filePath,
      {...inspected.target, title:inspected.window.title});
  } catch (error) {
    throw partialStageError(error, { draftMayBeStaged, pickerMayBeOpen: true });
  }
  if (result?.success !== true) {
    throw partialStageError(
      new LineToolError('LINE_STAGE_FAILED', result?.error || 'LINE did not verify file-picker staging.'),
      { draftMayBeStaged, pickerMayBeOpen: true },
    );
  }
  return {
    ...chatResult(chatName, inspected),
    staged: true,
    sent: false,
    requiresOpenApproval: true,
    deliveryVerified: false,
    ...(draft ? { draftStaged: true, draftVerification: draft.composerVerification } : {}),
    raw: withoutImages(result),
  };
}

function partialStageError(error, { draftMayBeStaged, pickerMayBeOpen }) {
  return new LineToolError(
    'LINE_STAGE_UNVERIFIED',
    'LINE file staging may have changed local state. Inspect LINE before retrying.',
    {
      operationMayHaveCompleted: true,
      draftMayBeStaged: draftMayBeStaged === true,
      pickerMayBeOpen: pickerMayBeOpen === true,
      previousCode: error?.code ?? error?.name ?? null,
    },
  );
}

function assertDraftMayChange(currentDraft, expectedDraft) {
  if (expectedDraft !== undefined && currentDraft !== expectedDraft) {
    throw new LineToolError(
      'LINE_DRAFT_CONFLICT',
      'The current LINE draft no longer matches expectedDraft; it was left unchanged.',
    );
  }
  if (expectedDraft === undefined && currentDraft !== '') {
    throw new LineToolError(
      'LINE_DRAFT_CONFLICT',
      'LINE already has a nonempty draft. Read it and pass that exact value as expectedDraft before replacing it.',
    );
  }
}

async function openFeature(api, inspected, chatName, feature, ocr, imageDimensions, deliveryMode, guard) {
  const spec = FEATURE_SPECS[feature];
  const priorWindows = inspected.lineWindows;
  // Search and several feature affordances are toggles. A fresh guarded
  // observation must short-circuit an already-open feature before it can be
  // clicked closed by a retry.
  const preflight = await assertFreshChatGuard(api, inspected.target, guard);
  const alreadyOpen = findFeatureStateProof(preflight, spec, inspected.window);
  if (alreadyOpen) return alreadyOpenFeatureResult(chatName, inspected, feature, alreadyOpen);

  let action;
  let beforeMain;
  let moreClickCompleted = false;

  try {
    if (spec.kind === 'shortcut') {
      action = await runUiInput(api, inspected.target, state => ({
        element: findKeyboardTarget(state, chatName),
      }), 'hotkey', { keys: spec.keys }, { screenshot: true, guard, deliveryMode });
      beforeMain = action.before;
    } else if (spec.kind === 'main-header-button') {
      action = await runUiInput(api, inspected.target, state => {
        // This is the authoritative fresh pre-input state. Search is a
        // toggle, so it must win over the earlier preflight if it appeared in
        // the intervening moment.
        const freshAlreadyOpen = findFeatureStateProof(state, spec, inspected.window);
        if (freshAlreadyOpen) return { skipInput: true, featureProof: freshAlreadyOpen };
        return findSearchNavigationTarget(state, inspected.window, imageDimensions);
      }, 'click', {}, { screenshot: true, guard, deliveryMode });
      if (action.inputSkipped === true) {
        return alreadyOpenFeatureResult(chatName, inspected, feature, action.resolved.featureProof);
      }
      beforeMain = action.before;
    } else {
      const openedMenu = await runUiInput(api, inspected.target, state => findMoreNavigationTarget(
        state,
        inspected.window,
        imageDimensions,
      ), 'click', {}, { screenshot: true, guard, deliveryMode });
      // The More input returned and its immediate state was observed. From
      // here onward the transient popup may be open even when later lookup or
      // selection refuses, so callers must inspect before retrying.
      moreClickCompleted = true;
      beforeMain = openedMenu.before;
      const menu = await resolveOpenedMenu(
        api,
        priorWindows,
        openedMenu,
        spec.labels,
        `${feature} menu item`,
        'LINE_FEATURE_UNAVAILABLE',
        ocr,
      );
      // The popup is a different LINE window and cannot itself prove the chat.
      // Check the original main header immediately before choosing its item.
      await assertFreshChatGuard(api, inspected.target, guard);
      action = await runUiInput(api, menu.target, async state => menuItemTarget(
        state,
        spec.labels,
        `${feature} menu item`,
        'LINE_FEATURE_UNAVAILABLE',
        menu.proof,
        ocr,
        menu.window,
      ), 'click', {}, {
        screenshot: true,
        allowTargetClosedAfter: menu.target.window_id !== inspected.target.window_id,
        deliveryMode,
      });
    }

    const outcome = await observeFeatureOutcome(api, inspected.target, priorWindows, spec, ocr, inspected.window);
    const proof = findFeatureProof(
      beforeMain,
      outcome.mainState,
      priorWindows,
      outcome.afterWindows,
      spec,
      outcome.childStates,
      inspected.window,
    ) ?? await findFeatureOcrProof(beforeMain, outcome.mainState, spec, ocr);
    if (!proof) {
      throw new LineToolError(
        'LINE_FEATURE_UNVERIFIED',
        `LINE did not expose a stable postcondition for ${feature}; do not assume the feature opened.`,
        { operationMayHaveCompleted: true },
      );
    }

    return {
      ...chatResult(chatName, inspected),
      feature,
      opened: proof.alreadyOpen !== true,
      ...(proof.alreadyOpen === true ? { alreadyOpen: true } : {}),
      verification: proof.kind,
      confidence: proof.confidence,
      raw: withoutImages(action.result),
    };
  } catch (error) {
    if (moreClickCompleted) throw featureNavigationUncertainty(error);
    throw error;
  }
}

function alreadyOpenFeatureResult(chatName, inspected, feature, proof) {
  return {
    ...chatResult(chatName, inspected),
    feature,
    opened: false,
    alreadyOpen: true,
    verification: proof.kind,
    confidence: proof.confidence,
  };
}

function featureNavigationUncertainty(error) {
  if (error?.operationMayHaveCompleted === true) return error;
  return new LineToolError(
    typeof error?.code === 'string' ? error.code : 'LINE_FEATURE_UNAVAILABLE',
    error?.message || 'LINE feature navigation could not be verified after opening its menu. Inspect LINE before retrying.',
    {
      ...(error?.details && typeof error.details === 'object' ? error.details : {}),
      operationMayHaveCompleted: true,
      previousCode: error?.code ?? error?.name ?? null,
    },
  );
}

function findKeyboardTarget(state, chatName) {
  const header = findChatHeaderProof(state, chatName);
  if (header?.element) return header.element;
  const roots = state.elements.filter(element => hasMarker(element, WINDOW_ROOT_MARKERS));
  if (roots.length === 1) return roots[0];
  throw new LineToolError(
    'LINE_UI_SELECTOR_UNAVAILABLE',
    'No explicit LINE chat header or root accessibility element was available for a fixed shortcut.',
    { candidateCount: roots.length },
  );
}

function findExactButton(state, labels, description) {
  const candidates = state.elements.filter(element => hasExactLabel(element, labels)
    && hasMarker(element, BUTTON_MARKERS));
  return oneExactElement(candidates, description, 'LINE_CONTROL_NOT_UNIQUE');
}

/**
 * Main-window Qt toolbar Groups acknowledge an accessibility click without
 * opening their feature. Only the strict anonymous toolbar shape gets a
 * screenshot-derived point; labelled semantic buttons retain their normal
 * snapshot-bound element route.
 */
function findSearchNavigationTarget(state, window, imageDimensions) {
  if (window?.title !== 'LINE') {
    const toolbar = findDetachedHeaderToolbar(state, window);
    return { pixel: mainHeaderToolbarScreenshotPoint(state, window, toolbar, toolbar.search, imageDimensions) };
  }
  const bands = findMainChatBands(state);
  if (bands.length > 1) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE exposed more than one possible main-chat header band.', { candidateCount: bands.length });
  }
  if (bands.length === 0) {
    return { element: findExactButton(state, FEATURE_SPECS.search.labels, 'LINE Search button') };
  }

  const labelled = findMainHeaderLabelledButton(state, bands[0], FEATURE_SPECS.search.labels, 'LINE Search button');
  if (labelled) return { element: labelled };

  const toolbar = findMainHeaderToolbar(state, bands);
  return {
    pixel: mainHeaderToolbarScreenshotPoint(state, window, toolbar, toolbar.search, imageDimensions),
  };
}

function findMoreNavigationTarget(state, window, imageDimensions) {
  if (window?.title !== 'LINE') {
    const toolbar = findDetachedHeaderToolbar(state, window);
    return { pixel: mainHeaderToolbarScreenshotPoint(state, window, toolbar, toolbar.more, imageDimensions) };
  }
  const bands = findMainChatBands(state);
  if (bands.length > 1) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE exposed more than one possible main-chat header band.', { candidateCount: bands.length });
  }
  if (bands.length === 0) return { element: findMoreButton(state) };

  const labelled = findMainHeaderLabelledButton(state, bands[0], MORE_LABELS, 'LINE More menu button');
  if (labelled) return { element: labelled };

  const toolbar = findMainHeaderToolbar(state, bands);
  return {
    pixel: mainHeaderToolbarScreenshotPoint(state, window, toolbar, toolbar.more, imageDimensions),
  };
}

function findMainHeaderLabelledButton(state, band, labels, description) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  const byIndex = new Map(elements
    .filter(element => elementIndex(element) !== undefined)
    .map(element => [elementIndex(element), element]));
  const candidates = elements.filter(element => hasExactLabel(element, labels)
    && hasMarker(element, BUTTON_MARKERS)
    && elementBelongsToMainHeaderBand(element, byIndex, [band]));
  if (candidates.length === 0) return undefined;
  return oneExactElement(candidates, description, 'LINE_CONTROL_NOT_UNIQUE');
}

function findMoreButton(state) {
  const bands = findMainChatBands(state);
  if (bands.length === 1) {
    // A main chat has an anchored anonymous toolbar. Never let an unrelated
    // labelled More control elsewhere in the window override that target.
    return findMainHeaderToolbar(state).more.element;
  }
  if (bands.length > 1) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE exposed more than one possible main-chat header band.', { candidateCount: bands.length });
  }
  const labelled = state.elements.filter(element => hasExactLabel(element, MORE_LABELS)
    && hasMarker(element, BUTTON_MARKERS));
  if (labelled.length === 1) return labelled[0];
  if (labelled.length > 1) {
    return oneExactElement(labelled, 'LINE More menu button', 'LINE_CONTROL_NOT_UNIQUE');
  }
  throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE More menu button was not uniquely exposed by accessibility.', { candidateCount: 0 });
}

/**
 * Current Qt builds expose four anonymous, contiguous toolbar controls at the
 * right edge of the structurally proven main-chat header: search, two other
 * 24px controls, then the 16px More affordance. This is intentionally bound
 * to that exact header/body relationship, never to a global coordinate or
 * arbitrary element index.
 */
function findMainHeaderToolbar(state, bands = findMainChatBands(state)) {
  if (bands.length !== 1) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE main-header toolbar was not uniquely exposed by accessibility.', { candidateCount: bands.length });
  }
  const band = bands[0];
  const header = findContentHeaderContainer(state, band);
  const headerIndex = elementIndex(header);
  const headerFrame = elementFrame(header);
  if (!header || headerIndex === undefined || !headerFrame) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE main-header toolbar did not have one structural header container.', { candidateCount: 0 });
  }
  return findAnonymousHeaderToolbar(state, header, band);
}

/**
 * Detached chats have an announcement strip between the title and the body,
 * so the main-window adjacent-header/body rule cannot identify their title.
 * Anchor the toolbar to the one top-level window root and one full-width,
 * upper header containing the observed anonymous More control.
 */
function findDetachedHeaderToolbar(state, window) {
  const expected = windowBoundsFrame(window);
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  const byIndex = new Map(elements
    .filter(element => elementIndex(element) !== undefined)
    .map(element => [elementIndex(element), element]));
  const roots = elements.filter(element => {
    const frame = elementFrame(element);
    return normalized(element?.role) === 'window' && frame && expected
      && ['x', 'y', 'width', 'height'].every(key => Math.abs(frame[key] - expected[key]) <= 1);
  });
  if (roots.length !== 1) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE detached window root was not unique.', { candidateCount: roots.length });
  }
  const root = roots[0];
  const rootIndex = elementIndex(root);
  const candidates = elements.filter(element => {
    const frame = elementFrame(element);
    const index = elementIndex(element);
    if (normalized(element?.role) !== 'group' || !frame || index === undefined
      || Math.abs(frame.x - expected.x) > 1 || Math.abs(frame.width - expected.width) > 1
      || frame.y < expected.y || frame.y - expected.y > 96
      || frame.height < 40 || frame.height > 64
      || !rectInside(frame, expected)) return false;
    const ancestors = ancestorChain(element, byIndex);
    return ancestors.some(ancestor => elementIndex(ancestor) === rootIndex)
      && elements.some(child => parentIndex(child) === index
        && normalized(child?.role) === 'group'
        && elementFrame(child)?.width === 16
        && elementFrame(child)?.height === 24);
  });
  if (candidates.length !== 1) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE detached chat header toolbar was not unique.', { candidateCount: candidates.length });
  }
  const header = candidates[0];
  const headerFrame = elementFrame(header);
  return findAnonymousHeaderToolbar(state, header, { pane: header, paneFrame: headerFrame });
}

function findAnonymousHeaderToolbar(state, header, band) {
  const headerIndex = elementIndex(header);
  const headerFrame = elementFrame(header);
  const children = (Array.isArray(state?.elements) ? state.elements : [])
    .filter(element => parentIndex(element) === headerIndex && normalized(element?.role) === 'group')
    .map(element => ({ element, frame: elementFrame(element) }))
    .filter(candidate => candidate.frame
      && rectInside(candidate.frame, headerFrame)
      && candidate.element.enabled !== false);
  const moreCandidates = children.filter(candidate => candidate.frame.width === 16 && candidate.frame.height === 24);
  if (moreCandidates.length !== 1) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE More menu control did not match the observed header structure.', { candidateCount: moreCandidates.length });
  }
  const more = moreCandidates[0];
  const rightmost = Math.max(...children.map(candidate => candidate.frame.x + candidate.frame.width));
  if (more.frame.x + more.frame.width !== rightmost) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE More menu control was not the observed rightmost header child.', { candidateCount: moreCandidates.length });
  }

  const toolbar = [more];
  for (let position = 1; position < 4; position += 1) {
    const nextRight = toolbar[0].frame.x;
    const preceding = children.filter(candidate => candidate.frame.width === 24
      && candidate.frame.height === 24
      && candidate.frame.x + candidate.frame.width <= nextRight
      && nextRight - (candidate.frame.x + candidate.frame.width) <= 8);
    if (preceding.length !== 1) {
      throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE main-header toolbar did not expose one contiguous search control sequence.', { candidateCount: preceding.length });
    }
    toolbar.unshift(preceding[0]);
  }
  const precedingSearch = children.filter(candidate => candidate.frame.width === 24
    && candidate.frame.height === 24
    && candidate.frame.x + candidate.frame.width <= toolbar[0].frame.x
    && toolbar[0].frame.x - (candidate.frame.x + candidate.frame.width) <= 8);
  if (precedingSearch.length !== 0) {
    throw new LineToolError('LINE_CONTROL_NOT_UNIQUE', 'LINE main-header toolbar had an unexpected extra anonymous control.', { candidateCount: precedingSearch.length });
  }
  return { search: toolbar[0], more, toolbar, band, headerFrame };
}

function mainHeaderToolbarScreenshotPoint(state, window, toolbar, control, imageDimensions) {
  if (!isStrictAnonymousMainHeaderToolbar(toolbar) || !toolbar.toolbar.includes(control)) {
    throw new LineToolError(
      'LINE_UI_SELECTOR_UNAVAILABLE',
      'LINE did not expose a strict anonymous main-header toolbar control for screenshot navigation.',
    );
  }
  const images = Array.isArray(state?.images) ? state.images : [];
  if (images.length !== 1 || !images[0] || typeof images[0] !== 'object') {
    throw new LineToolError('LINE_UI_SELECTOR_UNAVAILABLE', 'LINE did not expose one fresh screenshot for main-header navigation.');
  }

  let dimensions;
  try {
    dimensions = imageDimensions(images[0]);
  } catch {
    throw new LineToolError('LINE_UI_SELECTOR_UNAVAILABLE', 'LINE screenshot dimensions could not be verified for main-header navigation.');
  }
  if (!validImageDimensions(dimensions) || !matchesReportedScreenshotDimensions(state, dimensions)) {
    throw new LineToolError('LINE_UI_SELECTOR_UNAVAILABLE', 'LINE screenshot dimensions were invalid for main-header navigation.');
  }

  const rootFrame = findScreenshotRootFrame(state, window, toolbar.band);
  const region = rootFrame ? frameInScreenshot(control.frame, rootFrame, dimensions) : undefined;
  if (!region) {
    throw new LineToolError('LINE_UI_SELECTOR_UNAVAILABLE', 'LINE main-header control could not be grounded inside the fresh screenshot.');
  }
  const point = {
    x: region.x + Math.floor(region.width / 2),
    y: region.y + Math.floor(region.height / 2),
  };
  if (!isScreenshotPointInBounds(point, dimensions)) {
    throw new LineToolError('LINE_UI_SELECTOR_UNAVAILABLE', 'LINE main-header screenshot point was outside the captured image.');
  }
  return point;
}

function isStrictAnonymousMainHeaderToolbar(toolbar) {
  return Array.isArray(toolbar?.toolbar)
    && toolbar.toolbar.length === 4
    && toolbar.toolbar.every(candidate => normalized(candidate?.element?.role) === 'group'
      && exactLabels(candidate.element).length === 0);
}

function isScreenshotPointInBounds(point, dimensions) {
  return Number.isInteger(point?.x) && Number.isInteger(point?.y)
    && point.x >= 0 && point.y >= 0
    && point.x < dimensions.width && point.y < dimensions.height;
}

function findExactMenuItem(state, labels, description) {
  const candidates = menuItemCandidates(state, labels);
  return oneExactElement(candidates, description, 'LINE_FEATURE_UNAVAILABLE');
}

function menuItemCandidates(state, labels) {
  return state.elements.filter(element => hasExactLabel(element, labels)
    && hasMarker(element, MENU_ITEM_MARKERS));
}

async function menuItemProof(before, after, labels, description, code, ocr) {
  const accessible = menuItemCandidates(after, labels);
  if (accessible.length === 1) return undefined;
  if (accessible.length > 1) {
    throw new LineToolError(
      code,
      `${description}: expected one exact accessible control, found ${accessible.length}.`,
      { candidateCount: accessible.length },
    );
  }

  const proof = await newlyVisibleOcrLabel(before, after, labels, ocr);
  if (proof) return proof;
  throw new LineToolError(
    code,
    `${description}: LINE exposed no unique exact accessible or screenshot-grounded menu control.`,
  );
}

async function resolveOpenedMenu(api, priorWindows, openedMenu, labels, description, code, ocr) {
  const embedded = menuItemCandidates(openedMenu.after, labels);
  if (embedded.length === 1) return { target: openedMenu.target, proof: undefined };
  if (embedded.length > 1) {
    throw new LineToolError(code, `${description}: expected one exact accessible control, found ${embedded.length}.`, { candidateCount: embedded.length });
  }
  const embeddedOcr = await newlyVisibleOcrLabel(openedMenu.before, openedMenu.after, labels, ocr);
  if (embeddedOcr) return { target: openedMenu.target, proof: embeddedOcr };

  const popup = await findNewMenuSurface(api, priorWindows, labels, ocr);
  if (popup) return popup;
  throw new LineToolError(
    code,
    `${description}: LINE did not expose one new exact accessible or screenshot-grounded menu window.`,
  );
}

async function findNewMenuSurface(api, priorWindows, labels, ocr) {
  let menu = await findNewMenuSurfaceOnce(api, priorWindows, labels, ocr);
  if (menu) return menu;
  // LINE's Qt popup can appear after the main-window click readback. Wait once
  // and re-enumerate; never replay the click merely because the popup is late.
  await new Promise(resolve => setTimeout(resolve, 250));
  menu = await findNewMenuSurfaceOnce(api, priorWindows, labels, ocr);
  return menu;
}

async function findNewMenuSurfaceOnce(api, priorWindows, labels, ocr) {
  // Qt can keep a popup HWND hidden and reveal it for the More menu. Its
  // identity then predates the click, but its visible menu surface does not.
  const known = new Set(priorWindows.filter(isVisibleLineWindow).map(windowIdentity));
  const windows = (await listLineWindows(api))
    .filter(window => isVisibleLineWindow(window) && !known.has(windowIdentity(window)));
  const candidates = [];
  for (const window of windows) {
    const target = targetFromWindow(window);
    let state;
    try {
      state = await snapshot(api, target, { screenshot: true });
    } catch {
      continue;
    }
    const accessible = menuItemCandidates(state, labels);
    if (accessible.length > 1) continue;
    if (accessible.length === 1) {
      candidates.push({ target, window, proof: undefined });
      continue;
    }
    const observation = await observeUniqueOcrLabel(state, labels, ocr, window);
    if (observation?.match) candidates.push({ target, window, proof: observation });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function observeFeatureOutcome(api, mainTarget, priorWindows, spec, ocr, window) {
  // Reobserve the original main window because a popup-menu target commonly
  // closes immediately after its item is chosen.
  const mainState = await snapshot(api, mainTarget, { screenshot: true });
  let afterWindows = await listLineWindows(api);
  let childStates = await snapshotNewLineWindows(api, priorWindows, afterWindows);
  if (!featureWindowProof(childStates, spec) && !findFeatureStateProof(mainState, spec, window)) {
    await new Promise(resolve => setTimeout(resolve, 250));
    afterWindows = await listLineWindows(api);
    childStates = await snapshotNewLineWindows(api, priorWindows, afterWindows);
  }
  return { mainState, afterWindows, childStates };
}

async function snapshotNewLineWindows(api, priorWindows, afterWindows) {
  const known = new Set(priorWindows.filter(isVisibleLineWindow).map(windowIdentity));
  const states = [];
  for (const window of afterWindows) {
    if (!isVisibleLineWindow(window) || known.has(windowIdentity(window))) continue;
    const target = targetFromWindow(window);
    try {
      states.push({ window, state: await snapshot(api, target, { screenshot: true }) });
    } catch {
      // A transient menu/panel cannot prove a feature unless its next fresh
      // state is inspectable.
    }
  }
  return states;
}

function featureWindowProof(childStates, spec) {
  return childStates.filter(child => featureSurfaces(child.state, spec).length === 1
    || spec.labels.includes(child.window.title)).length === 1;
}

async function menuItemTarget(state, labels, description, code, priorProof, ocr, window) {
  const accessible = menuItemCandidates(state, labels);
  if (accessible.length === 1) return { element: accessible[0] };
  if (accessible.length > 1) {
    throw new LineToolError(
      code,
      `${description}: expected one exact accessible control, found ${accessible.length}.`,
      { candidateCount: accessible.length },
    );
  }
  if (!priorProof) {
    throw new LineToolError(code, `${description}: a fresh exact control was not available.`);
  }

  const current = await observeUniqueOcrLabel(state, labels, ocr, window);
  if (!current?.match || !sameOcrControl(priorProof.match, current.match)) {
    throw new LineToolError(
      code,
      `${description}: the custom-drawn menu label was not stable in a fresh grounded screenshot.`,
    );
  }
  const pixel = ocrCenterPoint(current.match);
  if (!pixel) {
    throw new LineToolError(code, `${description}: OCR did not provide a bounded click point.`);
  }
  return { pixel: { x: Math.round(pixel.x), y: Math.round(pixel.y) } };
}

async function newlyVisibleOcrLabel(before, after, labels, ocr) {
  const beforeObservation = await observeUniqueOcrLabel(before, labels, ocr);
  const afterObservation = await observeUniqueOcrLabel(after, labels, ocr);
  if (!beforeObservation || !afterObservation || beforeObservation.match !== null || !afterObservation.match) {
    return undefined;
  }
  return afterObservation;
}

async function observeUniqueOcrLabel(state, labels, ocr, window) {
  const recognized = await recognizeGroundedWindowImage(state, ocr, window);
  if (!recognized) return undefined;
  return { match: findUniqueOcrLabel(recognized, labels, ocr.findImageLabel) };
}

function findUniqueOcrLabel(ocr, labels, findLabel) {
  let first;
  try {
    first = findLabel(ocr, labels);
  } catch {
    return undefined;
  }
  if (first === null) return null;
  if (!validOcrLabelMatch(first, ocr)) return undefined;

  const matchIndexes = first.lines.map(line => ocr.lines.indexOf(line));
  if (matchIndexes.some(index => index < 0)
    || new Set(matchIndexes).size !== matchIndexes.length
    || matchIndexes.some((index, position) => position > 0 && index !== matchIndexes[position - 1] + 1)) {
    return undefined;
  }
  const omitted = {
    ...ocr,
    lines: ocr.lines.filter((_, index) => !matchIndexes.includes(index)),
  };
  try {
    if (findLabel(omitted, labels) !== null) return undefined;
  } catch {
    return undefined;
  }
  return {
    ...first,
    imageWidth: ocr.width,
    imageHeight: ocr.height,
  };
}

function validOcrLabelMatch(match, ocr) {
  if (!match || typeof match !== 'object' || !Array.isArray(match.lines) || match.lines.length === 0) return false;
  const x = Number(match.x);
  const y = Number(match.y);
  const width = Number(match.width);
  const height = Number(match.height);
  return [x, y, width, height].every(Number.isFinite)
    && width > 0 && height > 0
    && x >= 0 && y >= 0
    && x + width <= ocr.width && y + height <= ocr.height;
}

function sameOcrControl(previous, current) {
  if (previous.label !== current.label
    || previous.imageWidth !== current.imageWidth
    || previous.imageHeight !== current.imageHeight) return false;
  const tolerance = 1;
  return ['x', 'y', 'width', 'height'].every(key => Math.abs(previous[key] - current[key]) <= tolerance);
}

function ocrCenterPoint(match) {
  const x = match.x + match.width / 2;
  const y = match.y + match.height / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || y < 0 || x >= match.imageWidth || y >= match.imageHeight) return undefined;
  return { x, y };
}

function oneExactElement(candidates, description, code) {
  if (candidates.length !== 1) {
    throw new LineToolError(
      code,
      `${description}: expected one exact accessible control, found ${candidates.length}.`,
      { candidateCount: candidates.length },
    );
  }
  return candidates[0];
}

function findFeatureProof(before, after, priorWindows, afterWindows, spec, childStates = [], window) {
  const afterProof = findFeatureStateProof(after, spec, window);
  const beforeProof = findFeatureStateProof(before, spec, window);
  if (afterProof && !beforeProof) {
    return { ...afterProof, alreadyOpen: false };
  }
  if (afterProof && beforeProof) {
    return { ...afterProof, alreadyOpen: true };
  }

  const previousIds = new Set(priorWindows.filter(isVisibleLineWindow).map(windowIdentity));
  const children = afterWindows.filter(window => !previousIds.has(windowIdentity(window))
    && isVisibleLineWindow(window)
    && spec.labels.includes(window.title));
  if (children.length === 1) {
    return { kind: 'exact-feature-child-window-title', confidence: 'high', alreadyOpen: false };
  }

  const childSurfaces = childStates.filter(child => featureSurfaces(child.state, spec).length === 1);
  if (childSurfaces.length === 1) {
    return { kind: 'exact-feature-child-surface', confidence: 'medium', alreadyOpen: false };
  }

  // The before snapshot is intentionally accepted as an argument so callers
  // cannot accidentally weaken this to action-result-only success later.
  void before;
  return undefined;
}

function findFeatureStateProof(state, spec, window) {
  const surfaces = featureSurfaces(state, spec);
  if (surfaces.length === 1) {
    return { kind: 'exact-feature-surface', confidence: 'medium' };
  }
  if (spec.kind === 'main-header-button') {
    if (window?.title === 'LINE' && findMainSearchBar(state)) {
      return { kind: 'structural-main-chat-search-bar', confidence: 'medium' };
    }
    if (window?.title !== 'LINE' && findDetachedSearchBar(state, window)) {
      return { kind: 'structural-detached-chat-search-bar', confidence: 'medium' };
    }
  }
  return undefined;
}

/** The detached chat's announcement strip separates its header and body. */
function findDetachedSearchBar(state, window) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  if (elements.some(element => hasMarker(element, MODAL_MARKERS))) return undefined;
  let toolbar;
  try {
    toolbar = findDetachedHeaderToolbar(state, window);
  } catch {
    return undefined;
  }
  const header = toolbar.band.pane;
  const headerFrame = toolbar.headerFrame;
  const byIndex = new Map(elements
    .filter(element => elementIndex(element) !== undefined)
    .map(element => [elementIndex(element), element]));
  const bodies = elements.filter(element => {
    const frame = elementFrame(element);
    return normalized(element?.role) === 'group'
      && parentIndex(element) === parentIndex(header)
      && frame
      && Math.abs(frame.x - headerFrame.x) <= 1
      && Math.abs(frame.width - headerFrame.width) <= 1
      && frame.y >= headerFrame.y + headerFrame.height
      && frame.y - (headerFrame.y + headerFrame.height) <= 24
      && frame.height > headerFrame.height * 4;
  });
  if (bodies.length !== 1) return undefined;
  const body = bodies[0];
  const band = { bodyIndex: elementIndex(body), bodyFrame: elementFrame(body) };
  const candidates = elements.filter(element => isMainSearchBarEdit(element, band, elements, byIndex));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The live Search panel has no UIA label on its Edit. Its safe proof is one
 * non-viewport Edit in the unique active-chat body, inside the panel's
 * full-width top strip and its compact magnifier/input bar. This excludes the
 * sidebar/global search and the rich composer without relying on coordinates
 * or an unscoped anonymous Edit.
 */
function findMainSearchBar(state) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  if (elements.some(element => hasMarker(element, MODAL_MARKERS))) return undefined;
  const bands = findMainChatBands(state);
  if (bands.length !== 1 || !Number.isInteger(bands[0].bodyIndex)) return undefined;
  const band = bands[0];
  const byIndex = new Map(elements
    .filter(element => elementIndex(element) !== undefined)
    .map(element => [elementIndex(element), element]));
  const candidates = elements.filter(element => isMainSearchBarEdit(element, band, elements, byIndex));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isMainSearchBarEdit(element, band, elements, byIndex) {
  const index = elementIndex(element);
  const frame = elementFrame(element);
  if (normalized(element?.role) !== 'edit' || index === undefined || !frame
    || isViewportEdit(element, elements)
    || !rectInside(frame, band.bodyFrame)
    || !hasAncestorIndex(element, band.bodyIndex, byIndex)) return false;

  const container = byIndex.get(parentIndex(element));
  const containerIndex = elementIndex(container);
  const containerFrame = elementFrame(container);
  if (!container || containerIndex === undefined || normalized(container.role) !== 'group'
    || !containerFrame || !rectInside(frame, containerFrame)
    || containerFrame.height < 24 || containerFrame.height > 48
    || containerFrame.width <= band.bodyFrame.width * 0.55
    || containerFrame.width >= band.bodyFrame.width - 4) return false;

  const strip = byIndex.get(parentIndex(container));
  const stripFrame = elementFrame(strip);
  if (!strip || normalized(strip.role) !== 'group' || !stripFrame
    || !rectInside(containerFrame, stripFrame)
    || !hasAncestorIndex(strip, band.bodyIndex, byIndex)
    || Math.abs(stripFrame.x - band.bodyFrame.x) > 1
    || Math.abs(stripFrame.y - band.bodyFrame.y) > 1
    || Math.abs(stripFrame.width - band.bodyFrame.width) > 1
    || stripFrame.height < 40 || stripFrame.height > 96) return false;

  if (frame.height < 20 || frame.height > containerFrame.height
    || frame.width <= containerFrame.width * 0.6) return false;
  const directChildren = elements.filter(child => parentIndex(child) === containerIndex);
  const nonViewportEdits = directChildren.filter(child => normalized(child?.role) === 'edit'
    && !isViewportEdit(child, elements));
  if (nonViewportEdits.length !== 1 || nonViewportEdits[0] !== element) return false;
  const leadingIcons = directChildren
    .filter(child => normalized(child?.role) === 'group' && exactLabels(child).length === 0)
    .map(child => elementFrame(child))
    .filter(childFrame => childFrame
      && rectInside(childFrame, containerFrame)
      && childFrame.width >= 20 && childFrame.width <= 28
      && childFrame.height >= 20 && childFrame.height <= 28
      && childFrame.x + childFrame.width <= frame.x
      && Math.abs(childFrame.y - frame.y) <= 6);
  return leadingIcons.length === 1;
}

function featureSurfaces(state, spec) {
  return state.elements.filter(element => hasExactLabel(element, spec.labels)
    && (hasMarker(element, SURFACE_MARKERS)
      || (spec.allowEdit === true && hasMarker(element, new Set(['edit'])))));
}

async function findFeatureOcrProof(before, after, spec, ocr) {
  const proof = await newlyVisibleOcrLabel(before, after, spec.labels, ocr);
  return proof
    ? { kind: 'grounded-ocr-feature-label', confidence: 'low', alreadyOpen: false }
    : undefined;
}

function windowIdentity(window) {
  return `${window?.pid}:${window?.window_id}`;
}

async function runMessageAction(
  api,
  inspected,
  chatName,
  messageText,
  action,
  replyText,
  composerConfig,
  ocr,
  visual,
  replySourceBinding,
) {
  const replyPhase = {
    contextMenuMayBeOpen: false,
    actionSelected: false,
    replyContextMayBeOpen: false,
    draftMayBeStaged: false,
  };
  let rightClick;
  try {
    rightClick = await runUiInput(api, inspected.target, state => {
      // Reply replaces LINE's current reply context. Check its readable
      // composer and any accessible quote context in this authoritative
      // pre-right-click state, before opening a menu that can change either.
      if (action === 'reply') assertReplyCanStart(state, composerConfig);
      return replySourceBinding
        ? resolveVisuallyBoundReplyTarget(state, messageText, replySourceBinding, inspected.window, composerConfig?.guard, visual)
        : { element: findExactMessage(state, messageText) };
    }, 'right_click', {}, { screenshot: true, guard: composerConfig?.guard });
  } catch (error) {
    if (action === 'reply' && error?.operationMayHaveCompleted === true) {
      replyPhase.contextMenuMayBeOpen = true;
      throw replyActionUncertainty(error, replyPhase);
    }
    throw error;
  }
  if (action === 'reply') replyPhase.contextMenuMayBeOpen = true;

  try {

  // The action item is resolved from a fresh state, not from the pre-menu
  // tree. A custom-drawn menu can use a pixel only after exact OCR proves it
  // appeared and is still at the same grounded location.
  const menu = await resolveOpenedMenu(
    api,
    inspected.lineWindows,
    rightClick,
    ACTION_LABELS[action],
    `${action} message action`,
    'LINE_ACTION_UNAVAILABLE',
    ocr,
  );
  // The context menu is a separate transient target. Recheck the original
  // verified chat before selecting its item; do not assume its HWND stayed on
  // the same conversation while the menu was visible.
  await assertFreshChatGuard(api, inspected.target, composerConfig?.guard);
  let selected;
  try {
    selected = await runUiInput(api, menu.target, async state => {
      if (action === 'reply') {
        // This is deliberately inside the menu resolver: it is the last
        // main-chat observation before the menu-item click, including when
        // the Qt popup lives in a detached window.
        await assertFreshReplyCanStart(api, inspected.target, composerConfig);
      }
      return menuItemTarget(
        state,
        ACTION_LABELS[action],
        `${action} message action`,
        'LINE_ACTION_UNAVAILABLE',
        menu.proof,
        ocr,
      );
    }, 'click', {}, {
      screenshot: true,
      allowTargetClosedAfter: menu.target.window_id !== inspected.target.window_id,
    });
  } catch (error) {
    if (action === 'reply' && error?.operationMayHaveCompleted === true) {
      replyPhase.actionSelected = true;
      replyPhase.replyContextMayBeOpen = true;
    }
    throw error;
  }
  if (action === 'reply') {
    replyPhase.actionSelected = true;
    replyPhase.replyContextMayBeOpen = true;
  }
  // A detached Qt context menu can remain inspectable for one short moment
  // after its item click. Its state is never the reply/translation/forward
  // postcondition: reobserve the original chat window in that case.
  const selectedState = sameTarget(menu.target, inspected.target) && selected.after
    ? selected.after
    : await observeMainAfterAction(api, inspected.target);

  const raw = {
    rightClick: withoutImages(rightClick.result),
    action: withoutImages(selected.result),
  };
  if (action === 'copy') {
    await verifyCopiedText(api, messageText);
    return {
      ...chatResult(chatName, inspected),
      action,
      clipboardVerified: true,
      verification: 'exact-clipboard-readback',
      confidence: 'high',
      raw,
    };
  }
  if (action === 'reply') {
    let replySurface;
    try {
      replySurface = findReplySurface(selectedState, messageText, composerConfig);
    } catch (error) {
      if (replySourceBinding) {
        return await pendingVisualReplyQuoteResult(
          chatName,
          inspected,
          replySourceBinding,
          selectedState,
          raw,
          replyText,
          error,
          api,
          composerConfig?.guard,
          visual,
        );
      }
      throw error;
    }
    if (replyText !== undefined) {
      if (replySurface.composer.value !== '') {
        throw new LineToolError('LINE_DRAFT_CONFLICT', 'LINE reply draft changed after Reply was selected.');
      }
      const staged = await stageReplyDraft(
        api,
        inspected.target,
        messageText,
        replyText,
        composerConfig,
      );
      replyPhase.draftMayBeStaged = staged.draftMayBeStaged === true;
      raw.draft = withoutImages(staged.raw);
    }
    return {
      ...chatResult(chatName, inspected),
      action,
      staged: true,
      sent: false,
      quoteVerified: true,
      draftStaged: replyText !== undefined,
      verification: replySourceBinding
        ? 'caller-confirmed-source-region-plus-exact-reply-quote-and-composer'
        : 'exact-reply-quote-and-composer',
      confidence: 'high',
      ...(replySourceBinding ? replySourceBindingResult(replySourceBinding) : {}),
      raw,
    };
  }
  if (action === 'translate') {
    if (!findTranslationSurface(selectedState)) {
      throw new LineToolError(
        'LINE_TRANSLATION_UNVERIFIED',
        'LINE did not expose a translation surface after the action; do not assume translation ran.',
        { operationMayHaveCompleted: true },
      );
    }
    return {
      ...chatResult(chatName, inspected),
      action,
      translationVisible: true,
      verification: 'exact-translation-surface',
      confidence: 'medium',
      raw,
    };
  }

  if (!findForwardRecipientDialog(selectedState)) {
    throw new LineToolError(
      'LINE_FORWARD_UNVERIFIED',
      'LINE did not expose a verified forward-recipient dialog; no send was attempted.',
      { operationMayHaveCompleted: true },
    );
  }
  return {
    ...chatResult(chatName, inspected),
    action,
    staged: true,
    sent: false,
    verification: 'exact-forward-recipient-dialog',
    confidence: 'high',
    raw,
  };
  } catch (error) {
    if (action !== 'reply') throw error;
    if (error?.details?.draftMayBeStaged === true) replyPhase.draftMayBeStaged = true;
    throw replyActionUncertainty(error, replyPhase);
  }
}

async function observeMainAfterAction(api, target) {
  try {
    return await snapshot(api, target, { screenshot: true });
  } catch (error) {
    throw new LineToolError(
      'LINE_UI_POSTCONDITION_UNAVAILABLE',
      'LINE action returned, but the original chat window could not be observed afterward. Inspect LINE before retrying.',
      { operationMayHaveCompleted: true, previousCode: error?.code ?? error?.name ?? null },
    );
  }
}

function findExactMessage(state, messageText) {
  const candidates = state.elements.filter(element => hasExactLabel(element, [messageText])
    && hasMarker(element, MESSAGE_MARKERS));
  return oneExactElement(candidates, 'exact LINE message', 'LINE_MESSAGE_NOT_UNIQUE');
}

async function resolveVisuallyBoundReplyTarget(
  state,
  messageText,
  binding,
  window,
  guard,
  visual,
) {
  const view = replySourceVisualView(state, window, guard, visual);
  if (!view || !sameRegion(binding.messageBounds, view.messageBounds)) {
    throw new LineToolError(
      'LINE_REPLY_SOURCE_STALE',
      'The LINE message area changed after visual source confirmation. No reply action was taken.',
    );
  }
  const fingerprint = await captureReplySourceFingerprint(view.image, binding.sourceRect, visual);
  if (!fingerprint || !sameReplySourceFingerprint(binding.fingerprint, fingerprint)) {
    throw new LineToolError(
      'LINE_REPLY_SOURCE_STALE',
      'The caller-confirmed LINE source pixels changed before Reply. No reply action was taken.',
    );
  }
  const accessible = selectAccessibleReplyBubble(
    accessibleReplyMessageCandidates(state, messageText, view),
    binding.sourcePoint,
  );
  return accessible ? { element: accessible } : { pixel: binding.sourcePoint };
}

function replySourceBindingResult(binding) {
  return {
    localSourceRef: binding.source.sourceRef,
    uiSourceRefVerified: false,
    sourceIdentityVerification: 'caller-confirmed-fresh-visual-source-region',
  };
}

async function pendingVisualReplyQuoteResult(chatName, inspected, binding, state, raw, replyText, error, api, guard, visual) {
  await assertChatGuard(api, inspected.target, state, guard);
  const view = replySourceVisualView(state, inspected.window, guard, visual, { includeComposer: true });
  const image = view ? await captureReplyViewImage(view, visual) : undefined;
  if (!image) {
    throw new LineToolError(
      'LINE_REPLY_UNVERIFIED',
      'LINE may have opened a reply context, but no verified chat-only screenshot crop was available. Inspect LINE before retrying.',
      { operationMayHaveCompleted: true, previousCode: error?.code ?? error?.name ?? null },
    );
  }
  return {
    ...chatResult(chatName, inspected),
    action: 'reply',
    staged: false,
    sent: false,
    quoteVerified: false,
    draftStaged: false,
    operationMayHaveCompleted: true,
    requiresVisualQuoteConfirmation: true,
    visualQuoteVerification: {
      sourceText: binding.source.text,
      expectedSender: binding.source.sender,
      expectedDate: binding.source.date,
      expectedTime: binding.source.time,
      replyTextNotStaged: replyText !== undefined,
      requiredObservation: 'Inspect the newly visible quote sender and source preview before staging or retrying.',
    },
    verification: 'reply-action-pending-visual-quote-confirmation',
    confidence: 'pending',
    ...replySourceBindingResult(binding),
    raw,
    images: [image],
  };
}

function replyQuoteContexts(state) {
  return state.elements.filter(element => hasMarker(element, QUOTE_MARKERS));
}

function assertReplyCanStart(state, composerConfig) {
  const composer = findComposer(state, composerConfig);
  if (composer.value !== '') {
    throw new LineToolError(
      'LINE_DRAFT_CONFLICT',
      'LINE already has a nonempty draft before Reply; it was left unchanged.',
    );
  }
  const quoteContexts = replyQuoteContexts(state);
  if (quoteContexts.length !== 0) {
    throw new LineToolError(
      'LINE_REPLY_CONTEXT_CONFLICT',
      'LINE already has an accessible quoted-reply context before Reply; it was left unchanged.',
      { candidateCount: quoteContexts.length },
    );
  }
  return composer;
}

async function assertFreshReplyCanStart(api, target, composerConfig) {
  const state = await assertFreshChatGuard(api, target, composerConfig?.guard);
  return assertReplyCanStart(state, composerConfig);
}

function replyActionUncertainty(error, phase) {
  return new LineToolError(
    typeof error?.code === 'string' ? error.code : 'LINE_REPLY_UNVERIFIED',
    'LINE reply may have changed local state. Inspect LINE before retrying.',
    {
      ...(error?.details && typeof error.details === 'object' ? error.details : {}),
      operationMayHaveCompleted: true,
      contextMenuMayBeOpen: phase?.contextMenuMayBeOpen === true,
      actionSelected: phase?.actionSelected === true,
      replyContextMayBeOpen: phase?.replyContextMayBeOpen === true,
      draftMayBeStaged: phase?.draftMayBeStaged === true,
      previousCode: error?.code ?? error?.name ?? null,
    },
  );
}

async function verifyCopiedText(api, messageText) {
  const result = await api.call('clipboard_read', { include_text: true });
  const value = clipboardText(result);
  if (value !== messageText) {
    throw new LineToolError(
      'LINE_COPY_UNVERIFIED',
      'LINE copy did not produce the exact requested message on the clipboard.',
      { operationMayHaveCompleted: true },
    );
  }
}

function clipboardText(result) {
  if (typeof result === 'string') return result;
  for (const key of ['text', 'value', 'clipboard_text', 'clipboardText']) {
    if (typeof result?.[key] === 'string') return result[key];
  }
  return undefined;
}

function findReplySurface(state, messageText, composerConfig) {
  const quote = replyQuoteContexts(state)
    .filter(element => hasExactLabel(element, [messageText]));
  if (quote.length !== 1) {
    throw new LineToolError(
      'LINE_REPLY_UNVERIFIED',
      'LINE did not expose one exact quoted-reply context after the reply action.',
      { candidateCount: quote.length, operationMayHaveCompleted: true },
    );
  }
  return { quote: quote[0], composer: findComposer(state, composerConfig) };
}

async function stageReplyDraft(api, target, messageText, replyText, composerConfig) {
  let staged;
  try {
    staged = await runUiInput(api, target, state => {
      const surface = findReplySurface(state, messageText, composerConfig);
      if (surface.composer.value !== '') {
        throw new LineToolError('LINE_DRAFT_CONFLICT', 'LINE reply draft changed before it could be staged.');
      }
      return { element: surface.composer.element };
    }, 'set_value', { value: replyText }, { guard: composerConfig?.guard });
  } catch (error) {
    if (error?.operationMayHaveCompleted === true) throw replyDraftUncertainty(error);
    throw error;
  }

  let after;
  try {
    after = findReplySurface(staged.after, messageText, composerConfig);
  } catch (error) {
    throw replyDraftUncertainty(new LineToolError(
      'LINE_REPLY_UNVERIFIED',
      'LINE reply staging did not preserve an exact quoted context and readable composer.',
      { previousCode: error?.code },
    ));
  }
  if (after.composer.value !== replyText) {
    throw replyDraftUncertainty(new LineToolError(
      'LINE_DRAFT_WRITE_UNVERIFIED',
      'LINE reply composer readback did not equal the requested staged reply.',
    ));
  }
  return { raw: staged.result, draftMayBeStaged: true };
}

function replyDraftUncertainty(error) {
  return new LineToolError(
    typeof error?.code === 'string' ? error.code : 'LINE_REPLY_UNVERIFIED',
    'LINE may have staged a reply draft but it could not be verified. Inspect LINE before retrying.',
    {
      ...(error?.details && typeof error.details === 'object' ? error.details : {}),
      operationMayHaveCompleted: true,
      draftMayBeStaged: true,
      previousCode: error?.code ?? error?.name ?? null,
    },
  );
}

function findTranslationSurface(state) {
  const semantic = state.elements.filter(element => hasMarker(element, TRANSLATION_MARKERS));
  if (semantic.length === 1) return semantic[0];
  const labeled = state.elements.filter(element => hasExactLabel(element, TRANSLATION_LABELS)
    && hasMarker(element, SURFACE_MARKERS));
  return labeled.length === 1 ? labeled[0] : undefined;
}

function findForwardRecipientDialog(state) {
  const dialogs = state.elements.filter(element => hasExactLabel(element, FORWARD_LABELS)
    && (hasMarker(element, FORWARD_DIALOG_MARKERS)
      || hasMarker(element, new Set(['dialog', 'window']))));
  const recipients = state.elements.filter(element => hasMarker(element, RECIPIENT_MARKERS));
  return dialogs.length === 1 && recipients.length === 1;
}

function withoutImages(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/image|screenshot/i.test(key)));
}

// Shared plain-text path reuses the existing UI selectors.
export { inspectMainChat, inspectDetachedChat, createChatGuard, composerOptions, readComposer, writeDraft, runUiInput, findComposer, findMainChatBands, findContentHeaderContainer, resolveOpenedMenu, menuItemTarget, replySourceVisualView };
