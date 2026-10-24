export const manifest = {
  id: "whatsapp-messages",
  name: "WhatsApp messages",
  version: "1.1",
  author: "Aaron Hewitt",
  description:
    "Reads each message in a WhatsApp chat as one item: sender, content, the message it replies to, and time. " +
    "Play, playback speed and the other buttons in a message are in its Actions menu.",
  apps: [
    { package: "com.whatsapp", activity: "Conversation" },
    { package: "com.whatsapp.w4b", activity: "Conversation" },
  ],
  permissions: ["screen", "actions", "speech", "input"],
  settings: [{ key: "expandLong", type: "switch", title: "Expand long messages", default: true }],
  rules: [
    { match: { parentId: "list", className: "ViewGroup" }, group: true },
    {
      match: { clickable: true, inside: { parentId: "list", className: "ViewGroup" } },
      hide: "all",
    },
    {
      match: { className: "SeekBar", inside: { parentId: "list", className: "ViewGroup" } },
      hide: true,
    },
  ],
};

const MAX_BUTTONS = 24;
const MAX_OPTIONS = 20;
const LABEL_DEPTH = 3;

const shortId = (item) => (item.id || "").split("/").pop();
const isRow = (item) => shortId(item).startsWith("conversation_row_") && /\/list$/.test((item.parent || {}).id || "");

// Removes the direction marks WhatsApp adds, and the "~" before a name the contact list doesn't have.
const clean = (text) =>
  (text || "")
    .replace(/[​-‏‪-‮]/g, "")
    .replace(/^~\s*/, "")
    .trim();

const textOf = (item, id) => {
  const found = item.find(id);
  return found ? clean(found.text) : "";
};

const mainOf = (row) => row.find("main_layout") || row.find("polls_main_layout");

// Sent messages have a delivery status and sit against the right edge.
const isOutgoing = (row) => {
  if (row.find("status")) return true;
  const main = mainOf(row);
  return !!main && row.bounds.right - main.bounds.right < main.bounds.left - row.bounds.left;
};

// In a chat with one person, the messages from them have no name and no picture.
const contactName = (row) => {
  const list = row.parent;
  const senderIds = ["name_in_group_tv", "group_profile_pic", "group_profile_initials"];
  const isGroup = !list || senderIds.some((id) => list.find(id));
  const title = isGroup ? null : backtalk.screen.find("conversation_contact_name");
  return title ? clean(title.text) : "";
};

// "Alex Smith, voice message, 54 seconds, 09:11" has the sender first, and the time and "played" last.
// A sound file reads "audio message" instead, and its row also shows the file name.
const voiceOf = (row) => {
  const main = row.find("main_layout");
  const description = (main && main.contentDescription) || "";
  const at = description.search(/, (voice|audio) message/);
  if (at < 0) return null;
  const rest = description.slice(at + 2);
  const file = shortId(row) === "conversation_row_audio" ? textOf(row, "description") : "";
  const match = rest.match(/^(.*?),\s*(\d{1,2}:\d{2}(?:\s?[ap]m)?)(?:,\s*(.*))?$/i);
  return {
    sender: clean(description.slice(0, at)),
    body: [match ? match[1] : rest, file].filter(Boolean).join(", "),
    time: match ? match[2] : "",
    state: match && match[3] ? match[3] : "",
  };
};

// "Poll from Alex Smith, next event.\nSelect one or more\n..."; each option reads "Name, 2 votes".
const pollOf = (row) => {
  const main = row.find("polls_main_layout");
  if (!main) return null;
  const name = textOf(row, "poll_name");
  const description = main.contentDescription || "";
  const end = description.indexOf(`, ${name}.`);
  const options = row.findAll({ id: "poll_option_main_layout" }, MAX_OPTIONS).map((option) => {
    const label = clean(option.contentDescription);
    return option.checked ? `${backtalk._("selected")} ${label}` : label;
  });
  return {
    sender: description.startsWith("Poll from ") && end > 0 ? clean(description.slice("Poll from ".length, end)) : "",
    body: [`${backtalk._("poll")}: ${name}`, textOf(row, "poll_type_text"), ...options].filter(Boolean).join(". "),
  };
};

// A message from the same sender as the one before it has no name of its own.
const senderOf = (row, depth = 3) => {
  const named = textOf(row, "name_in_group_tv");
  if (named) return named;
  const known = (voiceOf(row) || pollOf(row) || {}).sender;
  if (known) return known;
  if (isOutgoing(row)) return backtalk._("You");
  const siblings = row.parent ? row.parent.children : [];
  const index = siblings.findIndex((sibling) => sibling.equals(row));
  const previous = depth > 0 && index > 0 ? siblings[index - 1] : null;
  return (previous && !isOutgoing(previous) && senderOf(previous, depth - 1)) || contactName(row);
};

// "Voice message, 2 minutes, 33 seconds elapsed"; "0 seconds elapsed" before it has played.
const elapsedOf = (row) => {
  const seekBar = row.find("audio_seekbar");
  const match = seekBar && (seekBar.contentDescription || "").match(/^Voice message, (.*) elapsed$/);
  return match && !/^0 seconds$/.test(match[1]) ? `${match[1]} ${backtalk._("elapsed")}` : "";
};

const labelOf = (item, depth = LABEL_DEPTH) => {
  const own = clean(item.contentDescription || item.text);
  if (own || depth === 0) return own;
  for (const child of item.children) {
    const label = labelOf(child, depth - 1);
    if (label) return label;
  }
  return "";
};

