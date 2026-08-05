/**
 * TL;DW YouTube AI Summarizer - Content Script
 */

let currentVideoId = null;

// Defaults used when queueing a summary (from Settings).
let summaryFormat = 'paragraph';
let summaryLevel = 3;
let queueLanguage = 'en';
let obsidianEnabled = false;
let obsidianVault = '';
// Highlight handed off from the chip when the sheet's Obsidian button is pressed.
let pendingFooterHighlight = null;
let summaryQueue = [];
let timeSavedStats = null;
let isSummaryQueueOpen = false;
let contentSettingsLoaded = false;
let contentSettingsPromise = null;
let activeQueueItemId = '';
let isQueueSheetOpen = false;
let isQueueTranscriptOpen = false;
let queueFilter = 'all';
let queueSheetCloseTimer = null;
let queueTimeTicker = null;
let queueMarkReadTimer = null;
let pendingMarkReadId = '';
const feedCardContexts = new WeakMap();
let activeFeedCard = null;
let feedPillHideTimer = null;

const SUMMARY_QUEUE_KEY = 'tldw_summary_queue';
const TIME_SAVED_KEY = 'tldw_time_saved';
const QUEUE_SHEET_TRANSITION_MS = 340;
// Long enough that opening the wrong row and bouncing straight back out does
// not silently consume a summary, short enough to feel immediate.
const QUEUE_MARK_READ_DELAY_MS = 700;

const FEED_CARD_SELECTOR = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'yt-lockup-view-model'
].join(',');

// Observe YouTube's mutations for infinite scrolling feed items, while
// ignoring DOM work performed by this extension itself.
const scheduleFeedEnhancement = debounce(enhanceFeedCards, 400);
const feedObserver = new MutationObserver((mutations) => {
  if (mutations.some(mutation => !isTldwOwnedMutation(mutation))) {
    scheduleFeedEnhancement();
  }
});

// Initialize on page load
initTLDW();

// Re-initialize on YouTube SPA navigation
window.addEventListener('yt-navigate-finish', () => {
  initTLDW();
});

window.addEventListener('popstate', () => {
  setTimeout(initTLDW, 500);
});

// Highlight capture for queue-sheet selections.
document.addEventListener('mouseup', handleSummarySelectionMouseUp);
document.addEventListener('mousedown', handleHighlightChipOutsideMouseDown, true);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // The popup has no access to the page, so it asks the player through us.
  if (request.action === 'GET_VIDEO_DURATION') {
    sendResponse({ durationSeconds: getWatchPageDurationSeconds() });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[SUMMARY_QUEUE_KEY]) {
    const prevQueue = Array.isArray(changes[SUMMARY_QUEUE_KEY].oldValue)
      ? changes[SUMMARY_QUEUE_KEY].oldValue
      : [];
    summaryQueue = Array.isArray(changes[SUMMARY_QUEUE_KEY].newValue)
      ? changes[SUMMARY_QUEUE_KEY].newValue
      : [];
    // Pop the tray open when an in-flight job finishes so "1 new" isn't
    // buried behind a collapsed pill.
    if (didSummaryQueueItemFinish(prevQueue, summaryQueue)) {
      isSummaryQueueOpen = true;
    }
    renderSummaryQueueWidget();
    updateSummarizeButtonStates();
  }

  if (changes[TIME_SAVED_KEY]) {
    timeSavedStats = summarizeTimeSavedLedger(changes[TIME_SAVED_KEY].newValue);
    renderSummaryQueueWidget();
  }

  let obsidianSettingsChanged = false;
  if (Object.prototype.hasOwnProperty.call(changes, 'obsidianEnabled')) {
    obsidianEnabled = !!changes.obsidianEnabled.newValue;
    obsidianSettingsChanged = true;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'obsidianVault')) {
    obsidianVault = String(changes.obsidianVault.newValue || '').trim();
    obsidianSettingsChanged = true;
  }
  if (obsidianSettingsChanged) {
    updateObsidianUiVisibility();
    renderSummaryQueueWidget();
  }
});

/**
 * Main Initialization
 */
function initTLDW() {
  const url = window.location.href;

  ensureContentSettingsLoaded();
  injectSummaryQueueWidget();
  loadSummaryQueue();
  loadTimeSavedStats();

  if (url.includes('/watch?v=')) {
    const videoId = extractVideoId(url);
    if (videoId !== currentVideoId) {
      currentVideoId = videoId;
      removeWatchSummarizeButton();
    }
    scheduleWatchSummarizeButton();
  } else {
    currentVideoId = null;
    removeWatchSummarizeButton();
  }

  // Enhance feed cards across YouTube (Home, Search, Related)
  enhanceFeedCards();

  // Start observing feed scroll
  const pageContainer = document.querySelector('ytd-page-manager') || document.body;
  feedObserver.disconnect();
  feedObserver.observe(pageContainer, { childList: true, subtree: true });
}

async function ensureContentSettingsLoaded() {
  if (contentSettingsPromise) return contentSettingsPromise;

  contentSettingsLoaded = true;
  contentSettingsPromise = (async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'GET_SETTINGS' });
      if (res?.success && res.settings) {
        summaryFormat = res.settings.summaryFormat || summaryFormat;
        summaryLevel = res.settings.summaryLevel || summaryLevel;
        queueLanguage = res.settings.summaryLanguage || queueLanguage;
        obsidianEnabled = !!res.settings.obsidianEnabled;
        obsidianVault = String(res.settings.obsidianVault || '').trim();
        updateObsidianUiVisibility();
      }
    } catch (_) {}
  })();

  return contentSettingsPromise;
}

function isObsidianExportReady() {
  return obsidianEnabled && !!obsidianVault;
}

async function loadSummaryQueue() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_SUMMARY_QUEUE' });
    if (res?.success) {
      summaryQueue = Array.isArray(res.queue) ? res.queue : [];
      renderSummaryQueueWidget();
      updateSummarizeButtonStates();
    }
  } catch (_) {}
}

async function loadTimeSavedStats() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_TIME_SAVED' });
    if (res?.success && res.stats) {
      timeSavedStats = res.stats;
      renderSummaryQueueWidget();
    }
  } catch (_) {}
}

/**
 * Schedule injection of the watch-page Summarize button until Subscribe appears.
 */
function scheduleWatchSummarizeButton(attempts = 0) {
  if (!currentVideoId) return;
  const injected = injectWatchSummarizeButton();
  if (!injected && attempts < 25) {
    setTimeout(() => scheduleWatchSummarizeButton(attempts + 1), 350);
  }
}

/**
 * Inject a Summarize control next to YouTube's Subscribe button.
 * Clicking it queues the current video and opens the Summary Queue sheet —
 * there is no separate watch-page summary panel.
 */
