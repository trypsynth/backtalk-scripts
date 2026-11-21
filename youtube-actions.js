export const manifest = {
  id: "youtube-actions",
  name: "YouTube video actions",
  version: "1.5.1",
  author: "Aryan Choudhary",
  description:
    "Skips the buttons inside each video, mix, playlist and game in YouTube lists, " +
    "and the edit button of each search suggestion, and puts them in its Actions menu instead.",
  apps: ["com.google.android.youtube"],
  permissions: ["screen", "actions", "speech", "input"],
  rules: [
    { match: { className: "Button", inside: { clickable: true, textContains: "play video" } }, hide: true },
    { match: { className: "Button", inside: { clickable: true, textContains: "play Short" } }, hide: true },
    // A game in YouTube Playables.
    { match: { className: "Button", inside: { clickable: true, textContains: "play Playable" } }, hide: true },
    { match: { className: "Button", inside: { clickable: true, textContains: "Mix - " } }, hide: true },
    // A playlist in History has no name of its own, so its menu is told by being inside something to press.
    {
      match: {
        className: "Button",
        contentDescription: "Action menu",
        inside: { className: "Button", clickable: true },
      },
      hide: true,
    },
    // A video in History.
    { id: "contextual_menu_anchor", hide: true },
    // The button that copies a search suggestion into the search box.
    { id: "edit_suggestion", hide: true },
    // In the home feed from November 2026, a video's channel, views, age and buttons sit next to it
    // in its row of the list, not inside it. The video's own label already says the channel, views
    // and age, so they're skipped, and the buttons go in its Actions menu.
    { match: { className: "Button", textContains: "Go to channel", inside: { parentId: "results" } }, hide: true },
    { match: { className: "Button", contentDescription: "Like this video", inside: { parentId: "results" } }, hide: true },
    { match: { className: "Button", contentDescription: "Comments", inside: { parentId: "results" } }, hide: true },
    { match: { className: "Button", contentDescription: "Save to playlist", inside: { parentId: "results" } }, hide: true },
    { match: { className: "Button", textContains: "Action menu for", inside: { parentId: "results" } }, hide: true },
    // ".View" is android.view.View only, not TextView or ImageView.
    { match: { className: ".View", clickable: false, textContains: "@", inside: { parentId: "results" } }, hide: true },
    { match: { className: ".View", clickable: false, textContains: " views", inside: { parentId: "results" } }, hide: true },
    { match: { className: ".View", clickable: false, textContains: " watching", inside: { parentId: "results" } }, hide: true },
    { match: { className: ".View", clickable: false, textContains: " ago", inside: { parentId: "results" } }, hide: true },
    // An empty spacer between the videos under the one playing. It has nothing to match it by but its
    // class, which is YouTube's minified name, so this may need changing after a YouTube update.
    { match: { className: "yek", clickable: false, parentId: "watch_list" }, hide: true },
  ],
};

const MAX_BUTTONS = 8;

const isVideo = (item) => item.clickable && /play (video|short|playable)|^mix - /i.test(item.contentDescription || "");

// "Action menu for <video title>" repeats the title the user just heard.
const title = (label) => (label.startsWith("Action menu for") ? "Action menu" : label.replace(/[.:]+$/, ""));

backtalk.onActions((item) => {
  // A search suggestion. Its label would repeat the suggestion the user just heard.
  const edit = item.clickable && item.find({ id: "edit_suggestion" });
  if (edit) return [{ title: "Edit suggestion", run: () => edit.click() }];
  if ((item.id || "").endsWith("video_info_view")) {
    const menu = item.find({ id: "contextual_menu_anchor" });
    return menu ? [{ title: "Action menu", run: () => menu.click() }] : undefined;
  }
  if (!item.clickable || !(isVideo(item) || item.className.endsWith("Button"))) return;
  // In the newer home feed, the buttons are next to the video in its row rather than inside it.
  const row = item.parent;
  const scope =
    isVideo(item) && item.childCount === 0 && row && (row.parent?.id || "").endsWith("results") ? row : item;
  return scope
    .findAll({ className: "Button" }, MAX_BUTTONS)
    .filter((button) => button.contentDescription && !button.equals(item) && !isVideo(button))
    .map((button) => ({ title: title(button.contentDescription), run: () => button.click() }));
});
