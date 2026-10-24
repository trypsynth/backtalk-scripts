// AI reader: says an AI app's reply once the app has finished writing it.
//
// This is a port of Waypoint, an accessibility service, to a Backtalk script.
// Waypoint watched three apps with its own accessibility service and announced
// a completed reply through TalkBack. This does the same from inside Backtalk,
// so there is no second service to run.
//
// The per-app rules below are Waypoint's measured rules, kept as they were:
// Gemini's view ids, ChatGPT's "Read aloud" row, and Claude's "Copy message"
// row. Each is an implementation detail of that app and may break in a future
// release. The Log on this script's page says what it pulled out of the
// screen, so a break can be told apart from a quiet conversation.

export const manifest = {
  id: "ai-reader",
  name: "AI reader",
  version: "1.6",
  author: "Devin Prater",
  description:
    "Says a reply when an AI app finishes writing it, including any code blocks. A port of Waypoint.",
  apps: ["com.google.android.googlequicksearchbox", "com.openai.chatgpt", "com.anthropic.claude"],
  permissions: ["screen", "speech"],
  settings: [
    {
      key: "starting",
      type: "switch",
      title: "Say Generating when a reply starts",
      default: true,
    },
    {
      key: "quiet",
      type: "number",
      title: "Seconds of quiet before reading a reply",
      summary: "A reply is read once the screen has stopped changing for this long. 1 to 10.",
      default: 3,
    },
    {
      key: "code",
      type: "switch",
      title: "Say Code block around code",
      default: true,
    },
    {
      key: "interrupt",
      type: "switch",
      title: "Cut off other speech to read a reply",
      default: false,
    },
  ],
};

const GEMINI = "com.google.android.googlequicksearchbox";
const CHATGPT = "com.openai.chatgpt";
const CLAUDE = "com.anthropic.claude";
const APPS = [GEMINI, CHATGPT, CLAUDE];
const NAMES = {};
NAMES[GEMINI] = "Gemini";
NAMES[CHATGPT] = "ChatGPT";
NAMES[CLAUDE] = "Claude";

const CODE_START = "Code block:";
const CODE_END = "Code block end.";

const CHECK_DELAY_MS = 250; // The screen changes in bursts; look once a burst.
const RETRY_MS = 1000; // A reply can pause; look again this much later.
const MAX_RETRIES = 15; // Give up on one stream after this many pauses.
const MAX_ERRORS_LOGGED = 3;
const BASELINE_MS = 1500; // How long the reply on screen counts as already read.

let pendingText = ""; // The newest reply we have seen on screen.
let spokenText = ""; // The last reply we read out.
let generating = false;
let baselined = false; // Whether we have noted the reply already on screen.
let baselineUntil = 0; // When to stop taking what is on screen as already read.
let baselineTimer = null; // The look taken when that wait is over.
let scheduled = null;
let quiet = null;
let retries = 0;
let errorsLogged = 0;
let changes = 0;
let sawWriting = false; // Whether this reply was already being written when we looked.

// ---------------------------------------------------------------------------
// Helpers over Backtalk's items.
// ---------------------------------------------------------------------------

function clean(value) {
  return value == null
    ? ""
    : String(value)
        .replace(/[\t ]+/g, " ")
        .trim();
}

function descOf(item) {
  return clean(item.contentDescription);
}

function idOf(item) {
  return item.id == null ? "" : String(item.id);
}

function kidsOf(item) {
  const kids = item.children;
  return kids == null ? [] : kids;
}

/** The text of every item with no children, in reading order. */
function leafTexts(item, out) {
  const parts = out || [];
  if (!item) return parts;
  const kids = kidsOf(item);
  if (kids.length === 0) {
    const text = clean(item.text);
    if (text) parts.push(text);
    return parts;
  }
  for (const kid of kids) leafTexts(kid, parts);
  return parts;
}

/** Whether any item at or inside this one has exactly this text. */
function hasText(item, wanted) {
  return leafTexts(item, []).includes(wanted);
}

/** Whether this item or anything inside it is described as `wanted`. */
function hasDesc(item, wanted) {
  if (!item) return false;
  if (descOf(item) === wanted) return true;
  for (const kid of kidsOf(item)) if (hasDesc(kid, wanted)) return true;
  return false;
}