function injectWatchSummarizeButton() {
  if (!currentVideoId) return false;

  const mount = findWatchSummarizeMount();
  if (!mount) return false;

  let btn = document.getElementById('tldw-watch-summarize-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'tldw-watch-summarize-btn';
    btn.type = 'button';
    btn.className = 'tldw-watch-summarize-btn';
    btn.textContent = '⚡ Summarize';
    btn.title = 'Add this video to the TL;DW summary queue';
    btn.setAttribute('aria-label', 'Summarize with TL;DW');
    btn.addEventListener('click', handleWatchSummarizeClick);
  }

  btn.dataset.videoId = currentVideoId;

  // Only reposition the button when it is not already sitting where it belongs.
  // Moving it unconditionally triggers a mutation on YouTube's container that
  // the feed observer misreads as a page change, causing a re-entrant loop.
  const alreadyPlaced = mount.after
    ? mount.after.nextElementSibling === btn
    : mount.before && mount.before.previousElementSibling === btn;

  if (!alreadyPlaced) {
    if (mount.after) {
      mount.after.insertAdjacentElement('afterend', btn);
    } else {
      mount.parent.insertBefore(btn, mount.before);
    }
  }

  updateSummarizeButtonStates();
  return true;
}

function findWatchSummarizeMount() {
  const subscribe =
    document.querySelector('ytd-watch-metadata #owner #subscribe-button') ||
    document.querySelector('#owner #subscribe-button') ||
    document.querySelector('ytd-video-owner-renderer #subscribe-button') ||
    document.querySelector('ytd-watch-metadata #subscribe-button') ||
    document.querySelector('#subscribe-button');

  if (subscribe?.isConnected) {
    return { parent: subscribe.parentElement, after: subscribe, before: null };
  }

  // Newer flexible-actions layouts sometimes keep subscribe outside #subscribe-button.
  const subscribeAlt =
    document.querySelector('yt-subscribe-button-view-model') ||
    document.querySelector('ytd-subscribe-button-renderer');

  if (subscribeAlt?.isConnected) {
    return { parent: subscribeAlt.parentElement, after: subscribeAlt, before: null };
  }

  // Last resort: lead the like/share action cluster.
  const actions =
    document.querySelector('#actions-inner') ||
    document.querySelector('#top-level-buttons-computed') ||
    document.querySelector('ytd-watch-metadata #actions');

  if (actions?.isConnected) {
    return { parent: actions, after: null, before: actions.firstChild };
  }

  return null;
}

function removeWatchSummarizeButton() {
  document.getElementById('tldw-watch-summarize-btn')?.remove();
}

async function handleWatchSummarizeClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const videoId = currentVideoId || extractVideoId(window.location.href);
  if (!videoId) return;

  await queueOrOpenSummary({
    videoId,
    videoUrl: window.location.href,
    videoTitle: getWatchVideoTitle(),
    durationSeconds: getWatchPageDurationSeconds(),
    statusButton: e.currentTarget,
    openSheet: true
  });
}

function updateObsidianUiVisibility() {
  if (!isObsidianExportReady()) hideHighlightChip();
}

async function saveSummaryToObsidian({
  mode,
  videoId,
  videoTitle,
  videoUrl,
  summary,
  videoType = '',
  highlight = ''
}) {
  if (!isObsidianExportReady()) {
    throw new Error('Enable Obsidian export and set your vault name in TL;DW settings.');
  }

  const response = await chrome.runtime.sendMessage({
    action: 'SAVE_TO_OBSIDIAN',
    mode,
    videoId,
    videoTitle,
    videoUrl,
    summary,
    videoType,
    highlight
  });

  if (!response?.success || !response.uri) {
    throw new Error(response?.error || 'Failed to save to Obsidian.');
  }

  if (response.useClipboard && response.markdown) {
    await navigator.clipboard.writeText(response.markdown);
  }

  launchObsidianUri(response.uri);
}

function launchObsidianUri(uri) {
  const target = String(uri || '').trim();
  if (!target.startsWith('obsidian://')) {
    throw new Error('Invalid Obsidian URI.');
  }

  const anchor = document.createElement('a');
  anchor.href = target;
  anchor.rel = 'noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Fallback if the gesture was already consumed by an await.
  chrome.runtime.sendMessage({ action: 'OPEN_OBSIDIAN_URI', uri: target }).catch(() => {});
}

const HIGHLIGHT_CHIP_LABEL = 'Save highlight';

/**
 * Selection happens inside the queue sheet; the chip resolves its video
 * context from the summary block that was selected.
 */
function getObsidianSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const node = common.nodeType === Node.TEXT_NODE ? common.parentNode : common;
  const sourceEl = node?.closest?.('[data-tldw-obsidian-source]');
  if (!sourceEl) return null;

  const text = String(selection.toString() || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  return {
    text,
    source: sourceEl.dataset.tldwObsidianSource,
    queueId: sourceEl.dataset.queueId || ''
  };
}

function resolveObsidianContext(source, queueId) {
  if (source !== 'queue') return null;

  const item = summaryQueue.find(queueItem => queueItem.id === queueId);
  if (!item?.summary) return null;
  return {
    videoId: item.videoId,
    videoTitle: item.videoTitle || item.videoId,
    videoUrl: item.videoUrl || `https://www.youtube.com/watch?v=${item.videoId}`,
    summary: item.summary,
    videoType: item.answer?.videoType || ''
  };
}

function handleSummarySelectionMouseUp(e) {
  if (!isObsidianExportReady()) {
    hideHighlightChip();
    return;
  }

  // Let the browser finish updating the selection before we read it.
  setTimeout(() => {
    const selected = getObsidianSelection();
    if (!selected || !resolveObsidianContext(selected.source, selected.queueId)) {
      hideHighlightChip();
      return;
    }
    showHighlightChip(selected, e.clientX, e.clientY);
  }, 0);
}

function showHighlightChip(selected, clientX, clientY) {
  let chip = document.getElementById('tldw-highlight-chip');
  if (!chip) {
    chip = document.createElement('button');
    chip.id = 'tldw-highlight-chip';
    chip.type = 'button';
    chip.className = 'tldw-highlight-chip';
    chip.innerHTML = `<span aria-hidden="true">✦</span><span class="tldw-highlight-chip-label">${HIGHLIGHT_CHIP_LABEL}</span>`;
    chip.addEventListener('mousedown', (event) => {
      // Keep the selection alive until click handlers run.
      event.preventDefault();
    });
    chip.addEventListener('click', () => saveHighlightFromChip(chip));
    document.body.appendChild(chip);
  }

  chip.dataset.highlight = selected.text;
  chip.dataset.source = selected.source;
  chip.dataset.queueId = selected.queueId;
  chip.style.display = 'inline-flex';

  // Keep the chip last in the body so it wins the tie against the queue widget,
  // which shares the same max z-index.
  document.body.appendChild(chip);

  const left = Math.min(window.innerWidth - 170, Math.max(8, clientX + 8));
  const top = Math.min(window.innerHeight - 48, Math.max(8, clientY + 12));
  chip.style.left = `${left}px`;
  chip.style.top = `${top}px`;
}

async function saveHighlightFromChip(chip) {
  const highlight = chip.dataset.highlight;
  const context = resolveObsidianContext(chip.dataset.source, chip.dataset.queueId);
  if (!highlight || !context) return;

  const label = chip.querySelector('.tldw-highlight-chip-label');
  chip.disabled = true;
  if (label) label.textContent = 'Saving…';

  try {
    await saveSummaryToObsidian({ mode: 'highlight', ...context, highlight });
    if (label) label.textContent = 'Saved';
    setTimeout(hideHighlightChip, 900);
  } catch (err) {
    if (label) label.textContent = HIGHLIGHT_CHIP_LABEL;
    alert(err.message || String(err));
  } finally {
    chip.disabled = false;
    setTimeout(() => {
      if (label) label.textContent = HIGHLIGHT_CHIP_LABEL;
    }, 1200);
  }
}

