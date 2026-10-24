export const manifest = {
  id: "play-store-actions",
  name: "Play Store row actions",
  version: "1.1",
  author: "Aryan Choudhary",
  description:
    "Skips the buttons inside each row in Play Store lists, such as Update and Expand in Manage apps, " +
    "and puts them in the row's Actions menu instead.",
  apps: ["com.android.vending"],
  permissions: ["screen", "actions", "speech", "input"],
  // Only these two kinds are hidden: the account button wraps an old-style view that holds its name.
  rules: [
    {
      match: {
        clickable: true,
        className: "android.view.View",
        inside: { clickable: true, className: "android.view.View" },
      },
      hide: "all",
    },
    {
      match: {
        clickable: true,
        className: "android.widget.ImageView",
        inside: { clickable: true, className: "android.view.View" },
      },
      hide: "all",
    },
  ],
};

const MAX_BUTTONS = 8;
const BUTTON_CLASSES = ["android.view.View", "android.widget.ImageView"];
const LABEL_DEPTH = 3;

// The Update button has no name of its own; the name is on an item inside it.
const labelOf = (item, depth = LABEL_DEPTH) => {
  const own = item.contentDescription || item.text;
  if (own || depth === 0) return own || "";
  for (const child of item.children) {
    const label = labelOf(child, depth - 1);
    if (label) return label;
  }
  return "";
};

backtalk.onActions((item) => {
  if (!item.clickable || item.className !== "android.view.View") return;
  const actions = [];
  for (const button of item.findAll({ clickable: true }, MAX_BUTTONS)) {
    if (button.equals(item) || !BUTTON_CLASSES.includes(button.className)) continue;
    const title = labelOf(button).trim();
    if (title) actions.push({ title, run: () => button.click() });
  }
  return actions;
});