function find(query, limit) {
  try {
    return backtalk.screen.findAll(query, limit) || [];
  } catch (error) {
    noteError(error);
    return [];
  }
}

function newest(items) {
  return items.length === 0 ? null : items[items.length - 1];
}

function noteError(error) {
  if (errorsLogged++ < MAX_ERRORS_LOGGED) {
  }
}

// ---------------------------------------------------------------------------
// Is a reply being written right now? These are Waypoint's signals.
// ---------------------------------------------------------------------------

function isGenerating(root, kind) {
  if (kind === CHATGPT) {
    return hasDesc(root, "Stop") || hasText(root, "Thinking");
  }
  if (kind === CLAUDE) {
    return (
      hasDesc(root, "Stop responding") ||
      hasDesc(root, "Claude is thinking") ||
      hasText(root, "Sending…")
    );
  }
  return (
    find({ id: "assistant_robin_stop_icon_button_compose" }, 1).length > 0 ||
    hasDesc(root, "Stop generating response")
  );
}

// ---------------------------------------------------------------------------
// The newest reply, per app.
// ---------------------------------------------------------------------------

function latestResponse(root, kind) {
  if (kind === CHATGPT) return chatGptResponse();
  if (kind === CLAUDE) return claudeResponse();
  return geminiResponse();
}

// Gemini ---------------------------------------------------------------------

function geminiResponse() {
  const message = newest(find({ id: "assistant_robin_message_content" }, 200));
  if (!message) return "";
  const parts = [];
  appendGemini(message, parts);
  return joinParts(parts);
}

function appendGemini(item, parts) {
  const id = idOf(item);
  if (id.endsWith("assistant_robin_code_block")) {
    const impl = item.find({ id: "assistant_robin_code_impl" });
    const code = impl ? clean(impl.text) : "";
    if (code) parts.push(asCode(code));
    return;
  }
  if (id.endsWith("assistant_robin_text")) {
    const prose = clean(item.text);
    if (prose) parts.push(asProse(prose));
    return;
  }
  for (const kid of kidsOf(item)) appendGemini(kid, parts);
}

// ChatGPT --------------------------------------------------------------------

function chatGptResponse() {
  const anchor = newest(find({ contentDescription: "Read aloud" }, 200));
  if (!anchor) return "";

  // The anchor sits in an action row next to the answer. Walk up to the item
  // that holds the answer's text, keeping the branch we came from.
  let branch = anchor;
  let message = branch.parent;
  while (message && leafTexts(message, []).length === 0) {
    branch = message;
    message = message.parent;
  }
  if (!message) return "";

  let content = null;
  for (const kid of kidsOf(message)) {
    if (kid && !kid.equals(branch) && leafTexts(kid, []).length > 0) {
      content = kid;
      break;
    }
  }
  if (!content) return "";

  const parts = [];
  appendChatGpt(content, content, parts);
  if (isCardTitle(parts)) parts.shift();
  return joinParts(parts);
}

/**
 * Whether the first part is a writing card's title rather than the answer.
 *
 * A card puts a short topic before the answer. Waypoint dropped any short
 * first part, which could take the opening of a reply with it, and its guard
 * against code blocks never fired here because a code part is the markers and
 * the code in one string. So: only prose, never code, and only a fragment
 * rather than a sentence. A whole sentence at the top of a reply is kept even
 * when it is short, since losing the opening of a reply is worse than reading
 * a topic line twice.
 */
function isCardTitle(parts) {
  if (parts.length < 2) return false;
  const first = parts[0];
  const next = parts[1];
  if (first.code || next.code) return false;
  if (/[.!?:]$/.test(first.text)) return false;
  return first.text.length <= 80 && next.text.length > first.text.length * 2;
}