const documentOf = (row) => {
  if (shortId(row) !== "conversation_row_document") return "";
  const content = row.find("content");
  return `${backtalk._("document")}: ${content ? labelOf(content) : ""}`.replace(/: $/, "");
};

// "Enlarge photo", or "Photo 331 kB" before it is downloaded.
const photoOf = (row) => {
  if (shortId(row) !== "conversation_row_image") return "";
  const image = row.find("image");
  const label = clean(image && image.contentDescription);
  return /^enlarge photo$/i.test(label) || !label ? backtalk._("photo") : label.replace(/^photo/i, backtalk._("photo"));
};

// The frame around a quoted message is an empty layout, so screen readers don't see it; its texts are still there.
const replyOf = (row) => {
  const author = textOf(row, "quoted_title");
  const quoted = textOf(row, "quoted_text");
  if (!author && !quoted) return "";
  return [`${backtalk._("in reply to")} ${author}`.trim(), quoted].filter(Boolean).join(": ");
};

// A link's preview repeats the link; only a title that isn't the address is worth saying.
const previewOf = (row) => {
  const title = textOf(row, "title");
  if (!title || /^(https?:\/\/|www\.)/.test(title)) return "";
  return `${backtalk._(row.find("play_button") ? "video link" : "link")}: ${title}`;
};

// The bubble shows up to three kinds of reaction and how many there are in all, not how many of each.
// "reaction 👍", "reactions, 3 👍", or "reactions, 🤣, 😂, 😢, 5 in total".
const reactionsOf = (row) => {
  const bubble = row.find("reactions_bubble_layout");
  if (!bubble) return "";
  const kinds = bubble
    .findAll({ id: "reaction_bubble_emoji_text" }, 8)
    .map((reaction) => clean(reaction.text))
    .filter(Boolean);
  if (!kinds.length) return "";
  const count = bubble.findAll({ className: "TextView" }, 12).find((item) => /^\d+$/.test(clean(item.text)));
  const total = count ? Number(clean(count.text)) : kinds.length;
  if (total === 1) return `${backtalk._("reaction")} ${kinds[0]}`;
  if (kinds.length === 1) return `${backtalk._("reactions")}, ${total} ${kinds[0]}`;
  return [backtalk._("reactions"), ...kinds, backtalk._("{count} in total", { count: total })].join(", ");
};

const describe = (row) => {
  const voice = voiceOf(row);
  const poll = pollOf(row);
  const text = textOf(row, "message_text") || textOf(row, "caption");
  const content = voice ? voice.body : poll ? poll.body : [documentOf(row) || photoOf(row), text];
  const notices = row.findAll({ id: "info" }, 5).map((info) => clean(info.text));
  const body = [].concat(content).filter(Boolean).join(", ");
  if (!body) return notices.length ? notices.join(", ") : undefined;
  const status = row.find("status");
  const time = voice ? voice.time : textOf(row, "date");
  const state = voice && voice.state ? voice.state : status && status.contentDescription;
  const parts = [
    senderOf(row),
    body,
    voice && elapsedOf(row),
    row.find("edit_label") && backtalk._("edited"),
    previewOf(row),
    replyOf(row),
    reactionsOf(row),
    [time, state, textOf(row, "conversation_row_date_divider")].filter(Boolean).join(", "),
    ...notices,
  ];
  return parts.filter(Boolean).join(", ");
};

const READ_MORE = { contentDescription: "Read more" };
const EXPAND_ATTEMPTS = 4;
const EXPAND_DELAY = 250;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// WhatsApp cuts a long message off in the screen's text, so open it and say the whole message.
const expand = async (row, readMore) => {
  await readMore.click();
  let current = row;
  for (let attempt = 0; attempt < EXPAND_ATTEMPTS; attempt++) {
    await wait(EXPAND_DELAY);
    current = row.refresh() || current;
    if (!current.find(READ_MORE)) break;
  }
  const text = describe(current);
  if (text) backtalk.speak(text, { interrupt: true });
};

backtalk.onFocus((item) => {
  if (!isRow(item)) return;
  const readMore = backtalk.settings.get("expandLong") !== false && item.find(READ_MORE);
  if (!readMore) return describe(item);
  expand(item, readMore);
  return false;
});

const titleOf = (button) => {
  switch (shortId(button)) {
    case "bubble_quoted_message_frame":
      return backtalk._("Go to replied message");
    case "reactions_bubble_layout":
      return backtalk._("View reactions");
    case "link_preview_frame":
      return backtalk._("Open link");
    case "poll_option_main_layout":
      return `${backtalk._("Vote")}: ${labelOf(button)}`;
    case "polls_main_layout":
    case "image":
      return /^enlarge photo$/i.test(labelOf(button)) ? labelOf(button) : "";
    case "control_btn":
      return button.className.endsWith("ImageButton") ? labelOf(button) : backtalk._("Download");
    case "name_in_group":
    case "contact_photo_view":
    case "url_layout":
    case "poll_option_vote_checkbox":
    case "info":
      return "";
  }
  const label = labelOf(button);
  return /^https?:\/\//.test(label) ? backtalk._("Open link") : label;
};

backtalk.onActions((item) => {
  if (!isRow(item)) return;
  const actions = [];
  for (const button of item.findAll({ clickable: true }, MAX_BUTTONS)) {
    if (button.equals(item) || button.find("group_profile_initials") || button.find("group_profile_pic")) continue;
    const title = titleOf(button);
    if (title && !actions.some((action) => action.title === title)) actions.push({ title, run: () => button.click() });
  }
  return actions;
});