function hideHighlightChip() {
  const chip = document.getElementById('tldw-highlight-chip');
  if (chip) chip.style.display = 'none';
}

function handleHighlightChipOutsideMouseDown(e) {
  const chip = document.getElementById('tldw-highlight-chip');
  if (!chip || chip.style.display === 'none') return;
  if (chip.contains(e.target)) return;
  if (e.target.closest?.('[data-tldw-obsidian-source]')) return;

  // Pressing the sheet's Obsidian button clears the selection before its click
  // handler runs, so hand the pending highlight over instead of dropping it.
  const obsidianAction = e.target.closest?.('[data-tldw-queue-action="obsidian"]');
  pendingFooterHighlight = obsidianAction
    ? { text: chip.dataset.highlight || '', queueId: chip.dataset.queueId || '' }
    : null;

  hideHighlightChip();
}

function takeQueueHighlight(queueId) {
  const live = getObsidianSelection();
  if (live && live.source === 'queue' && live.queueId === queueId) {
    pendingFooterHighlight = null;
    return live.text;
  }

  const pending = pendingFooterHighlight;
  pendingFooterHighlight = null;
  return pending && pending.queueId === queueId ? pending.text : '';
}

/**
 * Enhance Feed Video Cards on YouTube Home, Search, and Recommendations
 */
function enhanceFeedCards() {
  // YouTube sometimes nests a newer card renderer inside a legacy one. Only
  // enhance the innermost renderer so mutation passes cannot move one pill
  // back and forth between two cards.
  const cards = Array.from(document.querySelectorAll(FEED_CARD_SELECTOR))
    .filter(card => !card.querySelector(FEED_CARD_SELECTOR));

  cards.forEach(card => {
    const titleLink = getFeedCardTitleLink(card);
    if (!titleLink || !titleLink.href) return;

    const videoId = extractVideoId(titleLink.href);
    if (!videoId) return;

    feedCardContexts.set(card, {
      videoId,
      videoUrl: titleLink.href,
      videoTitle: getFeedCardVideoTitle(card, titleLink),
      durationSeconds: getFeedCardDurationSeconds(card)
    });

    markFeedCardEnhanced(card);
  });

  ensureFeedPillPortal();
  updateSummarizeButtonStates();
  // Only re-inject the watch-page button when YouTube has torn it down
  // (e.g. after a SPA re-render).  Moving it on every feed-card scan is
  // what causes the flicker the user sees on hover.
  if (currentVideoId && !document.getElementById('tldw-watch-summarize-btn')) {
    injectWatchSummarizeButton();
  }
}

function markFeedCardEnhanced(card) {
  card.classList.add('tldw-feed-card-enhanced');

  if (card.dataset.tldwHoverBound === 'true') return;
  card.dataset.tldwHoverBound = 'true';

  card.addEventListener('mouseenter', () => {
    showFeedPillForCard(card);
  });
  card.addEventListener('mouseleave', () => {
    hideFeedPillSoon();
  });
  card.addEventListener('focusin', () => {
    showFeedPillForCard(card);
  });
  card.addEventListener('focusout', () => {
    hideFeedPillSoon();
  });
}

function ensureFeedPillPortal() {
  let pill = document.getElementById('tldw-feed-pill-portal');
  if (pill || !document.body) return pill;

  pill = document.createElement('button');
  pill.id = 'tldw-feed-pill-portal';
  pill.className = 'tldw-feed-pill tldw-feed-pill-overlay tldw-feed-pill-portal';
  pill.type = 'button';
  pill.textContent = '⚡ Summarize';
  pill.title = 'Add this video to the TL;DW summary queue';

  pill.addEventListener('mouseenter', () => clearTimeout(feedPillHideTimer));
  pill.addEventListener('mouseleave', hideFeedPillSoon);
  pill.addEventListener('focusin', () => clearTimeout(feedPillHideTimer));
  pill.addEventListener('focusout', hideFeedPillSoon);
  pill.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const context = activeFeedCard && feedCardContexts.get(activeFeedCard);
    if (!context) return;

    handleFeedCardSummary(
      activeFeedCard,
      context.videoId,
      context.videoUrl,
      pill,
      context.videoTitle,
      context.durationSeconds
    );
  });

  document.body.appendChild(pill);
  return pill;
}

function showFeedPillForCard(card) {
  const context = feedCardContexts.get(card);
  const pill = ensureFeedPillPortal();
  if (!context || !pill) return;

  clearTimeout(feedPillHideTimer);
  activeFeedCard?.classList.remove('tldw-feed-card-active');
  activeFeedCard = card;
  activeFeedCard.classList.add('tldw-feed-card-active');

  const anchor = getFeedCardThumbnail(card) || card;
  const bounds = anchor.getBoundingClientRect();
  pill.style.left = `${Math.round(bounds.left + 10)}px`;
  pill.style.top = `${Math.round(bounds.top + 10)}px`;
  pill.dataset.videoId = context.videoId;
  updateSummarizeButtonStates();
  pill.classList.add('tldw-feed-pill-visible');
}

function hideFeedPillSoon() {
  clearTimeout(feedPillHideTimer);
  feedPillHideTimer = setTimeout(() => {
    const pill = document.getElementById('tldw-feed-pill-portal');
    pill?.classList.remove('tldw-feed-pill-visible');
    activeFeedCard?.classList.remove('tldw-feed-card-active');
    activeFeedCard = null;
  }, 120);
}

function getFeedCardTitleLink(card) {
  return card.querySelector([
    'a#video-title-link',
    'a#video-title',
    '.yt-lockup-metadata-view-model__title a[href*="/watch"]',
    'yt-lockup-metadata-view-model a[href*="/watch"]',
    'h3 a[href*="/watch"]',
    'a[aria-label][href*="/watch"]',
    'a[href*="/watch?v="]',
    'a#thumbnail'
  ].join(','));
}

function getFeedCardVideoTitle(card, titleLink) {
  const titleEl = card.querySelector([
    'a#video-title-link',
    'a#video-title',
    '.yt-lockup-metadata-view-model__title a[href*="/watch"]',
    'yt-lockup-metadata-view-model a[href*="/watch"]',
    'h3 a[href*="/watch"]',
    'a[title][href*="/watch"]',
    'a[aria-label][href*="/watch"]'
  ].join(','));

  return cleanFeedCardTitle(
    titleEl?.textContent ||
    titleEl?.getAttribute('title') ||
    titleEl?.getAttribute('aria-label') ||
    titleLink?.textContent ||
    titleLink?.getAttribute('title') ||
    titleLink?.getAttribute('aria-label') ||
    ''
  );
}

function cleanFeedCardTitle(rawTitle) {
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!title) return '';

  return title
    .replace(/\s+by\s+.+$/i, '')
    .replace(/\s+\d+(?:,\d+)?\s+views?.*$/i, '')
    .trim();
}

/**
 * Reads the length off the thumbnail badge. YouTube ships several renderers for
 * it, and a live stream or a shelf card has none — 0 means "ask the background".
 */