function appendChatGpt(item, boundary, parts) {
  const code = chatGptCode(item);
  if (code !== null) {
    parts.push(asCode(code));
    return;
  }
  const kids = kidsOf(item);
  if (kids.length === 0) {
    if (isSuggestion(item, boundary)) return;
    const text = clean(item.text);
    // Every leaf in reading order: a reply may repeat a paragraph or a list
    // entry on purpose, and those repeats are part of what it says.
    if (text) parts.push(asProse(text));
    return;
  }
  for (const kid of kids) appendChatGpt(kid, boundary, parts);
}

/**
 * The code of a code widget, or null when this item is not one.
 *
 * Measured on ChatGPT's screen: the code text and the Copy code control are
 * brothers inside one wrapper, and the header carrying the language name sits
 * between the control and that wrapper. So the wrapper is found by walking up
 * from the control to the first item that also holds text, then taking the
 * other side of its parent. The language name is left out; Waypoint read the
 * code alone.
 */
function chatGptCode(item) {
  const control = item.find ? item.find({ contentDescription: "Copy code" }) : null;
  if (!control) return null;
  let header = control;
  while (header && leafTexts(header, []).length === 0) header = header.parent;
  if (!header) return null;
  const container = header.parent;
  if (!container || !container.equals(item)) return null;
  const code = [];
  for (const kid of kidsOf(container)) {
    if (!kid || kid.equals(header)) continue;
    // Every line in order, repeats included: code repeats lines, such as two
    // closing braces, or the same call in two branches.
    for (const text of leafTexts(kid, [])) code.push(text);
  }
  return code.length > 0 ? code.join("\n") : null;
}

/** Follow-up suggestions are clickable text sitting in a group of them. */
function isSuggestion(textItem, boundary) {
  let item = textItem.parent;
  while (item && !item.equals(boundary)) {
    if (item.clickable) {
      const parent = item.parent;
      return !!parent && leafTexts(parent, []).length > 1;
    }
    item = item.parent;
  }
  return false;
}

// Claude ---------------------------------------------------------------------

function claudeResponse() {
  let message = newest(find({ contentDescription: "Copy message" }, 200));
  if (!message) return "";

  while (message) {
    const kids = kidsOf(message);
    for (let index = kids.length - 1; index >= 1; index--) {
      const actions = kids[index];
      if (!actions || !hasDesc(actions, "Copy message")) continue;

      // Claude puts the prompt and the answer in the same item, ahead of the
      // actions. The prompt is long-clickable and holds text, so the answer
      // starts after the last of those.
      let start = 0;
      for (let i = 0; i < index; i++) {
        const kid = kids[i];
        if (kid && kid.longClickable && leafTexts(kid, []).length > 0) start = i + 1;
      }

      const parts = [];
      for (let i = start; i < index; i++) {
        const kid = kids[i];
        if (kid) appendClaude(kid, parts);
      }
      if (parts.length > 0) return joinParts(parts);
    }
    message = message.parent;
  }
  return "";
}

function appendClaude(item, parts) {
  if (isClaudeCode(item)) {
    const code = [];
    for (const kid of kidsOf(item)) {
      if (!kid || hasDesc(kid, "Copy code")) continue;
      for (const text of leafTexts(kid, [])) code.push(text);
    }
    if (code.length > 0) parts.push(asCode(code.join("\n")));
    return;
  }
  const kids = kidsOf(item);
  if (kids.length === 0) {
    const text = clean(item.text);
    if (text) parts.push(asProse(text));
    return;
  }
  for (const kid of kids) appendClaude(kid, parts);
}

