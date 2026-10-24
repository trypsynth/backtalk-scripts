export const manifest = {
  id: "youtube-actions",
  name: "YouTube video actions",
  version: "1.4.1",
  author: "Aryan Choudhary",
  description:
    "Skips the buttons inside each video, mix and playlist in YouTube lists, " +
    "and puts them in its Actions menu instead.",
  apps: ["com.google.android.youtube"],
  permissions: ["screen", "actions", "speech", "input"],
  rules: [
    { match: { className: "Button", inside: { clickable: true, textContains: "play video" } }, hide: true },
    { match: { className: "Button", inside: { clickable: true, textContains: "play Short" } }, hide: true },
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
  ],
};

const MAX_BUTTONS = 8;

const isVideo = (item) => item.clickable && /play (video|short)|^mix - /i.test(item.contentDescription || "");

// "Action menu for <video title>" repeats the title the user just heard.
const title = (label) => (label.startsWith("Action menu for") ? "Action menu" : label.replace(/[.:]+$/, ""));

backtalk.onActions((item) => {
  if ((item.id || "").endsWith("video_info_view")) {
    const menu = item.find({ id: "contextual_menu_anchor" });
    return menu ? [{ title: "Action menu", run: () => menu.click() }] : undefined;
  }
  if (!item.clickable || !(isVideo(item) || item.className.endsWith("Button"))) return;
  return item
    .findAll({ className: "Button" }, MAX_BUTTONS)
    .filter((button) => button.contentDescription && !button.equals(item) && !isVideo(button))
    .map((button) => ({ title: title(button.contentDescription), run: () => button.click() }));
});