function getFeedCardDurationSeconds(card) {
  const badges = card.querySelectorAll([
    'ytd-thumbnail-overlay-time-status-renderer #text',
    'ytd-thumbnail-overlay-time-status-renderer',
    '.ytd-thumbnail-overlay-time-status-renderer',
    'badge-shape .badge-shape-wiz__text',
    '.yt-badge-shape__text',
    'yt-thumbnail-badge-view-model'
  ].join(','));

  for (const badge of badges) {
    const seconds = parseClockSeconds(
      badge.getAttribute?.('aria-label') || badge.textContent || ''
    );
    if (seconds) return seconds;
  }

  return 0;
}

function getWatchPageDurationSeconds() {
  const player = document.querySelector('#movie_player video, video.html5-main-video, video');
  if (player && Number.isFinite(player.duration) && player.duration > 0) {
    return Math.round(player.duration);
  }

  return parseClockSeconds(document.querySelector('.ytp-time-duration')?.textContent || '');
}

// Mirrors parseDurationSeconds in time-saved.js; content scripts cannot import it.
function parseClockSeconds(value) {
  const clock = String(value || '').trim().match(/(?:^|\s)(\d{1,3}(?::[0-5]?\d){1,2})(?:\s|$)/);
  if (!clock) return 0;

  return clock[1]
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

function getFeedCardThumbnail(card) {
  return (
    card.querySelector('yt-thumbnail-view-model') ||
    card.querySelector('.yt-thumbnail-view-model') ||
    card.querySelector('ytd-thumbnail') ||
    card.querySelector('a#thumbnail')?.parentElement ||
    card.querySelector('a[href*="/watch"] img')?.parentElement ||
    card.querySelector('#thumbnail')
  );
}

/**
 * Queue a video for summarization, or open it if it is already in the queue.
 * Watch-page clicks always open the sheet; feed pills only open it when done.
 */
async function queueOrOpenSummary({
  videoId,
  videoUrl,
  videoTitle = '',
  durationSeconds = 0,
  statusButton = null,
  openSheet = false
}) {
  const existing = findQueueItemByVideoId(videoId);
  if (existing) {
    isSummaryQueueOpen = true;
    if (openSheet || existing.status === 'done') {
      openQueueSheet(existing.id);
    } else {
      renderSummaryQueueWidget(existing.id);
    }
    return { item: existing, queued: false };
  }

  if (statusButton) {
    statusButton.disabled = true;
    statusButton.textContent = 'Queued...';
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'QUEUE_SUMMARY',
      videoId,
      videoUrl,
      videoTitle,
      language: queueLanguage,
      summaryLevel: summaryLevel,
      summaryFormat: summaryFormat,
      videoDurationSeconds: durationSeconds
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to queue video.');
    }

    summaryQueue = Array.isArray(response.queue) ? response.queue : summaryQueue;
    isSummaryQueueOpen = true;
    updateSummarizeButtonStates();

    if (openSheet && response.item?.id) {
      openQueueSheet(response.item.id);
    } else {
      renderSummaryQueueWidget(response.item?.id);
    }

    return { item: response.item, queued: true };
  } catch (err) {
    if (statusButton) {
      statusButton.textContent = 'Retry';
      statusButton.title = err.message || String(err);
    }
    throw err;
  } finally {
    if (statusButton) statusButton.disabled = false;
    updateSummarizeButtonStates();
  }
}

async function handleFeedCardSummary(card, videoId, videoUrl, pillBtn, videoTitle = '', durationSeconds = 0) {
  try {
    await queueOrOpenSummary({
      videoId,
      videoUrl,
      videoTitle,
      durationSeconds,
      statusButton: pillBtn,
      openSheet: false
    });
  } catch (_) {
    // Button title already carries the error; feed pills stay non-blocking.
  }
}

function findQueueItemByVideoId(videoId) {
  return summaryQueue.find(item => item.videoId === videoId);
}

function getSummarizeButtonPresentation(videoId) {
  const item = findQueueItemByVideoId(videoId);
  let label = '⚡ Summarize';
  let title = 'Add this video to the TL;DW summary queue';
  let stateClass = '';

  if (item?.status === 'done') {
    label = '✓ Summary';
    title = 'Summary ready. Click to open it in the TL;DW queue.';
    stateClass = 'is-done';
  } else if (item?.status === 'error') {
    label = '⚠ Retry';
    title = item.error || 'Summary failed. Click to open the TL;DW queue.';
    stateClass = 'is-error';
  } else if (item) {
    label = item.status === 'running' ? '⏳ Summarizing' : 'Queued';
    title = item.progress || 'Summary queued.';
    stateClass = 'is-running';
  }

  return { item, label, title, stateClass };
}

function updateSummarizeButtonStates() {
  document.querySelectorAll('.tldw-feed-pill').forEach(pill => {
    const { label, title, stateClass } = getSummarizeButtonPresentation(pill.dataset.videoId);
    const feedState = stateClass ? `tldw-feed-pill-${stateClass.replace('is-', '')}` : '';

    if (pill.disabled) pill.disabled = false;
    if (pill.textContent !== label) pill.textContent = label;
    if (pill.title !== title) pill.title = title;

    ['tldw-feed-pill-running', 'tldw-feed-pill-done', 'tldw-feed-pill-error']
      .forEach(className => pill.classList.toggle(className, className === feedState));
  });

  const watchBtn = document.getElementById('tldw-watch-summarize-btn');
  if (!watchBtn) return;

  const videoId = watchBtn.dataset.videoId || currentVideoId;
  const { label, title, stateClass } = getSummarizeButtonPresentation(videoId);
  if (!watchBtn.disabled && watchBtn.textContent !== label) watchBtn.textContent = label;
  if (!watchBtn.disabled && watchBtn.title !== title) watchBtn.title = title;
  ['is-running', 'is-done', 'is-error'].forEach(className => {
    watchBtn.classList.toggle(className, className === stateClass);
  });
}

const TLDW_OWNED_SELECTORS = [
  '.tldw-feed-pill',
  '#tldw-watch-summarize-btn',
  '#tldw-summary-queue-widget',
  '#tldw-highlight-chip'
].join(',');

function isTldwOwnedMutation(mutation) {
  // Check added/removed nodes — when we inject or move our button the
  // mutation.target is YouTube's own container so we must inspect the payload.
  const affected = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
  if (affected.some(node => {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    return node.matches?.(TLDW_OWNED_SELECTORS) ||
           !!node.querySelector?.(TLDW_OWNED_SELECTORS);
  })) {
    return true;
  }

  const target = mutation.target?.nodeType === Node.ELEMENT_NODE
    ? mutation.target
    : mutation.target?.parentElement;

  return !!target?.closest(TLDW_OWNED_SELECTORS);
}

function injectSummaryQueueWidget() {
  if (document.getElementById('tldw-summary-queue-widget')) return true;
  if (!document.body) return false;

  const widget = document.createElement('div');
  widget.id = 'tldw-summary-queue-widget';
  widget.className = 'tldw-summary-queue-widget';
  widget.style.display = 'none';
  document.body.appendChild(widget);

  widget.addEventListener('click', handleSummaryQueueClick);
  // Capture, because scroll does not bubble and the sheet body is replaced on
  // every render.
  widget.addEventListener('scroll', handleQueueSheetScroll, true);
  document.addEventListener('keydown', handleSummaryQueueKeydown, true);

  renderSummaryQueueWidget();
  return true;
}