function isClaudeCode(item) {
  let header = false;
  let code = false;
  for (const kid of kidsOf(item)) {
    if (!kid) continue;
    if (hasDesc(kid, "Copy code") && hasDesc(kid, "Expand code")) header = true;
    else if (leafTexts(kid, []).length > 0) code = true;
  }
  if (!header || !code) return false;
  for (const kid of kidsOf(item)) if (kid && isClaudeCode(kid)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reading a reply out.
// ---------------------------------------------------------------------------

function setting(key, fallback) {
  const value = backtalk.settings.get(key);
  return value === undefined || value === null ? fallback : value;
}

function codeBlock(code) {
  if (setting("code", true) === false) return code;
  return CODE_START + "\n" + code + "\n" + CODE_END;
}

/** A part of a reply: prose, or code with its markers. */
function asProse(text) {
  return { text: text, code: false };
}

function asCode(code) {
  return { text: codeBlock(code), code: true };
}

function joinParts(parts) {
  return parts
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function quietSeconds() {
  const value = Number(setting("quiet", 3));
  if (!isFinite(value) || value < 1) return 3;
  return Math.min(Math.round(value), 10);
}

function say(text, interrupt) {
  backtalk.speak(text, { interrupt: !!interrupt });
}

function speakGenerating() {
  if (setting("starting", true) === false) return;
  const packageName = backtalk.app.package;
  say("Generating", false);
}

/** Read the newest reply, if it is new and the app has stopped writing. */
function finish() {
  quiet = null;
  const packageName = backtalk.app.package;
  if (!APPS.includes(packageName)) return;
  let root;
  try {
    root = backtalk.screen.root();
  } catch (error) {
    noteError(error);
    return;
  }
  if (!root) return;
  if (isGenerating(root, packageName)) {
    if (retries++ < MAX_RETRIES) {
      quiet = setTimeout(finish, RETRY_MS);
    } else {
    }
    return;
  }
  retries = 0;
  if (!pendingText) {
    return;
  }
  if (pendingText === spokenText) {
    return;
  }
  spokenText = pendingText;
  say(pendingText, setting("interrupt", false) === true);
}

function check() {
  scheduled = null;
  const packageName = backtalk.app.package;
  if (!APPS.includes(packageName)) return;
  let root;
  try {
    root = backtalk.screen.root();
  } catch (error) {
    noteError(error);
    return;
  }
  if (!root) return;

  const writing = isGenerating(root, packageName);
  const wasWriting = generating;
  if (writing && !generating) speakGenerating();
  generating = writing;
  if (writing) sawWriting = true;

  const text = latestResponse(root, packageName);

  if (!baselined) {
    // Whatever reply is already on screen was read last session, or was never
    // asked for. Only a change from here on is news. An app can still be
    // drawing when the script loads, so this takes the reply as it settles,
    // then stops: a reply that arrives after this point is news.
    // A reply the app was already writing when the script loaded is not old
    // news: it is this reply, and the script commonly loads in the middle of
    // one. It is left unspoken so that its ending reads it, even if the text
    // never changes again.
    if (text) {
      pendingText = text;
      if (!writing && !sawWriting) spokenText = text;
    }
    if (Date.now() < baselineUntil - 50) return; // The screen is still settling.
    baselined = true;
    if (text && text !== spokenText && sawWriting) arm();
    return;
  }

  // The app stopping writing is itself news: a reply that arrived complete
  // while it streamed never changes the text again, so nothing else arms.
  if (wasWriting && !writing && text && text !== spokenText) {
    pendingText = text;
    arm();
    return;
  }

  if (!text) return;

  if (text === pendingText) return;
  pendingText = text;
  arm();
}

/** Start the wait for the app to stop changing the screen. */
function arm() {
  if (quiet) clearTimeout(quiet);
  quiet = setTimeout(finish, quietSeconds() * 1000);
}

function schedule() {
  if (scheduled) return;
  scheduled = setTimeout(check, CHECK_DELAY_MS);
}

function reset() {
  pendingText = "";
  spokenText = "";
  generating = false;
  baselined = false;
  retries = 0;
  changes = 0;
  sawWriting = false;
  if (scheduled) clearTimeout(scheduled);
  if (quiet) clearTimeout(quiet);
  if (baselineTimer) clearTimeout(baselineTimer);
  scheduled = null;
  quiet = null;
  baselineUntil = Date.now() + BASELINE_MS;
  baselineTimer = setTimeout(check, BASELINE_MS + 100);
}

backtalk.onContentChange((event) => {
  // Another app's window can change while this one is in front, such as a
  // keyboard. Only a change in an app this script reads is worth a look.
  if (!event || !APPS.includes(event.package)) return;
  changes++;
  if (changes === 1 || changes % 100 === 0) {
  }
  schedule();
});

backtalk.onAppEnter((app) => {
  // A script with apps loads when one of them comes to the front.
  reset();
  schedule();
});

backtalk.onAppLeave(() => reset());