async function handleSummaryQueueClick(e) {
  const actionEl = e.target.closest('[data-tldw-queue-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.tldwQueueAction;
  const id = actionEl.dataset.queueId;

  // Any action dismisses the overflow menu, including one taken outside it.
  document.querySelectorAll('#tldw-summary-queue-widget .tldw-q-more[open]')
    .forEach(menu => { menu.open = false; });

  if (action === 'toggle') {
    isSummaryQueueOpen = !isSummaryQueueOpen;
    if (!isSummaryQueueOpen) closeQueueSheet({ immediate: true });
    renderSummaryQueueWidget();
    return;
  }

  if (action === 'close') {
    isSummaryQueueOpen = false;
    closeQueueSheet({ immediate: true });
    renderSummaryQueueWidget();
    return;
  }

  if (action === 'filter') {
    queueFilter = actionEl.dataset.filter || 'all';
    renderSummaryQueueWidget();
    return;
  }

  if (action === 'mark-all-read') {
    const res = await chrome.runtime.sendMessage({ action: 'MARK_SUMMARY_QUEUE_READ', all: true });
    if (res?.success) {
      summaryQueue = Array.isArray(res.queue) ? res.queue : summaryQueue;
      renderSummaryQueueWidget();
    }
    return;
  }

  if (action === 'clear-done') {
    const res = await chrome.runtime.sendMessage({ action: 'CLEAR_DONE_SUMMARY_QUEUE_ITEMS' });
    if (res?.success) {
      summaryQueue = Array.isArray(res.queue) ? res.queue : summaryQueue;
      closeQueueSheet({ immediate: true });
      renderSummaryQueueWidget();
      updateSummarizeButtonStates();
    }
    return;
  }

  if (action === 'open') {
    openQueueSheet(id);
    return;
  }

  if (action === 'close-sheet') {
    closeQueueSheet();
    return;
  }

  if (action === 'toggle-transcript') {
    isQueueTranscriptOpen = !isQueueTranscriptOpen;
    renderSummaryQueueWidget();
    return;
  }

  const item = summaryQueue.find(queueItem => queueItem.id === id);
  if (!item) return;

  if (action === 'copy' && item.summary) {
    await navigator.clipboard.writeText(summaryClipboardText(item));
    flashQueueActionGlyph(actionEl, '✓');
    return;
  }

  if (action === 'obsidian' && item.summary) {
    const highlight = takeQueueHighlight(id);
    const restore = setQueueActionGlyph(actionEl, '⋯');
    try {
      await saveSummaryToObsidian({
        mode: highlight ? 'highlight' : 'bookmark',
        videoId: item.videoId,
        videoTitle: item.videoTitle || item.title || item.videoId,
        videoUrl: item.videoUrl || `https://www.youtube.com/watch?v=${item.videoId}`,
        summary: item.summary,
        videoType: item.answer?.videoType || '',
        highlight
      });
      flashQueueActionGlyph(actionEl, '✓');
    } catch (err) {
      restore();
      alert(err.message || String(err));
    }
    return;
  }

  if (action === 'retry') {
    setQueueActionGlyph(actionEl, '⋯');
    const res = await chrome.runtime.sendMessage({
      action: 'RETRY_SUMMARY_QUEUE_ITEM',
      id
    });
    if (res?.success) {
      summaryQueue = Array.isArray(res.queue) ? res.queue : summaryQueue;
      renderSummaryQueueWidget(id);
      updateSummarizeButtonStates();
    }
    return;
  }

  if (action === 'remove') {
    const res = await chrome.runtime.sendMessage({
      action: 'REMOVE_SUMMARY_QUEUE_ITEM',
      id
    });
    if (res?.success) {
      summaryQueue = Array.isArray(res.queue) ? res.queue : summaryQueue.filter(queueItem => queueItem.id !== id);
      if (activeQueueItemId === id) closeQueueSheet({ immediate: true });
      renderSummaryQueueWidget();
      updateSummarizeButtonStates();
    }
  }
}

/** Swaps an icon button's glyph, returning a callback that puts the original back. */
function handleQueueSheetScroll(e) {
  if (!e.target?.classList?.contains('tldw-q-sheet-body')) return;
  updateQueueSheetProgress(e.target);
}

// Long summaries scroll well past the fold, so the sheet shows how far in you
// are. The bar hides itself when everything already fits.
function updateQueueSheetProgress(body) {
  const sheet = body.closest('.tldw-q-sheet');
  if (!sheet) return;

  const scrollable = body.scrollHeight - body.clientHeight;
  sheet.dataset.scrollable = String(scrollable > 24);
  sheet.style.setProperty(
    '--tldw-q-progress',
    scrollable > 0 ? String(Math.min(1, Math.max(0, body.scrollTop / scrollable))) : '0'
  );
}

function setQueueActionGlyph(actionEl, glyph) {
  const target = actionEl.querySelector('span') || actionEl;
  const original = target.textContent;
  target.textContent = glyph;
  return () => {
    target.textContent = original;
  };
}

function flashQueueActionGlyph(actionEl, glyph, revertMs = 1400) {
  const restore = setQueueActionGlyph(actionEl, glyph);
  setTimeout(restore, revertMs);
}

// Escape unwinds one layer at a time (sheet, then panel). Arrow keys only move
// between rows while focus is already inside the widget, so YouTube's own
// shortcuts keep working everywhere else.
function handleSummaryQueueKeydown(e) {
  if (!isSummaryQueueOpen) return;

  if (e.key === 'Escape') {
    if (isQueueSheetOpen) {
      closeQueueSheet();
    } else {
      isSummaryQueueOpen = false;
      renderSummaryQueueWidget();
    }
    e.stopPropagation();
    e.preventDefault();
    return;
  }

  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (!e.target?.closest?.('#tldw-summary-queue-widget')) return;

  const rows = Array.from(document.querySelectorAll('#tldw-summary-queue-widget .tldw-q-row-hit'));
  if (!rows.length) return;

  const index = rows.indexOf(e.target.closest('.tldw-q-row-hit'));
  const next = e.key === 'ArrowDown'
    ? rows[Math.min(rows.length - 1, index + 1)]
    : rows[Math.max(0, index - 1)];

  next?.focus();
  e.stopPropagation();
  e.preventDefault();
}

function openQueueSheet(id) {
  const item = summaryQueue.find(queueItem => queueItem.id === id);
  if (!item) return;

  clearTimeout(queueSheetCloseTimer);
  if (activeQueueItemId !== id) isQueueTranscriptOpen = false;
  activeQueueItemId = id;
  isSummaryQueueOpen = true;
  renderSummaryQueueWidget();

  if (isSummaryQueueItemUnread(item)) {
    scheduleQueueMarkRead(id);
  }

  // Mount the sheet closed, then flip it open on the next frame so the
  // transform actually transitions instead of snapping into place.
  requestAnimationFrame(() => {
    isQueueSheetOpen = true;
    const panel = document.querySelector('#tldw-summary-queue-widget .tldw-q-panel');
    if (panel) panel.dataset.sheet = 'open';
    panel?.querySelector('.tldw-q-sheet')?.focus({ preventScroll: true });
  });
}

function isSummaryQueueItemUnread(item) {
  return !!item && item.status === 'done' && item.readAt === 0;
}

function scheduleQueueMarkRead(id) {
  if (pendingMarkReadId === id && queueMarkReadTimer) return;

  cancelQueueMarkRead();
  pendingMarkReadId = id;
  queueMarkReadTimer = setTimeout(async () => {
    queueMarkReadTimer = null;
    pendingMarkReadId = '';

    const res = await chrome.runtime.sendMessage({ action: 'MARK_SUMMARY_QUEUE_READ', id });
    if (res?.success && Array.isArray(res.queue)) {
      summaryQueue = res.queue;
      renderSummaryQueueWidget();
    }
  }, QUEUE_MARK_READ_DELAY_MS);
}

function cancelQueueMarkRead() {
  clearTimeout(queueMarkReadTimer);
  queueMarkReadTimer = null;
  pendingMarkReadId = '';
}

function closeQueueSheet({ immediate = false } = {}) {
  clearTimeout(queueSheetCloseTimer);
  cancelQueueMarkRead();
  hideHighlightChip();
  isQueueSheetOpen = false;
  isQueueTranscriptOpen = false;

  if (immediate) {
    activeQueueItemId = '';
    return;
  }

  const panel = document.querySelector('#tldw-summary-queue-widget .tldw-q-panel');
  if (!panel) {
    activeQueueItemId = '';
    return;
  }

  const focusId = activeQueueItemId;
  panel.dataset.sheet = 'closed';
  queueSheetCloseTimer = setTimeout(() => {
    if (isQueueSheetOpen) return;
    activeQueueItemId = '';
    renderSummaryQueueWidget(focusId);
  }, QUEUE_SHEET_TRANSITION_MS);
}

function renderSummaryQueueWidget(focusedId = '') {
  const widget = document.getElementById('tldw-summary-queue-widget');
  if (!widget) return;

  const stats = getSummaryQueueStats();
  // Collapsed pill is only for things that need attention — unread, in-flight,
  // or failed. Fully-read done items stay in the panel history, not the HUD.
  const hasActionable = stats.unread > 0 || stats.pending > 0 || stats.error > 0;
  const shouldShow = hasActionable || isSummaryQueueOpen;
  const scrollTop = widget.querySelector('.tldw-q-timeline')?.scrollTop || 0;

  widget.style.display = shouldShow ? 'block' : 'none';
  widget.classList.toggle('tldw-summary-queue-open', isSummaryQueueOpen);

  const statusText = stats.unread > 0
    ? `${stats.unread} new${stats.pending > 0 ? ` · ${stats.pending} running` : ''}`
    : stats.pending > 0
      ? `${stats.pending} running`
      : stats.error > 0
        ? `${stats.error} failed`
        : '';

  widget.classList.toggle('tldw-summary-queue-has-unread', stats.unread > 0);

  widget.innerHTML = `
    <button class="tldw-summary-queue-toggle" type="button" data-tldw-queue-action="toggle" aria-expanded="${String(isSummaryQueueOpen)}">
      <span class="tldw-summary-queue-logo">⚡</span>
      <span class="tldw-summary-queue-title">TL;DW Queue</span>
      ${stats.unread > 0 ? `<span class="tldw-summary-queue-count">${stats.unread}</span>` : ''}
      ${statusText ? `<span class="tldw-summary-queue-subtitle">${escapeHTML(statusText)}</span>` : ''}
    </button>
    ${isSummaryQueueOpen ? renderSummaryQueuePanel(stats) : ''}
  `;

  if (!isSummaryQueueOpen) {
    stopQueueTimeTicker();
    cancelQueueMarkRead();
    return;
  }

  const activeItem = summaryQueue.find(item => item.id === activeQueueItemId);
  if (isQueueSheetOpen && isSummaryQueueItemUnread(activeItem)) {
    scheduleQueueMarkRead(activeItem.id);
  }

  const timeline = widget.querySelector('.tldw-q-timeline');
  if (timeline) timeline.scrollTop = scrollTop;

  const sheetBody = widget.querySelector('.tldw-q-sheet-body');
  if (sheetBody) updateQueueSheetProgress(sheetBody);

  if (focusedId) {
    const row = widget.querySelector(`.tldw-q-row[data-queue-id="${CSS.escape(focusedId)}"]`);
    row?.classList.add('tldw-q-row-focused');
    row?.scrollIntoView({ block: 'nearest' });
  }

  startQueueTimeTicker();
}

function renderSummaryQueuePanel(stats) {
  const active = summaryQueue.find(item => item.id === activeQueueItemId);

  return `
    <div class="tldw-q-panel" role="dialog" aria-label="TL;DW summary queue" data-sheet="${isQueueSheetOpen && active ? 'open' : 'closed'}">
      <header class="tldw-q-head">
        <div class="tldw-q-head-top">
          <div>
            <div class="tldw-q-head-title">Summary Queue</div>
            <div class="tldw-q-head-meta">Recent summaries stay here while you browse.</div>
          </div>
          <button class="tldw-q-close" type="button" data-tldw-queue-action="close" aria-label="Close queue">×</button>
        </div>
        ${renderTimeSavedBanner()}
        ${renderQueueFilters(stats)}
      </header>
      <div class="tldw-q-timeline">${renderQueueRows()}</div>
      <div class="tldw-q-scrim" data-tldw-queue-action="close-sheet"></div>
      <section class="tldw-q-sheet" tabindex="-1" aria-hidden="${String(!(isQueueSheetOpen && active))}">
        ${active ? renderQueueSheet(active) : ''}
      </section>
    </div>
  `;
}

/**
 * The lifetime tally, framed as what it actually bought: video you never had to
 * sit through, net of the time spent reading the summaries that replaced it.
 */
function renderTimeSavedBanner() {
  const stats = timeSavedStats;
  if (!stats || !stats.videos || !stats.savedSeconds) return '';

  const readingNote = stats.readSeconds >= 60
    ? ` · ~${formatTimeSpan(stats.readSeconds)} reading instead`
    : '';

  return `
    <div class="tldw-q-saved" title="Total length of the videos you summarized instead of watching, minus an estimate of the time spent reading those summaries.">
      <span class="tldw-q-saved-icon" aria-hidden="true">⏱</span>
      <span class="tldw-q-saved-copy">
        <span class="tldw-q-saved-value">${escapeHTML(formatTimeSpan(stats.savedSeconds))}</span>
        <span class="tldw-q-saved-label">not watched</span>
        <span class="tldw-q-saved-sub">${stats.videos} video${stats.videos === 1 ? '' : 's'} summarized${escapeHTML(readingNote)}</span>
      </span>
    </div>
  `;
}

function renderQueueFilters(stats) {
  const filters = [
    { id: 'all', label: 'All', count: stats.total },
    { id: 'unread', label: 'New', count: stats.unread },
    { id: 'running', label: 'Running', count: stats.pending },
    { id: 'error', label: 'Failed', count: stats.error }
  ];

  const chips = filters.map(filter => `
    <button class="tldw-q-chip" type="button" data-tldw-queue-action="filter" data-filter="${filter.id}"
            aria-pressed="${String(queueFilter === filter.id)}">
      ${filter.label}${filter.count ? `<span class="tldw-q-chip-count">${filter.count}</span>` : ''}
    </button>
  `).join('');

  const trailing = stats.unread > 0
    ? '<button class="tldw-q-clear" type="button" data-tldw-queue-action="mark-all-read">Mark all read</button>'
    : stats.done
      ? '<button class="tldw-q-clear" type="button" data-tldw-queue-action="clear-done">Clear done</button>'
      : '';

  return `
    <div class="tldw-q-filters">
      ${chips}
      ${trailing}
    </div>
  `;
}

function renderQueueRows() {
  const items = summaryQueue.filter(matchesQueueFilter);
  if (!items.length) {
    return `<div class="tldw-q-empty">${summaryQueue.length ? 'Nothing matches this filter.' : 'No summaries queued yet.'}</div>`;
  }

  const startOfToday = new Date().setHours(0, 0, 0, 0);
  let lastLabel = '';

  return items.map(item => {
    const ts = item.updatedAt || item.createdAt || 0;
    const label = queueDayLabel(ts, startOfToday);
    const daymark = label === lastLabel ? '' : `<div class="tldw-q-daymark">${escapeHTML(label)}</div>`;
    lastLabel = label;
    return daymark + renderQueueRow(item, ts);
  }).join('');
}

function renderQueueRow(item, ts) {
  const id = escapeHTML(item.id);
  const title = escapeHTML(item.videoTitle || 'YouTube video');
  const status = item.status || 'queued';
  const sublineText = status === 'error'
    ? (item.error || 'Failed')
    : (item.progress || getSummaryQueueStatusLabel(item));
  const subline = status === 'done'
    ? renderAnswerBadge(item.answer)
    : `<span class="tldw-q-row-sub">${escapeHTML(sublineText)}</span>`;
  const clock = formatClock(item.durationSeconds);
  const thumb = `
    <span class="tldw-q-thumb-wrap">
      ${item.videoId
        ? `<img class="tldw-q-thumb" alt="" loading="lazy" src="https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/default.jpg">`
        : '<span class="tldw-q-thumb"></span>'}
      ${clock ? `<span class="tldw-q-thumb-dur">${escapeHTML(clock)}</span>` : ''}
    </span>
  `;
  const unread = isSummaryQueueItemUnread(item);

  return `
    <div class="tldw-q-row" data-status="${escapeHTML(status)}" data-queue-id="${id}" data-unread="${String(unread)}">
      <button class="tldw-q-row-hit" type="button" data-tldw-queue-action="open" data-queue-id="${id}"
              aria-label="${unread ? 'Unread summary' : 'Summary'} for ${title}">
        <span class="tldw-q-node" aria-hidden="true"></span>
        ${thumb}
        <span class="tldw-q-row-main">
          <span class="tldw-q-row-title">${title}</span>
          ${subline}
        </span>
        <span class="tldw-q-row-time" data-tldw-ts="${ts}">${queueRelTime(ts)}</span>
      </button>
      <div class="tldw-q-row-tools">
        <a href="${escapeHTML(item.videoUrl || '#')}" target="_blank" rel="noreferrer" title="Open video" aria-label="Open ${title} on YouTube">↗</a>
        <button type="button" data-tldw-queue-action="remove" data-queue-id="${id}"
                title="Remove" aria-label="Remove ${title} from queue">×</button>
      </div>
    </div>
  `;
}

function renderQueueSheet(item) {
  const id = escapeHTML(item.id);
  const title = escapeHTML(item.videoTitle || 'YouTube video');
  const ts = item.updatedAt || item.createdAt || 0;
  const art = item.videoId
    ? `--tldw-q-art:url('https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg')`
    : '';

  const sheetSource = `data-tldw-obsidian-source="queue" data-queue-id="${id}"`;
  const dir = isArabicText(item.summary) ? 'tldw-rtl' : 'tldw-ltr';
  const summaryBody = item.answer?.hasHeader ? item.answer.body : item.summary;
  const transcriptBlock = item.transcript && isQueueTranscriptOpen
    ? `<pre class="tldw-q-sheet-transcript">${escapeHTML(item.transcript)}</pre>`
    : '';

  const body = item.status === 'error'
    ? `<div class="tldw-summary-queue-error">${escapeHTML(item.error || 'Summary failed.')}</div>`
    : item.summary
      ? `<div class="tldw-q-sheet-answer ${dir}">${renderAnswerCard(item.answer, sheetSource)}</div>
         ${renderBodySectionLabel(item.answer, summaryBody)}
         <div class="tldw-q-sheet-summary ${dir}" ${sheetSource}>${parseMarkdown(summaryBody)}</div>
         ${transcriptBlock}
         ${isObsidianExportReady()
           ? '<div class="tldw-obsidian-hint"><span aria-hidden="true">✦</span><span>Select any text above to save it as a highlight.</span></div>'
           : ''}`
      : `<div class="tldw-q-sheet-pending"><span class="tldw-q-sheet-spinner"></span>${escapeHTML(item.progress || 'Working on it...')}</div>`;

  return `
    <div class="tldw-q-grip" data-tldw-queue-action="close-sheet" aria-hidden="true"></div>
    <header class="tldw-q-sheet-head" style="${art}">
      <button class="tldw-q-sheet-back" type="button" data-tldw-queue-action="close-sheet" aria-label="Back to timeline">←</button>
      <div class="tldw-q-sheet-titles">
        <div class="tldw-q-sheet-title">${title}</div>
        <div class="tldw-q-sheet-meta" data-status="${escapeHTML(item.status || 'queued')}">
          <span class="tldw-q-node" aria-hidden="true"></span>
          ${escapeHTML(getSummaryQueueStatusLabel(item))} · ${queueRelTime(ts)}
        </div>
      </div>
    </header>
    <div class="tldw-q-sheet-progress" aria-hidden="true"><span></span></div>
    <div class="tldw-q-sheet-body">${body}</div>
    <footer class="tldw-q-sheet-actions">
      ${renderQueueSheetPrimaryAction(item, id)}
      <details class="tldw-q-more">
        <summary class="tldw-q-act" title="More actions" aria-label="More actions"><span aria-hidden="true">⋯</span></summary>
        <div class="tldw-q-more-menu" role="menu">
          ${item.transcript
            ? `<button type="button" role="menuitem" data-tldw-queue-action="toggle-transcript" data-queue-id="${id}">
                 <span aria-hidden="true">☰</span> ${isQueueTranscriptOpen ? 'Hide transcript' : 'Show transcript'}</button>`
            : ''}
          ${item.summary && isObsidianExportReady()
            ? `<button type="button" role="menuitem" data-tldw-queue-action="obsidian" data-queue-id="${id}">
                 <span aria-hidden="true">✦</span> Save to Obsidian</button>`
            : ''}
          <a role="menuitem" href="${escapeHTML(item.videoUrl || '#')}" target="_blank" rel="noreferrer">
            <span aria-hidden="true">▶</span> Open on YouTube</a>
          <button type="button" role="menuitem" class="tldw-q-more-danger"
                  data-tldw-queue-action="remove" data-queue-id="${id}">
            <span aria-hidden="true">✕</span> Remove from queue</button>
        </div>
      </details>
    </footer>
  `;
}

// One prominent action: whatever the reader most likely came here to do.
function renderQueueSheetPrimaryAction(item, id) {
  if (item.status === 'error') {
    return `<button class="tldw-q-primary" type="button" data-tldw-queue-action="retry" data-queue-id="${id}">
              <span aria-hidden="true">↻</span> Retry summary</button>`;
  }

  if (!item.summary) return '<span class="tldw-q-primary-spacer"></span>';

  return `<button class="tldw-q-primary" type="button" data-tldw-queue-action="copy" data-queue-id="${id}">
            <span aria-hidden="true">⧉</span> Copy summary</button>`;
}

function matchesQueueFilter(item) {
  if (queueFilter === 'all') return true;
  if (queueFilter === 'unread') return isSummaryQueueItemUnread(item);
  if (queueFilter === 'running') return item.status !== 'done' && item.status !== 'error';
  return item.status === queueFilter;
}

function queueDayLabel(ts, startOfToday) {
  if (!ts) return 'Earlier';
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - 86400000) return 'Yesterday';
  if (ts >= startOfToday - 6 * 86400000) {
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  }
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function queueRelTime(ts) {
  if (!ts) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Relative timestamps go stale in a tab left open for hours, and a full
// re-render would drop scroll position and focus.
function startQueueTimeTicker() {
  if (queueTimeTicker) return;
  queueTimeTicker = setInterval(() => {
    document.querySelectorAll('#tldw-summary-queue-widget [data-tldw-ts]').forEach(el => {
      el.textContent = queueRelTime(Number(el.dataset.tldwTs) || 0);
    });
  }, 60000);
}

function stopQueueTimeTicker() {
  clearInterval(queueTimeTicker);
  queueTimeTicker = null;
}

// Mirrors getTimeSavedStats/formatTimeSpan/formatClock in time-saved.js;
// content scripts cannot import modules.
function summarizeTimeSavedLedger(ledger) {
  const watchSeconds = Math.max(0, Math.round(Number(ledger?.watchSeconds) || 0));
  const readSeconds = Math.max(0, Math.round(Number(ledger?.readSeconds) || 0));

  return {
    videos: Math.max(0, Math.round(Number(ledger?.count) || 0)),
    watchSeconds,
    readSeconds,
    savedSeconds: Math.max(0, watchSeconds - readSeconds)
  };
}

function formatTimeSpan(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');

  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

// Mirrors getQueueStats in summary-queue.js; content scripts cannot import it.
function getSummaryQueueStats() {
  return summaryQueue.reduce((stats, item) => {
    stats.total += 1;
    if (item.status === 'done') {
      stats.done += 1;
      if (isSummaryQueueItemUnread(item)) stats.unread += 1;
    } else if (item.status === 'error') {
      stats.error += 1;
    } else {
      stats.pending += 1;
    }
    return stats;
  }, {
    total: 0,
    pending: 0,
    done: 0,
    error: 0,
    unread: 0
  });
}

// Mirrors didQueueItemFinish in summary-queue.js.
function didSummaryQueueItemFinish(prevQueue, nextQueue) {
  const prevById = new Map(
    (Array.isArray(prevQueue) ? prevQueue : []).map(item => [item.id, item])
  );

  return (Array.isArray(nextQueue) ? nextQueue : []).some(item => {
    if (item.status !== 'done' && item.status !== 'error') return false;
    const prev = prevById.get(item.id);
    return !!prev && prev.status !== 'done' && prev.status !== 'error';
  });
}

function getSummaryQueueStatusLabel(item) {
  if (item.status === 'done') return item.cached ? 'Cached' : 'Done';
  if (item.status === 'error') return 'Failed';
  if (item.status === 'running') return 'Running';
  return 'Queued';
}

// Mirrors renderStars/getRatingLabel in summary-answer.js; content scripts
// cannot import it. The parsing itself happens in the background worker, so
// only the display helpers are duplicated here.
function answerStars(rating) {
  const value = Math.max(0, Math.min(3, Number(rating) || 0));
  if (!value) return '';
  return '★'.repeat(value) + '☆'.repeat(3 - value);
}

function answerRatingLabel(rating, videoType) {
  const asksQuestion = videoType === 'question';
  if (rating >= 3) return asksQuestion ? 'Answers it' : 'Delivers';
  if (rating === 2) return asksQuestion ? 'Partly answers it' : 'Partly delivers';
  if (rating === 1) return asksQuestion ? 'Never answers it' : "Doesn't deliver";
  return '';
}

function renderAnswerCard(answer, sourceAttrs = '') {
  if (!answer || !answer.hasHeader || !answer.lead) return '';

  const rating = Number(answer.rating) || 0;
  const label = answerRatingLabel(rating, answer.videoType);

  // The hook only survives in copy and export output; on screen the takeaway
  // itself has to carry the point.
  const verdict = rating
    ? `<span class="tldw-answer-sep" aria-hidden="true">·</span>
       <span class="tldw-answer-rating" data-rating="${rating}" role="img"
             aria-label="${escapeHTML(label)}, ${rating} out of 3">
         <span class="tldw-answer-stars" aria-hidden="true">${answerStars(rating)}</span>
         <span class="tldw-answer-rating-label">${escapeHTML(label)}</span>
       </span>`
    : '';

  return `
    <div class="tldw-answer-card">
      <div class="tldw-answer-head">
        <span class="tldw-answer-eyebrow">Core takeaway</span>
        ${verdict}
      </div>
      <div class="tldw-answer-lead" ${sourceAttrs}>${parseMarkdown(answer.lead)}</div>
    </div>
  `;
}

// Bullet bodies get a "Key points" heading; prose bodies read as continuation.
function renderBodySectionLabel(answer, body) {
  if (!answer?.hasHeader || !answer.lead || !body.trim()) return '';

  const label = /^\s*[-*]\s+/m.test(body) ? 'Key points' : 'The detail';
  return `<div class="tldw-section-label">${label}</div>`;
}

// Mirrors formatAnswerPlainText in summary-answer.js: the HOOK/RATING/LEAD
// labels are a prompt contract, not something to paste into a doc.
function summaryClipboardText(source) {
  const answer = source?.answer;
  if (!answer?.hasHeader) return source?.summary || '';

  const verdict = answer.rating
    ? `${answerStars(answer.rating)} ${answerRatingLabel(answer.rating, answer.videoType)}`
    : '';

  return [answer.hook, verdict, answer.lead, answer.body]
    .filter(Boolean)
    .join('\n\n');
}

function renderAnswerBadge(answer) {
  const rating = Number(answer?.rating) || 0;
  if (!rating) return '';

  const label = answerRatingLabel(rating, answer.videoType);
  return `<span class="tldw-q-row-rating" data-rating="${rating}" title="${escapeHTML(label)}"
                aria-label="${escapeHTML(label)}">${answerStars(rating)}</span>`;
}

/**
 * Lightweight Inline Markdown to HTML Parser
 */
function parseMarkdown(md) {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bold & Italic
  html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.*?)_/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Parse lines & lists
  const lines = html.split('\n');
  let inList = false;
  const resultLines = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
      if (!inList) {
        resultLines.push('<ul>');
        inList = true;
      }
      resultLines.push('<li>' + trimmed.replace(/^[-*•]\s+/, '') + '</li>');
    } else {
      if (inList) {
        resultLines.push('</ul>');
        inList = false;
      }
      if (trimmed.length > 0) {
        resultLines.push('<p>' + line + '</p>');
      }
    }
  }
  if (inList) resultLines.push('</ul>');

  return resultLines.join('');
}

/**
 * Helpers
 */
function extractVideoId(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.searchParams.has('v')) {
      return parsed.searchParams.get('v');
    }
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function getWatchVideoTitle() {
  const titleEl = document.querySelector('h1.ytd-watch-metadata, h1.title, #title h1');
  return titleEl ? titleEl.textContent.trim() : '';
}

function isArabicText(text) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text || '');
}

function escapeHTML(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
